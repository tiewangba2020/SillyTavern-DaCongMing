import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

test('快照捕获与恢复：回滚被纠正的记忆状态', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const { record } = service.memories.create({
            kind: 'anchor', scope: 'chat:s1', chatId: 's1', content: '林月是剑客',
            status: 'confirmed', userLocked: true, sourceMessageIds: ['m1'],
        }, { origin: 'user' });

        const snapshot = service.snapshots.capture({
            plan: {
                planId: 'p1',
                injections: [{ sourceIds: [record.id] }],
                actions: [],
                anchors: [{ id: record.id }],
                recall: [],
                estimate: { finalTokens: 100 },
            },
            scope: 'chat:s1',
            chatId: 's1',
            label: 'test',
        });
        assert.ok(snapshot.id);
        assert.ok(snapshot.memoryState.some((s) => s.id === record.id));

        // 纠正后状态变化
        service.memories.correct(record.id, { content: '林月是剑客，也是城主之女' });
        assert.equal(service.memories.get(record.id).status, 'superseded');
        assert.equal(service.memories.get(record.id).invalidated, true);

        // 恢复快照 → 回滚到纠正前状态
        const result = service.snapshots.restore(snapshot.id);
        assert.ok(result.restored >= 1);
        const after = service.memories.get(record.id);
        assert.equal(after.status, 'confirmed');
        assert.equal(after.invalidated, false);
        assert.equal(after.restoredFrom, snapshot.id);
    } finally {
        await ctx.cleanup();
    }
});

test('快照恢复会归档快照之后生成的摘要（不留下半成品）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const snapshot = service.snapshots.capture({
            plan: { planId: 'p2', injections: [], actions: [], anchors: [], recall: [], estimate: {} },
            scope: 'chat:s2',
            chatId: 's2',
        });

        // 快照之后生成新摘要
        const { record: summary } = service.memories.create({
            kind: 'summary_chapter', scope: 'chat:s2', chatId: 's2',
            content: '新章节摘要内容', status: 'confirmed', sourceMessageIds: ['m2'],
            structured: { chapterKey: 's2|main|5' },
        }, { origin: 'auto' });
        // 确保 createdAt 晚于快照
        await new Promise((r) => setTimeout(r, 5));

        const result = service.snapshots.restore(snapshot.id);
        assert.ok(result.archived >= 1);
        assert.equal(service.memories.get(summary.id).status, 'archived');
        assert.ok(service.memories.get(summary.id).invalidatedReason.includes('快照回滚'));
    } finally {
        await ctx.cleanup();
    }
});

test('快照列表与 lastGood', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.snapshots.capture({ plan: { planId: 'a', injections: [], actions: [], anchors: [], recall: [] }, scope: 'chat:s3', chatId: 's3', label: 'auto-compress' });
        service.snapshots.capture({ plan: { planId: 'b', injections: [], actions: [], anchors: [], recall: [] }, scope: 'chat:s3', chatId: 's3', label: 'manual' });
        const items = service.snapshots.list({ scope: 'chat:s3' });
        assert.equal(items.length, 2);
        assert.equal(items[0].label, 'manual', '按时间倒序');
        assert.ok(service.snapshots.lastGood('chat:s3'));
    } finally {
        await ctx.cleanup();
    }
});

test('恢复不存在的快照会报错（不会静默成功）', async () => {
    const ctx = await makeService();
    try {
        assert.throws(() => ctx.service.snapshots.restore('nope'), /快照不存在/);
    } finally {
        await ctx.cleanup();
    }
});
