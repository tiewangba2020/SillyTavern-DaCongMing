import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, dialogue, planRequest, msg } from './helpers.js';

/**
 * 世界书 / 系统注入保护（需求 §2.6「世界书永不压缩、始终受保护」）：
 * - 系统注入消息永不进入 drop / replacements（不删、不改）；
 * - 旧章节的摘要与原文都不含系统注入内容（不消化进章节摘要）；
 * - 系统注入 token 照常计入预算（账实一致），并在「保留原文」中列出。
 */
const WI_TEXT = '【世界书·云栖镇异闻】沈青崖左手的旧伤是少年时被铁水烫伤，镇民因此避而不谈他的名字。';

/** 80 条对话，第 5 楼插入一条世界书系统消息。 */
function dialogueWithWorldInfo() {
    const pairs = [];
    for (let i = 0; i < 40; i += 1) {
        pairs.push([
            `我向掌柜打听云栖镇的旧事，特别问了沈青崖这个人（第 ${i} 次询问）。`,
            `掌柜的放下手里的算盘，沉吟片刻说起了三十年前的码头旧事（第 ${i} 幕）。`,
        ]);
    }
    const messages = dialogue(pairs, { startFloor: 0 });
    messages[5] = msg(5, WI_TEXT, { isSystem: true, name: '世界书' });
    messages[messages.length - 1] = msg(messages.length - 1, '沈青崖左手上的旧伤到底是怎么来的？', { isUser: true });
    return messages;
}

test('世界书消息在旧章节中被压缩时：不删、不改、不进摘要', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const messages = dialogueWithWorldInfo();
        // 小上下文 + 节省档：强制压缩旧章节（章节 0/1 都在最近窗口之外）
        const plan = await service.plan(planRequest(messages, { contextLimit: 1024, outputReserve: 256, tier: 'saving' }));

        assert.equal(plan.tokenAccuracy, 'estimate');
        // 1) 世界书楼层不出现在丢弃与替换里
        const droppedFloors = (plan.drop ?? []).map((d) => d.floorIndex);
        const replacedFloors = (plan.replacements ?? []).map((r) => r.floorIndex);
        assert.ok(!droppedFloors.includes(5), `世界书楼层不应被丢弃，实际 drop=${JSON.stringify(droppedFloors)}`);
        assert.ok(!replacedFloors.includes(5), '世界书楼层不应被替换');
        // 2) 出现在「保留原文」里（可解释）
        assert.ok((plan.retain?.floors ?? []).includes(5), '世界书楼层应列为保留原文');
        // 3) 注入的章节摘要里不出现世界书内容
        const injectionText = (plan.injections ?? []).map((b) => b.text).join('\n');
        assert.ok(!injectionText.includes(WI_TEXT.slice(0, 12)), '章节摘要不应消化世界书内容');
        // 4) 普通聊天内容照常被压缩（证明修复没有把正常路径一起关掉）
        assert.ok(['degraded', 'blocked'].includes(plan.result), `应触发降级，实际 ${plan.result}`);
        const droppedChatFloors = droppedFloors.filter((f) => f !== 5);
        assert.ok(droppedChatFloors.length > 0, '普通旧消息仍应被压缩/丢弃');
    } finally {
        await ctx.cleanup();
    }
});

test('纯系统章节：不生成摘要、不丢弃、预算照常计入', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        // 楼层 0-3 全是系统注入（世界书），4/5 是收尾对话
        const messages = [
            msg(0, `【世界书·条目${0}】云栖镇外三十里有一座寒潭，潭底沉着会发光的星纹石。`, { isSystem: true }),
            msg(1, `【世界书·条目${1}】沈青崖当年独守渡口七天七夜，左臂旧伤自此每逢阴雨作痛。`, { isSystem: true }),
            msg(2, `【世界书·条目${2}】林月晚年隐居镇西，佩剑换作一把寻常铁剑，名曰“藏锋”。`, { isSystem: true }),
            msg(3, `【世界书·条目${3}】阿澈在誓约之后远走苍梧山，再无音讯。`, { isSystem: true }),
            msg(4, '掌柜的，把你这店里的旧事再讲给我听听。', { isUser: true }),
            msg(5, '好，那你且听我从头讲起。', { name: '掌柜' }),
        ];
        const plan = await service.plan(planRequest(messages, { contextLimit: 8192, outputReserve: 512 }));

        assert.equal(plan.result, 'ok');
        assert.equal((plan.drop ?? []).length, 0, '系统注入不应被丢弃');
        assert.equal((plan.replacements ?? []).length, 0, '系统注入不应被替换');
        for (const f of [0, 1, 2, 3]) {
            assert.ok((plan.retain?.floors ?? []).includes(f), `系统楼层 ${f} 应列为保留原文`);
        }
        // 没有可摘要的聊天内容 → 不排章节摘要任务
        assert.equal(plan.chapters.pending.length, 0);
        assert.equal(plan.chapters.stored, 0);
        // token 账实一致：baseline 覆盖全部消息（含系统注入）
        assert.ok(plan.estimate.baselineTokens > 0);
        assert.ok(plan.estimate.finalTokens >= plan.estimate.baselineTokens - 1,
            '无压缩时 final 不应小于 baseline');
    } finally {
        await ctx.cleanup();
    }
});

test('最近窗口里的系统消息同样受保护（小预算硬压不截断）', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const pairs = [];
        for (let i = 0; i < 12; i += 1) {
            pairs.push([
                `第 ${i} 轮我问掌柜镇上的事。`,
                `第 ${i} 轮掌柜答了几句。`,
            ]);
        }
        const messages = dialogue(pairs, { startFloor: 0 });
        // 系统消息放在最近窗口里（楼层 18）
        messages[18] = msg(18, '【世界书·客栈规矩】住店先付押金，戌时后不待客。', { isSystem: true });
        messages[messages.length - 1] = msg(messages.length - 1, '住店要多少押金？', { isUser: true });
        const plan = await service.plan(planRequest(messages, { contextLimit: 768, outputReserve: 256, tier: 'saving' }));

        const droppedFloors = (plan.drop ?? []).map((d) => d.floorIndex);
        const replacedFloors = (plan.replacements ?? []).map((r) => r.floorIndex);
        assert.ok(!droppedFloors.includes(18), `最近窗口的系统消息不应被丢弃，drop=${JSON.stringify(droppedFloors)}`);
        assert.ok(!replacedFloors.includes(18), '最近窗口的系统消息不应被替换');
        assert.ok((plan.retain?.floors ?? []).includes(18), '应列为保留原文');
    } finally {
        await ctx.cleanup();
    }
});

test('纯对话（无系统消息）行为不变：旧消息照常压缩', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        const pairs = [];
        for (let i = 0; i < 40; i += 1) {
            pairs.push([
                `我向掌柜打听云栖镇的旧事（第 ${i} 次询问）。`,
                `掌柜的放下算盘说起三十年前的码头旧事（第 ${i} 幕）。`,
            ]);
        }
        const messages = dialogue(pairs, { startFloor: 0 });
        messages[messages.length - 1] = msg(messages.length - 1, '沈青崖左手上的旧伤到底是怎么来的？', { isUser: true });
        const plan = await service.plan(planRequest(messages, { contextLimit: 1024, outputReserve: 256, tier: 'saving' }));

        assert.ok(['degraded', 'blocked'].includes(plan.result), `应触发降级，实际 ${plan.result}`);
        assert.ok((plan.drop ?? []).length > 0, '旧消息应被压缩/丢弃');
        assert.ok((plan.injections ?? []).length > 0 || plan.result === 'blocked', '应注入章节摘要');
    } finally {
        await ctx.cleanup();
    }
});
