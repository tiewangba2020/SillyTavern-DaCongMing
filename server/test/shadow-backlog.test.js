/**
 * 观察期（shadow）与回补晋升、手动快照。
 *
 * 对应审计发现：
 *   - D7 观察期内抽取的事实停在 candidate 且**永不晋升**，而 candidate 不可召回
 *        → 观察期内容等于白记；默认 shadowMode 曾是布尔 true（等于永久观察期）。
 *   - D21 后端有快照能力但界面无法手动创建（本次新增 POST /api/snapshots）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, makeService, msg } from './helpers.js';
import { RECALLABLE_STATUS } from '../src/core/memory.js';

const CHAT_ID = 'shadow-backlog';
const SCOPE = `chat:${CHAT_ID}`;

test('观察期内抽取的事实停在 candidate 且不可召回', async () => {
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: 'first-n', shadowTurns: 5 } });
    try {
        const { service } = ctx;
        service.ingest({
            chatId: CHAT_ID,
            branchId: 'main',
            scope: SCOPE,
            messages: [msg(1, '请记住：林月的佩剑名叫裁云。', { isUser: true })],
        });
        assert.ok(await service.tasks.drain(10_000), '抽取任务应在超时内完成');

        const records = service.data.all('memory_records').filter((r) => r.scope === SCOPE);
        assert.ok(records.length > 0, '应抽出候选事实');
        assert.ok(records.every((r) => r.status === 'candidate'), '观察期内必须全部是 candidate');
        for (const rec of records) {
            assert.ok(!RECALLABLE_STATUS.has(rec.status), 'candidate 不应进入可召回集合');
        }
    } finally {
        await ctx.cleanup();
    }
});

test("shadowMode: 'off' 必须等价于布尔 false（不设观察期），不能把字符串当成真值", async () => {
    // 回归：旧实现 #inShadow 末尾是 Boolean(mode)，字符串 'off' 是真值 →
    // 观察期恒真 → 抽取的事实永远停在 candidate（不可召回），自动记忆等于完全失效。
    const collect = async (shadowMode) => {
        const ctx = await makeService({ settings: { autoManage: true, shadowMode } });
        try {
            const { service } = ctx;
            service.ingest({
                chatId: CHAT_ID,
                branchId: 'main',
                scope: SCOPE,
                messages: [msg(1, '请记住：林月的佩剑名叫裁云。', { isUser: true })],
            });
            assert.ok(await service.tasks.drain(10_000), '抽取任务应在超时内完成');
            return service.data.all('memory_records')
                .filter((r) => r.scope === SCOPE)
                .map((r) => r.status)
                .sort();
        } finally {
            await ctx.cleanup();
        }
    };

    const off = await collect('off');
    const boolFalse = await collect(false);
    assert.ok(off.length > 0, '应抽出候选事实');
    assert.deepEqual(off, boolFalse, "字符串 'off' 必须与布尔 false 行为一致");
    assert.ok(off.some((s) => RECALLABLE_STATUS.has(s)),
        `'off' 表示不设观察期，事实应直接进入可召回状态（实际：${off.join(', ')}）`);
});

test('观察期结束后，此前滞留的 candidate 被回补晋升为可召回状态', async () => {
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: 'first-n', shadowTurns: 1 } });
    try {
        const { service } = ctx;

        // 第 1 轮：turnCount=1 ≤ shadowTurns → 观察期
        service.ingest({
            chatId: CHAT_ID,
            branchId: 'main',
            scope: SCOPE,
            messages: [msg(1, '请记住：林月的佩剑名叫裁云。', { isUser: true })],
        });
        assert.ok(await service.tasks.drain(10_000));
        const shadowed = service.data.all('memory_records')
            .filter((r) => r.scope === SCOPE && r.status === 'candidate');
        assert.ok(shadowed.length > 0, '第 1 轮应产生 candidate');

        // 第 2 轮：turnCount=2 > shadowTurns → 非观察期，应回补晋升旧记录
        service.ingest({
            chatId: CHAT_ID,
            branchId: 'main',
            scope: SCOPE,
            messages: [msg(2, '周伯住在云栖镇西边。', { isUser: false })],
        });
        assert.ok(await service.tasks.drain(10_000));

        const after = shadowed.map((r) => service.data.get('memory_records', r.id));
        const promoted = after.filter((r) => RECALLABLE_STATUS.has(r.status));
        assert.ok(promoted.length > 0,
            `观察期结束后旧 candidate 应被晋升（当前状态：${after.map((r) => r.status).join(', ')}）`);
        for (const rec of promoted) {
            assert.match(String(rec.statusReason ?? ''), /观察期结束/, '晋升原因应可追溯');
        }
    } finally {
        await ctx.cleanup();
    }
});

test('插件模式配置：settingsPersisted 反映是否已有用户配置（D19 依据）', async () => {
    const ctx = await makeServer();
    try {
        const first = await ctx.request('GET', '/api/settings');
        assert.equal(first.status, 200);
        assert.equal(first.payload.settings.settingsPersisted, false, '新数据目录应报告「无持久化设置」');

        const patch = await ctx.request('POST', '/api/settings', { body: { autoManage: true } });
        assert.equal(patch.status, 200);

        const second = await ctx.request('GET', '/api/settings');
        assert.equal(second.payload.settings.settingsPersisted, true);
        assert.equal(second.payload.settings.autoManage, true);
    } finally {
        await ctx.cleanup();
    }
});

test('手动创建快照：POST /api/snapshots 落库并可回滚', async () => {
    const ctx = await makeServer();
    try {
        const created = await ctx.request('POST', '/api/snapshots', {
            body: { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', label: '手动快照' },
        });
        assert.equal(created.status, 200);
        assert.equal(created.payload.ok, true);
        assert.equal(created.payload.snapshot.label, '手动快照');
        assert.equal(created.payload.snapshot.auto, false);

        const list = await ctx.request('GET', `/api/snapshots?scope=${encodeURIComponent(SCOPE)}`);
        assert.equal(list.payload.items.length, 1);
        assert.equal(list.payload.items[0].id, created.payload.snapshot.id);

        // 缺 scope 应被拒绝（handler 返回 ok:false → 400）
        const bad = await ctx.request('POST', '/api/snapshots', { body: {} });
        assert.equal(bad.status, 400);
        assert.equal(bad.payload.ok, false);
    } finally {
        await ctx.cleanup();
    }
});
