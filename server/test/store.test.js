import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openAdapter } from '../src/store/adapter.js';
import { Data } from '../src/store/data.js';
import { MIGRATIONS, MigrationError } from '../src/store/sqlite-adapter.js';
import { tempDir } from './helpers.js';

async function sqliteAvailable() {
    try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(':memory:');
        db.close();
        return true;
    } catch {
        return false;
    }
}

const hasSqlite = await sqliteAvailable();

test('适配器选择：auto 模式总能得到一个可用适配器', async () => {
    const dir = tempDir();
    const adapter = await openAdapter({ dataDir: dir, kind: 'auto', dbFile: path.join(dir, 'a.sqlite'), journalDir: path.join(dir, 'j') });
    assert.ok(['sqlite', 'journal'].includes(adapter.kind));
    adapter.put('memory_records', 'x1', { id: 'x1', content: '林月' });
    adapter.checkpoint();
    const { collections } = adapter.loadAll();
    assert.equal(collections.get('memory_records').get('x1').content, '林月');
    adapter.close();
});

test('SQLite 适配器：持久化 + 重启后读取 + schema 版本', { skip: !hasSqlite }, async () => {
    const dir = tempDir();
    const dbFile = path.join(dir, 't.sqlite');
    const a1 = await openAdapter({ kind: 'sqlite', dbFile, journalDir: path.join(dir, 'j') });
    assert.equal(a1.kind, 'sqlite');
    a1.put('memory_records', 'm1', { id: 'm1', content: '霜华剑' });
    a1.metaSet('deletionEpoch:chat:test', '2');
    a1.close();

    const a2 = await openAdapter({ kind: 'sqlite', dbFile, journalDir: path.join(dir, 'j') });
    const { collections, meta } = a2.loadAll();
    assert.equal(collections.get('memory_records').get('m1').content, '霜华剑');
    assert.equal(meta.get('deletionEpoch:chat:test'), '2');
    assert.equal(a2.migrationInfo.current, MIGRATIONS[MIGRATIONS.length - 1].version);
    a2.close();
});

test('SQLite 适配器：事务回滚不留下半成品', { skip: !hasSqlite }, async () => {
    const dir = tempDir();
    const adapter = await openAdapter({ kind: 'sqlite', dbFile: path.join(dir, 't.sqlite'), journalDir: path.join(dir, 'j') });
    assert.throws(() => {
        adapter.txn(() => {
            adapter.put('memory_records', 'a', { id: 'a' });
            adapter.put('memory_records', 'b', { id: 'b' });
            throw new Error('boom');
        });
    }, /boom/);
    const { collections } = adapter.loadAll();
    assert.equal(collections.get('memory_records')?.get('a'), undefined);
    adapter.close();
});

test('SQLite 适配器：备份与恢复', { skip: !hasSqlite }, async () => {
    const dir = tempDir();
    const dbFile = path.join(dir, 't.sqlite');
    const adapter = await openAdapter({ kind: 'sqlite', dbFile, journalDir: path.join(dir, 'j') });
    adapter.put('memory_records', 'm1', { id: 'm1', content: '原始内容' });
    const backupFile = path.join(dir, 'backup.sqlite');
    await adapter.backup(backupFile);
    assert.ok(fs.existsSync(backupFile));

    adapter.put('memory_records', 'm1', { id: 'm1', content: '被破坏的内容' });
    adapter.put('memory_records', 'm2', { id: 'm2', content: '多余记录' });
    await adapter.restoreFrom(backupFile);

    const { collections } = adapter.loadAll();
    assert.equal(collections.get('memory_records').get('m1').content, '原始内容');
    assert.equal(collections.get('memory_records').get('m2'), undefined);
    adapter.close();
});

test('Journal 适配器：append-only + 快照压缩 + 备份恢复', async () => {
    const dir = tempDir();
    const adapter = await openAdapter({ kind: 'journal', journalDir: path.join(dir, 'j') });
    assert.equal(adapter.kind, 'journal');
    adapter.put('memory_records', 'm1', { id: 'm1', content: '甲' });
    adapter.put('memory_records', 'm1', { id: 'm1', content: '乙' });
    adapter.remove('memory_records', 'm1');
    adapter.put('memory_records', 'm2', { id: 'm2', content: '丙' });
    adapter.checkpoint();
    let { collections } = adapter.loadAll();
    assert.equal(collections.get('memory_records').size, 1);
    assert.equal(collections.get('memory_records').get('m2').content, '丙');

    const backupFile = path.join(dir, 'backup.json');
    await adapter.backup(backupFile);
    adapter.remove('memory_records', 'm2');
    await adapter.restoreFrom(backupFile);
    ({ collections } = adapter.loadAll());
    assert.equal(collections.get('memory_records').get('m2').content, '丙');
    adapter.close();
});

test('Data 投影：插入即入索引，删除即清索引，rebuild 可重建', async () => {
    const dir = tempDir();
    const adapter = await openAdapter({ kind: 'auto', dbFile: path.join(dir, 'a.sqlite'), journalDir: path.join(dir, 'j') });
    const data = new Data({ adapter });
    await data.init();

    data.insert('memory_records', { id: 'm1', content: '林月住在云栖镇', status: 'active', scope: 'chat:t' });
    data.insert('memory_records', { id: 'm2', content: '沈青崖是师父', status: 'active', scope: 'chat:t' });
    let hits = data.searchText('云栖镇');
    assert.ok(hits.some((h) => h.id === 'm1'));
    assert.ok(!hits.some((h) => h.id === 'm2'));

    data.remove('memory_records', 'm1');
    hits = data.searchText('云栖镇');
    assert.ok(!hits.some((h) => h.id === 'm1'));

    // 人为破坏索引后重建
    data.index.postings.clear();
    data.index.docTerms.clear();
    assert.equal(data.searchText('师父').length, 0);
    data.rebuildIndex();
    hits = data.searchText('师父');
    assert.ok(hits.some((h) => h.id === 'm2'));
    adapter.close();
});

test('迁移失败会抛出 MigrationError（供修复模式使用）', () => {
    const err = new MigrationError('测试', { version: 1 });
    assert.equal(err.name, 'MigrationError');
    assert.equal(err.version, 1);
    assert.ok(MIGRATIONS.length >= 1);
    assert.equal(MIGRATIONS[0].version, 1);
});
