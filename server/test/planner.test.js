import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, dialogue, planRequest, msg } from './helpers.js';
import { estimateTokensConservative as count } from '../src/util/tokenizer.js';

/** 构造较长的对话：120 条消息，约 3800+ tokens。 */
function longDialogue() {
    const pairs = [];
    for (let i = 0; i < 60; i += 1) {
        pairs.push([
            `我环顾四周，想看看有没有人跟踪（第 ${i} 次）。`,
            `林月握紧剑柄，目光扫过雾气弥漫的街道（第 ${i} 幕）。`,
        ]);
    }
    const messages = dialogue(pairs, { startFloor: 0 });
    messages[messages.length - 1] = msg(messages.length - 1, '林月的佩剑叫什么？', { isUser: true });
    return messages;
}

async function seedMemory(service) {
    service.memories.create({
        kind: 'fact', scope: 'chat:test-chat', chatId: 'test-chat', branchId: 'main',
        content: '林月的佩剑是霜华剑', status: 'confirmed', confidence: 0.9, importance: 0.8,
        sourceMessageIds: ['seed-1'],
    }, { origin: 'auto' });
}

test('计划包含完整可解释字段（reason/sourceIds/plannerVersion/decisionProvider/token 成本/快照）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        await seedMemory(service);
        const plan = await service.plan(planRequest(longDialogue(), { contextLimit: 8192, outputReserve: 512 }));

        assert.ok(plan.planId);
        assert.equal(plan.plannerVersion, 'planner-v1');
        assert.equal(plan.decisionProvider, 'rule');
        assert.ok(plan.decision.reason);
        assert.ok(['ok', 'degraded'].includes(plan.result));
        assert.ok(plan.budget.availableInput > 0);
        assert.ok(typeof plan.estimate.finalTokens === 'number');
        assert.ok(typeof plan.estimate.savedRatio === 'number');
        assert.ok(Array.isArray(plan.retain.floors));
        assert.ok(Array.isArray(plan.drop));
        for (const action of plan.actions) {
            assert.ok(action.reason, '每个动作必须有 reason');
            assert.ok(typeof action.tokensBefore === 'number');
            assert.ok(typeof action.tokensAfter === 'number');
            assert.ok(Array.isArray(action.sourceIds));
        }
        for (const injection of plan.injections) {
            assert.ok(injection.reason);
            assert.ok(Array.isArray(injection.sourceIds));
            assert.ok(injection.tokens > 0);
        }
        assert.ok(plan.snapshotId, '非预览计划应生成快照');
    } finally {
        await ctx.cleanup();
    }
});

test('相关记忆被召回并注入，附来源与分数分解', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        await seedMemory(service);
        const plan = await service.plan(planRequest(longDialogue(), { contextLimit: 8192, outputReserve: 512 }));

        assert.ok(plan.recall.length >= 1, '应召回佩剑记忆');
        const hit = plan.recall.find((r) => r.kind === 'fact');
        assert.ok(hit);
        assert.ok(hit.breakdown.bm25 > 0);
        assert.ok(plan.injections.some((i) => i.text.includes('霜华剑')));
    } finally {
        await ctx.cleanup();
    }
});

test('旧消息产生章节摘要；未存摘要的章节进入待生成队列', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const plan = await service.plan(planRequest(longDialogue(), { contextLimit: 4096, outputReserve: 512 }));
        assert.ok(plan.chapters.total + plan.chapters.pending.length >= 1, '应至少产生一个章节块');
        // 非预览时应记录待生成章节（供后台复用）
        if (plan.result !== 'blocked') {
            assert.ok(plan.chapters.pending.length >= 1);
        }
    } finally {
        await ctx.cleanup();
    }
});

test('预算紧张时按梯度降级并记录节省量', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const plan = await service.plan(planRequest(longDialogue(), { contextLimit: 2600, outputReserve: 400 }));
        assert.equal(plan.result, 'degraded');
        assert.ok(plan.estimate.savedRatio > 0);
        assert.ok(plan.degradeReasons.length >= 1);
        assert.ok(plan.actions.some((a) => a.savedTokens > 0));
        assert.ok(plan.estimate.finalTokens <= plan.budget.availableInput);
    } finally {
        await ctx.cleanup();
    }
});

test('固定块超限时明确阻止并给出修复动作', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const huge = '世界书设定：这是一段极其冗长的设定文本。'.repeat(500);
        const request = planRequest(longDialogue(), {
            contextLimit: 4096,
            outputReserve: 512,
            blocks: [{ id: 'fixed:worldbook', kind: 'worldbook', text: huge }],
        });
        const plan = await service.plan(request);
        assert.equal(plan.result, 'blocked');
        assert.ok(plan.blockReason);
        assert.ok(plan.fixActions.length >= 2);
    } finally {
        await ctx.cleanup();
    }
});

test('hard 压力 + 实测超限 → 阻止发送', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const plan = await service.plan(planRequest(longDialogue(), {
            contextLimit: 4096,
            outputReserve: 512,
            options: { pressure: 'hard', measuredTokens: 999999 },
        }));
        assert.equal(plan.result, 'blocked');
        assert.equal(plan.tokenAccuracy, 'measured-by-st');
    } finally {
        await ctx.cleanup();
    }
});

test('预览模式不落库、不生成快照', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const before = service.data.count('context_plans');
        const plan = await service.plan(planRequest(longDialogue(), {
            contextLimit: 8192,
            options: { preview: true },
        }));
        assert.equal(plan.preview, true);
        assert.equal(plan.snapshotId, undefined);
        assert.equal(service.data.count('context_plans'), before);
    } finally {
        await ctx.cleanup();
    }
});

test('计划持久化后可查询并接受反馈（撤销/接受）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const plan = await service.plan(planRequest(longDialogue(), { contextLimit: 8192 }));
        const stored = service.data.get('context_plans', plan.planId);
        assert.ok(stored);
        assert.equal(stored.scope, 'chat:test-chat');
        const updated = service.recordFeedback(plan.planId, { accepted: false, reason: '内容不对' });
        assert.equal(updated.feedback.accepted, false);
        assert.ok(updated.feedback.at);
    } finally {
        await ctx.cleanup();
    }
});

test('同一输入两次规划：压缩结果一致（无摘要漂移）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const messages = longDialogue();
        const plan1 = await service.plan(planRequest(messages, { contextLimit: 2600, outputReserve: 400 }));
        const plan2 = await service.plan(planRequest(messages, { contextLimit: 2600, outputReserve: 400 }));
        assert.equal(plan1.estimate.finalTokens, plan2.estimate.finalTokens);
        const inject1 = plan1.injections.map((i) => i.text).join('\n');
        const inject2 = plan2.injections.map((i) => i.text).join('\n');
        assert.equal(inject1, inject2);
    } finally {
        await ctx.cleanup();
    }
});

test('受保护块永远不被计划修改（系统提示/卡牌文本只作为约束参与预算）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const cardText = '角色卡硬约束：林月绝不离开云栖镇。'.repeat(10);
        const plan = await service.plan(planRequest(longDialogue(), {
            contextLimit: 3000,
            outputReserve: 400,
            blocks: [{ id: 'fixed:card', kind: 'card-description', text: cardText }],
        }));
        // 计划只返回注入与消息保留/丢弃清单，不包含对固定块的任何删除动作
        for (const drop of plan.drop) {
            assert.ok(typeof drop.floorIndex === 'number', '丢弃清单只能包含消息楼层');
        }
        for (const action of plan.actions) {
            assert.ok(!action.sourceIds?.includes('fixed:card'), '固定块不得被任何降级动作处理');
        }
    } finally {
        await ctx.cleanup();
    }
});
