import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, delay } from './helpers.js';

test('任务幂等：相同 idempotencyKey 复用未完成任务', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.tasks.register('t-idem', async () => ({ ok: 1 }));
        const a = service.tasks.enqueue({ type: 't-idem', payload: { x: 1 } });
        const b = service.tasks.enqueue({ type: 't-idem', payload: { x: 1 } });
        assert.equal(a.id, b.id);
        await service.tasks.drain();
    } finally {
        await ctx.cleanup();
    }
});

test('任务执行与结果落库', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.tasks.register('t-run', async (payload) => ({ doubled: payload.n * 2 }));
        const task = service.tasks.enqueue({ type: 't-run', payload: { n: 21 } });
        assert.ok(await service.tasks.drain());
        const done = service.data.get('tasks', task.id);
        assert.equal(done.status, 'done');
        assert.equal(done.result.doubled, 42);
    } finally {
        await ctx.cleanup();
    }
});

test('任务失败重试上限后标记 failed（不形成无限重试）', async () => {
    const ctx = await makeService({ settings: { taskMaxAttempts: 1 } });
    try {
        const { service } = ctx;
        service.tasks.register('t-fail', async () => { throw new Error('boom'); });
        const task = service.tasks.enqueue({ type: 't-fail', payload: {} });
        await service.tasks.drain();
        const done = service.data.get('tasks', task.id);
        assert.equal(done.status, 'failed');
        assert.equal(done.errorType, 'Error');
        assert.ok(done.error.includes('boom'));
        assert.equal(done.nextRunAt, null, '失败后不得继续排队');
    } finally {
        await ctx.cleanup();
    }
});

test('版本失效：落库前检查不匹配 → stale，不重试', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.tasks.register('t-stale', async (_payload, taskCtx) => {
            taskCtx.assertFresh();
            return { shouldNotCommit: true };
        });
        const task = service.tasks.enqueue({
            type: 't-stale',
            payload: { chatId: 'chat-x', branchId: 'main' },
            version: { branchHead: 999 },
        });
        await service.tasks.drain();
        const done = service.data.get('tasks', task.id);
        assert.equal(done.status, 'stale');
        assert.equal(done.result, null, '过期任务不得写入结果');
    } finally {
        await ctx.cleanup();
    }
});

test('任务取消：运行中的任务被取消后不再落结果', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        let sideEffect = false;
        service.tasks.register('t-cancel', async (_payload, taskCtx) => {
            await delay(250);
            taskCtx.throwIfCancelled();
            sideEffect = true;
            return { ok: true };
        });
        const task = service.tasks.enqueue({ type: 't-cancel', payload: {} });
        await delay(60);
        assert.equal(service.tasks.cancel(task.id), true);
        await delay(400);
        const done = service.data.get('tasks', task.id);
        assert.equal(done.status, 'cancelled');
        assert.equal(sideEffect, false, '取消后的任务不得产生副作用');
    } finally {
        await ctx.cleanup();
    }
});

test('删除 epoch 变化使迟到任务失效', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scope = 'chat:epoch-test';
        service.memories.create({
            kind: 'fact', scope, chatId: 'epoch-test', content: '会被彻底删除的记忆', status: 'confirmed',
        }, { origin: 'auto' });
        const epochAtTask = service.memories.currentEpoch(scope);

        service.memories.purgeScope(scope);

        service.tasks.register('t-epoch', async (_payload, taskCtx) => {
            taskCtx.assertFresh();
            return { wrote: true };
        });
        const task = service.tasks.enqueue({
            type: 't-epoch',
            payload: { chatId: 'epoch-test', scope },
            version: { deletionEpoch: epochAtTask },
        });
        await service.tasks.drain();
        assert.equal(service.data.get('tasks', task.id).status, 'stale');
    } finally {
        await ctx.cleanup();
    }
});

test('后台抽取不阻塞：ingest 立即返回，任务异步完成', async () => {
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: false } });
    try {
        const { service } = ctx;
        const started = Date.now();
        const result = service.ingest({
            chatId: 'chat-async', branchId: 'main', scope: 'chat:chat-async',
            messages: [
                { floorIndex: 0, content: '我叫林月，是个剑客。', isUser: true, name: '你', sendDate: '2026-01-01T00:00:00.000Z' },
            ],
        });
        const elapsed = Date.now() - started;
        assert.ok(result.created === 1);
        assert.ok(elapsed < 200, `ingest 必须快速返回（实际 ${elapsed}ms）`);
        await service.tasks.drain();
        const extracted = service.memories.list({ scope: 'chat:chat-async' });
        assert.ok(extracted.total >= 1, '后台抽取应产生候选记忆');
    } finally {
        await ctx.cleanup();
    }
});

test('shadow 模式：抽取只产生候选，不自动写入长期事实', async () => {
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: true } });
    try {
        const { service } = ctx;
        service.ingest({
            chatId: 'chat-shadow', branchId: 'main', scope: 'chat:chat-shadow',
            messages: [
                { floorIndex: 0, content: '记住：我最喜欢桂花糕。', isUser: true, name: '你', sendDate: '2026-01-01T00:00:00.000Z' },
            ],
        });
        await service.tasks.drain();
        const items = service.memories.list({ scope: 'chat:chat-shadow' }).items;
        assert.ok(items.length >= 1);
        for (const rec of items) {
            assert.equal(rec.status, 'candidate', 'shadow 模式下不得自动提升');
        }
    } finally {
        await ctx.cleanup();
    }
});
