import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

async function createMemory(service, overrides = {}) {
    const { record } = service.memories.create({
        kind: 'fact',
        scope: 'chat:m1',
        chatId: 'm1',
        content: '沈青崖住在云栖镇',
        status: 'confirmed',
        confidence: 0.9,
        sourceMessageIds: ['msg-1'],
        ...overrides,
    }, { origin: 'auto' });
    return record;
}

test('创建与去重：同作用域同内容只保留一条', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const first = await createMemory(service);
        const { record: second, duplicate } = service.memories.create({
            kind: 'fact', scope: 'chat:m1', chatId: 'm1', content: '沈青崖住在云栖镇',
            status: 'confirmed',
        }, { origin: 'auto' });
        assert.equal(second.id, first.id);
        assert.ok(duplicate);
        assert.equal(service.memories.list({ scope: 'chat:m1' }).total, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('生命周期：candidate → confirmed 提升，固定即确认', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const rec = await createMemory(service, { content: '低置信度候选', status: 'candidate', confidence: 0.3 });
        assert.equal(rec.status, 'candidate');
        const locked = service.memories.setLocked(rec.id, true);
        assert.equal(locked.status, 'confirmed');
        assert.equal(locked.userLocked, true);
        assert.ok(locked.confidence >= 0.95);
    } finally {
        await ctx.cleanup();
    }
});

test('用户纠正：旧版本立即失效并被替代', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const old = await createMemory(service, { content: '林月的佩剑是龙渊剑' });
        const corrected = service.memories.correct(old.id, { content: '林月的佩剑是霜华剑' });
        const oldAfter = service.memories.get(old.id);
        assert.equal(oldAfter.status, 'superseded');
        assert.equal(oldAfter.invalidated, true);
        assert.equal(oldAfter.supersededBy, corrected.id);
        assert.equal(corrected.content, '林月的佩剑是霜华剑');
        assert.equal(corrected.userEdited, true);
        assert.equal(corrected.userLocked, true);
        assert.equal(corrected.supersedes, old.id);
        assert.equal(corrected.confidence, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('遗忘：建立持久阻断，重扫/重建也不能复活', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const rec = await createMemory(service, { content: '这条记忆要被遗忘' });
        service.memories.forget(rec.id);
        assert.equal(service.memories.get(rec.id).status, 'archived');

        // 相同内容再次创建（模拟重扫历史）→ 被阻断
        const retry = service.memories.create({
            kind: 'fact', scope: 'chat:m1', chatId: 'm1', content: '这条记忆要被遗忘',
            status: 'confirmed',
        }, { origin: 'auto' });
        assert.equal(retry.record, null);
        assert.ok(retry.blocked);
        assert.equal(retry.blocked.kind, 'forget');
    } finally {
        await ctx.cleanup();
    }
});

test('不再记忆（按文本）：包含关系也阻断', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.memories.forgetText({ scope: 'chat:m1', text: '不要记住这段私密内容，它很长很长', reason: '用户标记' });
        const attempt = service.memories.create({
            kind: 'fact', scope: 'chat:m1', chatId: 'm1',
            content: '前置说明：不要记住这段私密内容，它很长很长（后续补充）',
            status: 'confirmed',
        }, { origin: 'auto' });
        assert.equal(attempt.record, null);
        assert.ok(attempt.blocked);
    } finally {
        await ctx.cleanup();
    }
});

test('彻底删除：清理插件副本、推进 deletion epoch、迟到任务不得写入', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scope = 'chat:m1';
        const before = service.memories.currentEpoch(scope);
        await createMemory(service);
        await createMemory(service, { content: '第二条记忆' });

        const result = service.memories.purgeScope(scope);
        assert.equal(result.memories, 2);
        assert.equal(result.epoch, before + 1);
        assert.equal(service.memories.list({ scope }).total, 0);

        // 旧 epoch 的任务提交被拒绝
        assert.equal(service.memories.checkEpoch(scope, before), false);
        assert.equal(service.memories.checkEpoch(scope, result.epoch), true);

        // tombstone 只保留标识，不保留已删正文
        const tombstones = service.data.query('tombstones', (t) => t.scope === scope);
        for (const t of tombstones) {
            assert.equal(t.targetText, null);
            assert.deepEqual(t.messageIds, []);
        }
    } finally {
        await ctx.cleanup();
    }
});

test('过期处理：validTo 到期自动标记 expired', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const rec = await createMemory(service, { content: '临时状态', validTo: '2020-01-01T00:00:00.000Z' });
        const count = service.memories.expireDue();
        assert.ok(count >= 1);
        assert.equal(service.memories.get(rec.id).status, 'expired');
    } finally {
        await ctx.cleanup();
    }
});

test('冲突登记：双方进入 conflict，不覆盖已确认事实', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const a = await createMemory(service, { content: '沈青崖住在云栖镇东边' });
        const b = await createMemory(service, { content: '沈青崖住在苍梧山北麓' });
        service.memories.registerConflict(a.id, b.id, 'location 冲突');
        assert.equal(service.memories.get(a.id).status, 'conflict');
        assert.equal(service.memories.get(b.id).status, 'conflict');
        assert.equal(service.memories.get(a.id).conflictWith, b.id);
    } finally {
        await ctx.cleanup();
    }
});

test('列表过滤：按状态/类型/来源消息过滤', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await createMemory(service, { content: '事实一', kind: 'fact', status: 'active' });
        await createMemory(service, { content: '目标一', kind: 'goal', status: 'confirmed', sourceMessageIds: ['msg-9'] });
        assert.equal(service.memories.list({ scope: 'chat:m1', kind: 'goal' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', status: ['active'] }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', sourceMessageId: 'msg-9' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', search: '目标' }).total, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('列表过滤：类型 / 来源 / 时间范围（D12）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const a = await createMemory(service, {
            content: '导入自柏宝书的旧记忆', kind: 'fact', status: 'active',
        });
        service.data.update('memory_records', a.id, {
            derivation: { method: 'import', sourcePlugin: 'baibaoshu' },
            createdAt: '2026-01-02T00:00:00.000Z',
        });
        const b = await createMemory(service, {
            content: '本轮刚抽到的章节摘要', kind: 'summary_chapter', status: 'confirmed',
        });
        service.data.update('memory_records', b.id, { createdAt: '2026-06-01T00:00:00.000Z' });

        // 类型
        assert.equal(service.memories.list({ scope: 'chat:m1', kind: 'summary_chapter' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', kind: ['fact', 'summary_chapter'] }).total, 2);

        // 来源
        assert.equal(service.memories.list({ scope: 'chat:m1', sourcePlugin: 'baibaoshu' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', sourcePlugin: 'horae' }).total, 0);

        // 时间范围
        assert.equal(service.memories.list({ scope: 'chat:m1', createdAfter: '2026-05-01T00:00:00.000Z' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', createdBefore: '2026-02-01T00:00:00.000Z' }).total, 1);
        assert.equal(service.memories.list({
            scope: 'chat:m1',
            createdAfter: '2026-01-01T00:00:00.000Z',
            createdBefore: '2026-03-01T00:00:00.000Z',
        }).total, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('列表过滤：楼层区间与角色（D12）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await createMemory(service, {
            content: '第 100 楼说过的事', kernel: undefined,
            floorStart: 100, floorEnd: 100, speakers: ['沈青崖'],
        });
        await createMemory(service, {
            content: '第 300 到 320 楼的章节摘要', kind: 'summary_chapter',
            floorStart: 300, floorEnd: 320, speakers: ['叙述者'],
        });
        await createMemory(service, { content: '手动添加、没有楼层信息的记忆' });

        // 楼层：区间有交集即命中
        assert.equal(service.memories.list({ scope: 'chat:m1', floorFrom: 50, floorTo: 150 }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', floorFrom: 310, floorTo: 330 }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', floorFrom: 0, floorTo: 1000 }).total, 2);
        // 有楼层筛选时，没有楼层信息的记录被排除
        assert.equal(service.memories.list({ scope: 'chat:m1', floorFrom: 200 }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', floorTo: 90 }).total, 0);

        // 角色
        assert.equal(service.memories.list({ scope: 'chat:m1', speaker: '沈青崖' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', speaker: '叙述' }).total, 1);
        assert.equal(service.memories.list({ scope: 'chat:m1', speaker: '不存在的人' }).total, 0);

        // 不筛选时全部返回
        assert.equal(service.memories.list({ scope: 'chat:m1' }).total, 3);
    } finally {
        await ctx.cleanup();
    }
});

test('抽取会把来源楼层与说话人记到记忆上（D12）', async () => {
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: 'off' } });
    try {
        const { service } = ctx;
        service.ingest({
            chatId: 'm1', branchId: 'main', scope: 'chat:m1',
            messages: [
                { floorIndex: 41, content: '请记住：林月的佩剑名叫裁云。', isUser: true, isSystem: false, name: '你' },
                { floorIndex: 42, content: '她把它留在了渡口。', isUser: false, isSystem: false, name: '沈青崖' },
            ],
        });
        assert.ok(await service.tasks.drain(10_000));

        const items = service.memories.list({ scope: 'chat:m1' }).items;
        assert.ok(items.length > 0, '应抽出记忆');
        for (const rec of items) {
            assert.ok(Number.isFinite(rec.floorStart), `${rec.content} 应带来源楼层`);
            assert.ok(rec.floorStart >= 41 && rec.floorStart <= 42);
        }
        assert.ok(items.some((r) => (r.speakers ?? []).length > 0), '应记录说话人');
        // 可按来源楼层定位（命中第 41 楼抽到的记忆）
        assert.ok(service.memories.list({ scope: 'chat:m1', floorFrom: 41, floorTo: 41 }).total > 0);
        assert.equal(service.memories.list({ scope: 'chat:m1', floorFrom: 90, floorTo: 99 }).total, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('记忆库管理：listScopes 统计 / renameScope 别名 / deleteScope 彻底清理（v0.3.0）', async () => {
    const { makeService } = await import('./helpers.js');
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const chatId = 'multi-run-1';
        const scope = `chat:${chatId}`;
        service.ingest({
            chatId, branchId: 'main', scope,
            messages: [
                { content: '苏清对林月的態度变成了戒备与疏离。', isUser: false, name: '角色', floorIndex: 0, sendDate: null },
                { content: '我把半枚玉佩收进了妆匣底层。', isUser: true, name: '你', floorIndex: 1, sendDate: null },
            ],
            fullSync: true,
        });

        // listScopes：应出现该作用域并统计消息副本
        const listed = service.listScopes();
        const entry = listed.scopes.find((x) => x.scope === scope);
        assert.ok(entry, 'listScopes 应包含刚摄取的聊天');
        assert.ok(entry.records >= 2, `应统计到至少 2 条记录，实际 ${entry.records}`);
        assert.ok(entry.bytes > 0);

        // renameScope：别名写入与读取
        assert.equal(service.renameScope(scope, '第一周目').ok, true);
        assert.equal(service.listScopes().scopes.find((x) => x.scope === scope).name, '第一周目');
        // 清除别名（空名）
        service.renameScope(scope, '');
        assert.equal(service.listScopes().scopes.find((x) => x.scope === scope).name, null);

        // deleteScope：彻底清理
        const del = service.deleteScope(scope);
        assert.equal(del.ok, true);
        assert.ok(del.memories >= 0);
        const after = service.listScopes().scopes.find((x) => x.scope === scope);
        assert.equal(after, undefined, '删除后 listScopes 不应再列出该作用域');
        assert.equal(service.data.query('memory_records', (r) => r.scope === scope).length, 0, '记忆应被清空');

        // 非法输入
        assert.equal(service.deleteScope('').ok, false);
        assert.equal(service.renameScope('', 'x').ok, false);
    } finally {
        await ctx.cleanup();
    }
});
