import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBudget, planBudget, getTier, compressionRatio, needsCompression } from '../src/core/budget.js';
import { estimateTokensConservative as count } from '../src/util/tokenizer.js';

function block(id, text, overrides = {}) {
    return { id, kind: 'raw_message', layer: 'recent', text, tokens: count(text), ...overrides };
}

test('预算计算：可用输入 = 上下文 - 输出预留 - 安全余量', () => {
    const budget = computeBudget({ contextLimit: 8192, outputReserve: 1024, safetyMarginRatio: 0.05, tier: 'balanced' });
    assert.equal(budget.safetyMargin, Math.max(256, Math.round(8192 * 0.05)));
    assert.equal(budget.availableInput, 8192 - 1024 - budget.safetyMargin);
    assert.equal(budget.tier, 'balanced');
    assert.ok(budget.triggerAt < budget.availableInput);
});

test('档位触发阈值：保真 > 均衡 > 节省', () => {
    const base = { contextLimit: 10000, outputReserve: 1000 };
    const fidelity = computeBudget({ ...base, tier: 'fidelity' });
    const balanced = computeBudget({ ...base, tier: 'balanced' });
    const saving = computeBudget({ ...base, tier: 'saving' });
    assert.ok(fidelity.triggerAt > balanced.triggerAt);
    assert.ok(balanced.triggerAt > saving.triggerAt);
});

test('未超预算时：不动任何块，结果为 ok', () => {
    const budget = computeBudget({ contextLimit: 4096, outputReserve: 512 });
    const blocks = [block('a', '短消息一'), block('b', '短消息二')];
    const result = planBudget({ blocks, budget });
    assert.equal(result.result, 'ok');
    assert.equal(result.dropped.length, 0);
    assert.ok(result.finalTokens <= budget.availableInput);
});

test('固定块去重：完全相同的内容只保留一份', () => {
    const budget = computeBudget({ contextLimit: 4096, outputReserve: 512 });
    const text = '这是一段很长的固定提示。'.repeat(20);
    const blocks = [
        block('p1', text, { protected: true, layer: 'fixed' }),
        block('p2', text, { protected: true, layer: 'fixed' }),
    ];
    const result = planBudget({ blocks, budget });
    const dedupeActions = result.actions.filter((a) => a.type === 'dedupe');
    assert.equal(dedupeActions.length, 1);
    assert.equal(result.blocks.length, 1);
});

test('受保护块永不删除：超限时先丢召回与旧内容', () => {
    const budget = computeBudget({ contextLimit: 1500, outputReserve: 300 });
    const protectedText = '系统提示：你是剧情助手。'.repeat(10);
    const blocks = [
        block('sys', protectedText, { protected: true, layer: 'fixed' }),
        block('r1', '召回内容甲'.repeat(30), { layer: 'recall', score: 0.3 }),
        block('r2', '召回内容乙'.repeat(30), { layer: 'recall', score: 0.9 }),
        block('old1', '很老的原文'.repeat(60), { layer: 'old', floorIndex: 1, droppable: true }),
    ];
    const result = planBudget({ blocks, budget });
    assert.ok(result.blocks.some((b) => b.id === 'sys'), '受保护块必须保留');
    assert.ok(result.actions.some((a) => a.type === 'reduce-recall' || a.type === 'truncate-oldest'));
    assert.ok(['degraded', 'blocked'].includes(result.result));
});

test('降级顺序：先丢低分召回，再压缩旧原文', () => {
    const budget = computeBudget({ contextLimit: 1800, outputReserve: 300 });
    const blocks = [
        block('sys', '系统'.repeat(50), { protected: true, layer: 'fixed' }),
        block('r-low', '低相关召回'.repeat(40), { layer: 'recall', score: 0.1 }),
        block('r-high', '高相关召回'.repeat(40), { layer: 'recall', score: 0.95 }),
        block('old', '旧原文内容'.repeat(160), {
            layer: 'old', floorIndex: 1,
            alternatives: [{ text: '旧原文摘要', tokens: count('旧原文摘要'), kind: 'extractive' }],
        }),
    ];
    const result = planBudget({ blocks, budget });
    const types = result.actions.map((a) => a.type);
    assert.ok(types.indexOf('reduce-recall') < types.indexOf('compress-old') || !types.includes('compress-old'));
    // 低分召回应先于高分召回被丢弃
    const droppedIds = result.dropped.map((b) => b.id);
    if (droppedIds.includes('r-low') && droppedIds.includes('r-high')) {
        const lowAction = result.actions.findIndex((a) => a.sourceIds?.includes('r-low') || a.reason?.includes('低相关'));
        assert.ok(lowAction >= 0);
    }
    if (types.includes('compress-old')) {
        const oldBlock = result.blocks.find((b) => b.id === 'old');
        assert.equal(oldBlock.text, '旧原文摘要');
    }
});

test('过期/superseded 事实在超限时被移除', () => {
    const budget = computeBudget({ contextLimit: 2200, outputReserve: 400 });
    const blocks = [
        block('sys', '系统'.repeat(40), { protected: true, layer: 'fixed' }),
        block('stale', '已过期的事实'.repeat(30), { layer: 'recall', status: 'expired' }),
        block('live', '仍然有效的事实'.repeat(30), { layer: 'recall', status: 'active', score: 0.8 }),
    ];
    const result = planBudget({ blocks, budget });
    assert.ok(result.dropped.some((b) => b.id === 'stale'));
    assert.ok(result.actions.some((a) => a.type === 'drop-stale'));
});

test('无法满足硬预算时：结果 blocked 且给出修复动作', () => {
    const budget = computeBudget({ contextLimit: 1200, outputReserve: 512 });
    const huge = '这条固定内容本身就远超上下文上限。'.repeat(200);
    const blocks = [block('sys', huge, { protected: true, layer: 'fixed' })];
    const result = planBudget({ blocks, budget });
    assert.equal(result.result, 'blocked');
    assert.ok(result.blockReason);
    assert.ok(result.fixActions.length >= 2);
    assert.ok(result.overshoot > 0);
});

test('合并摘要：多个摘要块在超限时合并为一个', () => {
    const budget = computeBudget({ contextLimit: 1600, outputReserve: 300 });
    const merged = { text: '合并后的摘要（逐句摘录）', tokens: count('合并后的摘要（逐句摘录）'), kind: 'merged' };
    const blocks = [
        block('sys', '系统'.repeat(40), { protected: true, layer: 'fixed' }),
        block('s1', '第一章摘要内容'.repeat(40), { layer: 'summary', floorIndex: 0, alternatives: [merged] }),
        block('s2', '第二章摘要内容'.repeat(40), { layer: 'summary', floorIndex: 40, alternatives: [merged] }),
    ];
    const result = planBudget({ blocks, budget });
    assert.ok(result.actions.some((a) => a.type === 'merge-summaries'));
    const summaryBlocks = result.blocks.filter((b) => b.layer === 'summary');
    assert.equal(summaryBlocks.length, 1);
    assert.equal(summaryBlocks[0].text, merged.text);
});

test('压缩率与触发判断', () => {
    assert.equal(compressionRatio(1000, 400), 0.6);
    assert.equal(compressionRatio(0, 0), 0);
    const budget = computeBudget({ contextLimit: 4096, outputReserve: 512, tier: 'balanced' });
    assert.equal(needsCompression(budget.triggerAt + 1, budget), true);
    assert.equal(needsCompression(budget.triggerAt - 1, budget), false);
});

test('档位参数存在且顺序正确', () => {
    assert.ok(getTier('fidelity').recallTopK > getTier('saving').recallTopK);
    assert.equal(getTier('unknown').id, 'balanced');
});

test('档位触发线：未越硬预算但越过触发线时，也要压回触发线以下（D6）', () => {
    const budget = computeBudget({ contextLimit: 4096, outputReserve: 512, safetyMarginRatio: 0.05, tier: 'balanced' });
    // 可用 3328；均衡档触发线 = 75% ≈ 2496
    assert.equal(budget.availableInput, 3328);
    assert.equal(budget.triggerAt, 2496);

    // 6 块旧原文，每块 500 tokens（合计 3000）：超过触发线，但尚未越硬预算
    const blocks = Array.from({ length: 6 }, (_, i) => block(`old${i}`, `旧原文占位 ${i}`, {
        layer: 'old',
        tokens: 500,
        floorIndex: i,
        alternatives: [{ text: `章节摘要 ${i}`, tokens: 100, kind: 'extractive', label: 'chapter-summary' }],
    }));

    const result = planBudget({ blocks, budget });

    assert.equal(result.triggered, true, '应识别为越过触发线');
    assert.equal(result.hardExceeded, false, '本场景不应越硬预算');
    assert.equal(result.result, 'degraded', '越过触发线即应产生降级动作');
    assert.ok(result.actions.some((a) => a.type === 'compress-old'), '应压缩最老原文');
    assert.ok(result.finalTokens <= budget.triggerAt,
        `压缩后应回到触发线以下（${result.finalTokens} > ${budget.triggerAt}）`);
});

test('档位触发线：未越过触发线时保持原样', () => {
    const budget = computeBudget({ contextLimit: 4096, outputReserve: 512, safetyMarginRatio: 0.05, tier: 'balanced' });
    const total = budget.triggerAt - 100; // 刚好在触发线下方
    const blocks = [block('a', '旧原文', {
        layer: 'old', tokens: total, floorIndex: 0,
        alternatives: [{ text: '摘要', tokens: 50, kind: 'extractive', label: 'chapter-summary' }],
    })];
    const result = planBudget({ blocks, budget });
    assert.equal(result.triggered, false);
    assert.equal(result.result, 'ok');
    assert.equal(result.actions.length, 0);
});

test('召回保底配额：超长聊天里最高分召回不会被整块丢光（D31）', () => {
    // 回归：旧实现步骤 3 会在「超过档位触发线」时把**全部**召回块丢掉。
    // 几千楼的聊天长期处于超预算状态，结果是「记忆抽了却永远用不上」。
    // 现在给最高分的几条留一个配额下限（tier.recallFloorRatio）。
    const budget = computeBudget({ contextLimit: 32000, outputReserve: 3200, tier: 'balanced' });
    const tier = getTier('balanced');
    const quota = Math.round(budget.availableInput * tier.recallFloorRatio);
    const each = Math.round(quota * 0.7); // 单条占配额 70% → 只放得下一条

    const blocks = [
        block('sys', '系统提示', { protected: true, layer: 'fixed', tokens: 200 }),
        ...Array.from({ length: 30 }, (_, i) => block(`old${i}`, `旧原文${i}`, {
            layer: 'old',
            floorIndex: i * 40,
            tokens: 2000,
            alternatives: [{ text: `摘要${i}`, tokens: 100, kind: 'extractive' }],
        })),
        block('r-low', '低相关召回', { layer: 'recall', score: 0.2, tokens: each }),
        block('r-high', '高相关召回', { layer: 'recall', score: 0.95, tokens: each }),
    ];

    const result = planBudget({ blocks, budget });
    const kept = result.blocks.map((b) => b.id);

    assert.ok(result.actions.some((a) => a.type === 'reduce-recall'),
        '本用例前提是确实发生过召回裁剪，否则测不到配额');
    assert.ok(kept.includes('r-high'),
        `最高分召回应被保底保留（实际保留：${kept.join(', ')}）`);
    assert.ok(!kept.includes('r-low'), '低分召回仍应被丢弃');
    assert.notEqual(result.result, 'blocked', '配额不得让计划变成 blocked');
    assert.ok(result.finalTokens <= budget.availableInput, '最终仍须落在硬预算内');
});

test('召回配额不凌驾于硬预算：装不下时仍会丢弃（避免 blocked）', () => {
    const budget = computeBudget({ contextLimit: 2000, outputReserve: 400, tier: 'balanced' });
    const blocks = [
        block('sys', '系统提示'.repeat(20), { protected: true, layer: 'fixed' }),
        block('r1', '召回内容'.repeat(200), { layer: 'recall', score: 0.9 }),
        block('r2', '召回内容二'.repeat(200), { layer: 'recall', score: 0.8 }),
    ];
    const result = planBudget({ blocks, budget });
    assert.ok(result.finalTokens <= budget.availableInput,
        `最终必须落在硬预算内（finalTokens=${result.finalTokens}, limit=${budget.availableInput}）`);
});
