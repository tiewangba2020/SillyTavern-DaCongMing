/**
 * Append-only 日志存储适配器（降级方案）。
 *
 * 适用于缺少 node:sqlite 的运行环境：以 JSONL 追加日志为权威写入路径，
 * snapshot.json 为压缩检查点；加载时先读快照再回放日志尾部。
 * 与 SQLite 适配器实现同一接口，保证上层逻辑无感。
 */

import fs from 'node:fs';
import path from 'node:path';

export class JournalAdapter {
    kind = 'journal';

    constructor({ dir, logger } = {}) {
        this.dir = dir;
        this.logger = logger ?? null;
        this.journalFile = path.join(dir, 'journal.jsonl');
        this.snapshotFile = path.join(dir, 'snapshot.json');
        this._txDepth = 0;
        this._pending = [];
        this._fd = null;
        this.migrationInfo = { current: 1, target: 1 };
    }

    async init() {
        fs.mkdirSync(this.dir, { recursive: true });
        if (!fs.existsSync(this.journalFile)) fs.writeFileSync(this.journalFile, '', 'utf8');
        this._fd = fs.openSync(this.journalFile, 'a');
        return this;
    }

    loadAll() {
        const collections = new Map();
        const meta = new Map();
        const ensure = (name) => {
            if (!collections.has(name)) collections.set(name, new Map());
            return collections.get(name);
        };

        if (fs.existsSync(this.snapshotFile)) {
            try {
                const snap = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
                for (const [coll, records] of Object.entries(snap.collections ?? {})) {
                    const map = ensure(coll);
                    for (const [id, record] of Object.entries(records)) map.set(id, record);
                }
                for (const [key, value] of Object.entries(snap.meta ?? {})) meta.set(key, value);
            } catch (err) {
                this.logger?.error?.('store.snapshot_corrupt', { error: err.message });
            }
        }

        const raw = fs.readFileSync(this.journalFile, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            let op;
            try { op = JSON.parse(line); } catch { continue; }
            if (op.o === 'p') ensure(op.c).set(op.id, op.r);
            else if (op.o === 'd') ensure(op.c).delete(op.id);
            else if (op.o === 'm') meta.set(op.k, op.v);
        }
        return { collections, meta };
    }

    put(collection, id, record) {
        this._pending.push({ o: 'p', c: collection, id, r: record });
        if (this._txDepth === 0) this.#flush();
    }

    remove(collection, id) {
        this._pending.push({ o: 'd', c: collection, id });
        if (this._txDepth === 0) this.#flush();
    }

    metaSet(key, value) {
        this._pending.push({ o: 'm', k: key, v: value });
        if (this._txDepth === 0) this.#flush();
    }

    #flush() {
        if (!this._pending.length) return;
        const lines = this._pending.map((op) => JSON.stringify(op)).join('\n') + '\n';
        this._pending = [];
        fs.writeSync(this._fd, lines, null, 'utf8');
        try { fs.fsyncSync(this._fd); } catch { /* 非致命 */ }
    }

    txn(fn) {
        this._txDepth += 1;
        try {
            const result = fn();
            this._txDepth -= 1;
            if (this._txDepth === 0) this.#flush();
            return result;
        } catch (err) {
            this._txDepth -= 1;
            this._pending = [];
            throw err;
        }
    }

    checkpoint() {
        this.#flush();
        const { collections, meta } = this.loadAll();
        const snap = {
            version: 1,
            savedAt: new Date().toISOString(),
            collections: Object.fromEntries(
                [...collections.entries()].map(([coll, map]) => [coll, Object.fromEntries(map)]),
            ),
            meta: Object.fromEntries(meta),
        };
        const tmp = `${this.snapshotFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(snap), 'utf8');
        fs.renameSync(tmp, this.snapshotFile);
        // 清空日志（快照已包含全部状态）
        fs.closeSync(this._fd);
        fs.writeFileSync(this.journalFile, '', 'utf8');
        this._fd = fs.openSync(this.journalFile, 'a');
    }

    async backup(targetPath) {
        this.checkpoint();
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(this.snapshotFile, targetPath);
        return targetPath;
    }

    async restoreFrom(sourcePath) {
        if (!fs.existsSync(sourcePath)) throw new Error(`备份文件不存在：${sourcePath}`);
        this.close();
        fs.copyFileSync(sourcePath, this.snapshotFile);
        fs.writeFileSync(this.journalFile, '', 'utf8');
        await this.init();
        return true;
    }

    stats() {
        const { collections } = this.loadAll();
        const byCollection = [...collections.entries()].map(([collection, map]) => ({
            collection,
            count: map.size,
        }));
        let fileSize = 0;
        for (const f of [this.journalFile, this.snapshotFile]) {
            try { fileSize += fs.statSync(f).size; } catch { /* ignore */ }
        }
        return {
            kind: 'journal',
            file: this.journalFile,
            fileSize,
            recordCount: byCollection.reduce((acc, x) => acc + x.count, 0),
            byCollection,
            schemaVersion: 1,
        };
    }

    close() {
        if (!this._fd) return;
        try { this.#flush(); } catch { /* ignore */ }
        try { fs.closeSync(this._fd); } catch { /* ignore */ }
        this._fd = null;
    }
}
