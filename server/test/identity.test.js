import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, msg, dialogue } from './helpers.js';
import { normalizeScope, scopeKey, chatScope, branchScope } from '../src/core/identity.js';

test('作用域归一化与键生成', () => {
    assert.equal(scopeKey('chat:abc'), 'chat:abc');
    assert.equal(normalizeScope({ type: 'branch', id: 'c1:b1' }).key, 'branch:c1:b1');
    assert.equal(normalizeScope(null).key, 'chat:default');
    assert.equal(chatScope('c1').key, 'chat:c1');
    assert.equal(branchScope('c1', 'b1').key, 'branch:c1:b1');
});

test('同一消息重复解析得到同一 messageId；内容变化 → revision+1', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const chatId = 'chat-1';
        const branchId = 'main';
        const m = msg(3, '林月走进了客栈。', { isUser: true });

        const first = service.identities.resolve(chatId, branchId, m);
        assert.equal(first.isNew, true);
        assert.equal(first.revision, 1);

        const again = service.identities.resolve(chatId, branchId, m);
        assert.equal(again.messageId, first.messageId);
        assert.equal(again.isNew, false);
        assert.equal(again.edited, false);

        const edited = service.identities.resolve(chatId, branchId, { ...m, content: '林月推门走进了客栈。' });
        assert.equal(edited.messageId, first.messageId);
        assert.equal(edited.edited, true);
        assert.equal(edited.revision, 2);
    } finally {
        await ctx.cleanup();
    }
});

test('不同分支的相同楼层是不同身份', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const m = msg(5, '同一段内容', { isUser: true });
        const a = service.identities.resolve('chat-1', 'main', m);
        const b = service.identities.resolve('chat-1', 'branch-x', m);
        assert.notEqual(a.messageId, b.messageId);
    } finally {
        await ctx.cleanup();
    }
});

test('缺少 send_date 时标记低置信度（不使用楼层做主键）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const m = { floorIndex: 7, content: '没有时间戳的消息', isUser: true, name: '你', sendDate: null };
        const result = service.identities.resolve('chat-1', 'main', m);
        assert.equal(result.lowConfidence, true);
    } finally {
        await ctx.cleanup();
    }
});

test('事件摄取：新增/编辑/删除，编辑使派生记忆失效', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const chatId = 'chat-evt';
        const branchId = 'main';
        const messages = dialogue([['我叫林月。', '欢迎，林月。']], { startFloor: 0 });

        const first = service.ingest({ chatId, branchId, messages, scope: `chat:${chatId}` });
        assert.equal(first.created, 2);
        assert.equal(first.edited, 0);

        // 为第二条消息建立派生记忆（来源 revision 1）
        const secondIdentity = service.identities.byChat(chatId, branchId)
            .find((r) => r.floorIndex === 1);
        const { record } = service.memories.create({
            kind: 'fact',
            scope: `chat:${chatId}`,
            chatId,
            branchId,
            content: '助手欢迎了林月',
            sourceMessageIds: [secondIdentity.messageId],
            sourceRevision: 1,
            status: 'confirmed',
            confidence: 0.9,
        }, { origin: 'auto' });
        assert.ok(record);

        // 编辑第二条消息 → 派生记忆失效
        const editedMessages = [
            messages[0],
            { ...messages[1], content: '欢迎你，远道而来的剑客。' },
        ];
        const second = service.ingest({ chatId, branchId, messages: editedMessages, scope: `chat:${chatId}` });
        assert.equal(second.edited, 1);
        assert.ok(second.invalidated.memoryIds.includes(record.id));
        const after = service.memories.get(record.id);
        assert.equal(after.invalidated, true);
        assert.ok(after.invalidatedReason.includes('revision'));

        // 删除消息（显式）→ 派生记忆再次被标记
        const third = service.ingest({
            chatId, branchId, messages: [messages[0]], scope: `chat:${chatId}`,
            deleted: [{ floorIndex: 1 }],
        });
        assert.equal(third.deleted, 1);
    } finally {
        await ctx.cleanup();
    }
});

test('全量同步检测消失的消息（删除兜底）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const chatId = 'chat-del';
        const messages = dialogue([['甲', '乙'], ['丙', '丁']], { startFloor: 0 });
        service.ingest({ chatId, branchId: 'main', messages, scope: `chat:${chatId}`, fullSync: true });
        const shrunk = messages.slice(0, 2);
        const result = service.ingest({ chatId, branchId: 'main', messages: shrunk, scope: `chat:${chatId}`, fullSync: true });
        assert.equal(result.deleted, 2);
    } finally {
        await ctx.cleanup();
    }
});

test('swipe 切换使派生结果失效', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const chatId = 'chat-swipe';
        const messages = dialogue([['问题', '回答一']], { startFloor: 0 });
        service.ingest({ chatId, branchId: 'main', messages, scope: `chat:${chatId}` });
        const identity = service.identities.byChat(chatId, 'main').find((r) => r.floorIndex === 1);
        const { record } = service.memories.create({
            kind: 'fact', scope: `chat:${chatId}`, chatId, branchId: 'main',
            content: '回答一是这样的', sourceMessageIds: [identity.messageId], sourceRevision: 1,
            status: 'confirmed',
        }, { origin: 'auto' });

        service.events.recordSwipeSelection({ chatId, branchId: 'main', messageId: identity.messageId, variantId: 2 });
        assert.equal(service.memories.get(record.id).invalidated, true);
    } finally {
        await ctx.cleanup();
    }
});
