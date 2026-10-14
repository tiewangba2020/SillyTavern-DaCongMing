/**
 * SQLite 权威存储适配器（node:sqlite）。
 *
 * - WAL 模式、显式事务、schema 版本迁移、备份与恢复。
 * - records 表按 (collection, id) 存 JSON 文档；meta 表存键值。
 * - 迁移失败时抛出 MigrationError，由服务进入“需要处理”状态并给出修复动作，
 *   不删除任何既有数据。
 */

import fs from 'node:fs';
import path from 'node:path';

export class MigrationError extends Error {
    constructor(message, { version, cause } = {}) {
        super(message);
        this.name = 'MigrationError';
        this.version = version;
        this.cause = cause;
    }
}

const MIGRATIONS = [
    {
        version: 1,
        description: '初始 schema：records / meta / migrations',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS records (
                    collection TEXT NOT NULL,
                    id TEXT NOT NULL,
                    json TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (collection, id)
                );
            `);
            db.exec('CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);');
            db.exec(`
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT,
                    applied_at TEXT NOT NULL
                );
            `);
        },
    },
];

export class SqliteAdapter {
    kind = 'sqlite';

    constructor({ file, logger } = {}) {
        this.file = file;
        this.logger = logger ?? null;
        this.db = null;
        this.seq = 0;
        this._txDepth = 0;
        this._pending = [];
        this.migrationInfo = { current: 0, target: MIGRATIONS[MIGRATIONS.length - 1].version };
    }

    async init() {
        const { DatabaseSync } = await import('node:sqlite');
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.db = new DatabaseSync(this.file);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.#runMigrations();
        this.#loadSeq();
        return this;
    }

    #runMigrations() {
        // schema_migrations 可能尚不存在（首次运行），先探测
        let applied = [];
        try {
            applied = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
                .map((row) => Number(row.version));
        } catch {
            applied = [];
        }
        const appliedSet = new Set(applied);
        this.migrationInfo.current = applied.length ? Math.max(...applied) : 0;

        for (const migration of MIGRATIONS) {
            if (appliedSet.has(migration.version)) continue;
            try {
                this.db.exec('BEGIN IMMEDIATE');
                migration.up(this.db);
                this.db.prepare(
                    'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)',
                ).run(migration.version, migration.description, new Date().toISOString());
                this.db.exec('COMMIT');
                this.migrationInfo.current = migration.version;
                this.logger?.info?.('store.migration_applied', { version: migration.version });
            } catch (err) {
                try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
                throw new MigrationError(
                    `数据库迁移到版本 ${migration.version} 失败：${err.message}`,
                    { version: migration.version, cause: err },
                );
            }
        }
    }

    #loadSeq() {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('nextSeq');
        this.seq = row ? Number(row.value) : 1;
    }

    #nextSeq() {
        const current = this.seq;
        this.seq += 1;
        this.db.prepare(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run('nextSeq', String(this.seq));
        return current;
    }

    loadAll() {
        const out = new Map();
        const rows = this.db.prepare('SELECT collection, id, json FROM records').all();
        for (const row of rows) {
            if (!out.has(row.collection)) out.set(row.collection, new Map());
            out.get(row.collection).set(row.id, JSON.parse(row.json));
        }
        const metaRows = this.db.prepare('SELECT key, value FROM meta').all();
        const meta = new Map();
        for (const row of metaRows) meta.set(row.key, row.value);
        return { collections: out, meta };
    }

    put(collection, id, record) {
        this._pending.push({ op: 'put', collection, id, record });
        if (this._txDepth === 0) this.#flush();
    }

    remove(collection, id) {
        this._pending.push({ op: 'del', collection, id });
        if (this._txDepth === 0) this.#flush();
    }

    metaSet(key, value) {
        this._pending.push({ op: 'meta', key, value });
        if (this._txDepth === 0) this.#flush();
    }

    #flush() {
        if (!this._pending.length) return;
        const ops = this._pending;
        this._pending = [];
        const inTxn = this._txDepth > 0;
        if (!inTxn) this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const op of ops) {
                if (op.op === 'put') {
                    this.db.prepare(
                        `INSERT INTO records (collection, id, json, seq, updated_at)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(collection, id) DO UPDATE SET
                           json = excluded.json, seq = excluded.seq, updated_at = excluded.updated_at`,
                    ).run(op.collection, op.id, JSON.stringify(op.record), this.#nextSeq(), new Date().toISOString());
                } else if (op.op === 'del') {
                    this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(op.collection, op.id);
                } else if (op.op === 'meta') {
                    this.db.prepare(
                        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                    ).run(op.key, String(op.value));
                }
            }
            if (!inTxn) this.db.exec('COMMIT');
        } catch (err) {
            if (!inTxn) {
                try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
            }
            throw err;
        }
    }

    /** 事务：嵌套时合并进外层事务。flush 必须在深度归零前执行（仍处于事务内）。 */
    txn(fn) {
        this._txDepth += 1;
        if (this._txDepth === 1) this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            if (this._txDepth === 1) {
                this.#flush();
                this.db.exec('COMMIT');
            }
            this._txDepth -= 1;
            return result;
        } catch (err) {
            this._pending = [];
            if (this._txDepth === 1) {
                try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
            }
            this._txDepth -= 1;
            throw err;
        }
    }

    checkpoint() {
        this.#flush();
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch { /* 非致命 */ }
    }

    async backup(targetPath) {
        this.checkpoint();
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        try {
            const escaped = targetPath.replace(/'/g, "''");
            this.db.exec(`VACUUM INTO '${escaped}';`);
        } catch {
            // 回退：检查点后复制主库文件
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            fs.copyFileSync(this.file, targetPath);
        }
        return targetPath;
    }

    async restoreFrom(sourcePath) {
        if (!fs.existsSync(sourcePath)) throw new Error(`备份文件不存在：${sourcePath}`);
        this.close();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(this.file + suffix); } catch { /* ignore */ }
        }
        fs.copyFileSync(sourcePath, this.file);
        await this.init();
        return true;
    }

    stats() {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
        const byCollection = this.db
            .prepare('SELECT collection, COUNT(*) AS n FROM records GROUP BY collection')
            .all()
            .map((row) => ({ collection: row.collection, count: Number(row.n) }));
        let fileSize = 0;
        try { fileSize = fs.statSync(this.file).size; } catch { /* ignore */ }
        return {
            kind: 'sqlite',
            file: this.file,
            fileSize,
            recordCount: Number(count),
            byCollection,
            schemaVersion: this.migrationInfo.current,
        };
    }

    close() {
        if (!this.db) return;
        try { this.#flush(); } catch { /* ignore */ }
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
    }
}

export { MIGRATIONS };
