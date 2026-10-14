import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';
import { healthCheck, applyFix } from '../src/core/health.js';

// 每条记忆用唯一来源 id：否则前面多条 create 共用同一 id 时，
// 其中一条被 forget 产生的 tombstone（含该 messageId）会连带阻断后续所有 create。
let __srcSeq = 0;
const uniqSource = () => `known-msg-${(++__srcSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function create(service, overrides = {}, opts = { origin: 'auto' }) {
    const { record } = service.memories.create({
        kind: 'fact', scope: 'chat:h1', chatId: 'h1', content: `记忆内容 ${Math.random()}`,
        status: 'confirmed', confidence: 0.9, sourceMessageIds: [uniqSource()],
        ...overrides,
    }, opts);
    return record;
}

test('冲突事实被体检发现', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const a = await create(service, { content: '沈青崖住在东边' });
        const b = await create(service, { content: '沈青崖住在西边' });
        service.memories.registerConflict(a.id, b.id, 'location 冲突');
        const report = service.healthCheck('chat:h1');
        assert.ok(report.summary.byType.conflict >= 1);
        assert.equal(report.summary.bySeverity.high >= 1, true);
    } finally {
        await ctx.cleanup();
    }
});

test('过期但仍活跃的事实被标记', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await create(service, { content: '临时状态：城门开放', validTo: '2020-01-01T00:00:00.000Z', status: 'active' });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        assert.ok(report.summary.byType.expired >= 1);
    } finally {
        await ctx.cleanup();
    }
});

test('无来源记忆被标记（用户记忆除外）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await create(service, { content: '没有来源的自动事实', sourceMessageIds: [] });
        service.memories.create({
            kind: 'fact', scope: 'chat:h1', chatId: 'h1', content: '用户手写的事实',
            status: 'confirmed', userEdited: true,
            derivation: { method: 'user', version: 'user-create' },
        }, { origin: 'user' });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        const noSource = report.issues.filter((i) => i.type === 'no_source');
        assert.equal(noSource.length, 1);
        assert.ok(noSource[0].detail.includes('没有来源的自动事实'));
    } finally {
        await ctx.cleanup();
    }
});

test('孤儿来源（引用不存在的消息）被标记', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await create(service, { content: '引用幽灵消息的记忆', sourceMessageIds: ['ghost-msg-1', 'ghost-msg-2'] });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        const orphan = report.issues.find((i) => i.type === 'orphan_source');
        assert.ok(orphan);
        assert.ok(orphan.detail.includes('2'));
    } finally {
        await ctx.cleanup();
    }
});

test('跨作用域污染被标记（高严重度）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const identity = service.identities.resolve('other-chat', 'main', {
            floorIndex: 0, content: '别的聊天里的消息', isUser: true, name: '你', sendDate: '2026-01-01T00:00:00.000Z',
        });
        await create(service, { content: '串卡记忆', chatId: 'h1', sourceMessageIds: [identity.messageId] });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        const cross = report.issues.find((i) => i.type === 'cross_scope');
        assert.ok(cross);
        assert.equal(cross.severity, 'high');
    } finally {
        await ctx.cleanup();
    }
});

test('重复摘要被标记', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        // 体检的「重复摘要」只可能来自绕过 create 去重的写入（正常 create 按 (scope,hash)
        // 去重，永远不会留下两条同 hash 的活跃记录），因此这里显式允许重复。
        await create(service, { kind: 'summary_chapter', content: '相同的摘要内容', structured: { chapterKey: 'h1|main|1' } }, { allowDuplicate: true });
        await create(service, { kind: 'summary_chapter', content: '相同的摘要内容', structured: { chapterKey: 'h1|main|2' } }, { allowDuplicate: true });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        assert.ok(report.summary.byType.duplicate_summary >= 1);
    } finally {
        await ctx.cleanup();
    }
});

test('损坏索引被标记，一键重建可修复', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const rec = await create(service, { content: '用于测试索引的独特内容' });
        // 人为破坏：从索引移除该文档
        service.data.deindexRecord('memory_records', rec);
        let report = healthCheck({ data: service.data, scope: 'chat:h1' });
        assert.ok(report.issues.some((i) => i.type === 'broken_index'));

        const fixed = applyFix({ data: service.data, memoryService: service.memories, fix: 'rebuild-index' });
        assert.equal(fixed.ok, true);
        report = healthCheck({ data: service.data, scope: 'chat:h1' });
        assert.ok(!report.issues.some((i) => i.type === 'broken_index'));
        // 重建后仍可召回
        assert.ok(service.data.searchText('独特内容').length >= 1);
    } finally {
        await ctx.cleanup();
    }
});

test('体检修复动作：过期标记、遗忘污染记录、归档重复摘要', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const expired = await create(service, { content: '过期项', validTo: '2020-01-01T00:00:00.000Z', status: 'active' });
        const fix1 = applyFix({ data: service.data, memoryService: service.memories, fix: 'expire-record', ids: [expired.id] });
        assert.equal(fix1.ok, true);
        assert.equal(service.memories.get(expired.id).status, 'expired');

        const polluted = await create(service, { content: '污染项' });
        applyFix({ data: service.data, memoryService: service.memories, fix: 'forget-record', ids: [polluted.id] });
        assert.equal(service.memories.get(polluted.id).status, 'archived');
        assert.ok(service.data.query('tombstones', (t) => t.targetHash === polluted.hash).length === 1);

        const dup1 = await create(service, { kind: 'summary_chapter', content: '重复摘要', structured: { chapterKey: 'a' } }, { origin: 'auto', allowDuplicate: true });
        const dup2 = await create(service, { kind: 'summary_chapter', content: '重复摘要', structured: { chapterKey: 'b' } }, { origin: 'auto', allowDuplicate: true });
        applyFix({ data: service.data, memoryService: service.memories, fix: 'archive-duplicate', ids: [dup1.id, dup2.id] });
        assert.equal(service.memories.get(dup2.id).status, 'archived');
        assert.equal(service.memories.get(dup1.id).status, 'confirmed');
    } finally {
        await ctx.cleanup();
    }
});

test('健康数据（无问题）时 healthy = true', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.identities.resolve('h1', 'main', { floorIndex: 0, content: '来源消息', isUser: true, name: '你', sendDate: '2026-01-01T00:00:00.000Z' });
        const identity = service.identities.byChat('h1', 'main')[0];
        await create(service, { content: '有来源的健康记忆', sourceMessageIds: [identity.messageId] });
        const report = healthCheck({ data: service.data, scope: 'chat:h1' });
        assert.equal(report.summary.issues, 0);
        assert.equal(report.summary.healthy, true);
    } finally {
        await ctx.cleanup();
    }
});
