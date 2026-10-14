/**
 * 预算规划器：把上下文块装进可用输入预算，超限时按固定梯度降级。
 *
 * 需求 4.4 降级顺序：
 *   去重固定块 → 移除过期或已 supersedes 的事实 → 减少低相关召回
 *   → 压缩最老原文 → 合并摘要 → 可选高压缩 → 截断最老可丢弃内容
 *   → 仍超限则明确阻止发送
 *
 * 硬约束：
 *   - protected 块（系统提示、预设、卡牌、世界书只读规则、用户最新输入、
 *     用户锁定事实）永远不删除、不截断；
 *   - 任何降级动作都记录 reason / sourceIds / 节省 token，保证可解释；
 *   - 结果区分 ok / degraded / blocked，blocked 时携带修复动作。
 */

import { contentFingerprint } from '../util/ids.js';
import { truncateToTokens } from '../util/text.js';
import { estimateTokensConservative as countTokens } from '../util/tokenizer.js';

export const TIERS = Object.freeze({
    fidelity: {
        id: 'fidelity',
        name: '保真优先',
        triggerRatio: 0.85,
        recallTopK: 16,
        recentFloorMin: 12,
        summaryTargetRatio: 0.22,
        allowHighCompress: false,
        // 召回保底配额（占 availableInput 的比例）。
        // 超长聊天里上下文会长期处于「超预算」状态，若把召回整块丢光，
        // 用户会看到「记忆明明抽出来了却从不被用上」。这里给最高分的几条
        // 召回留一个下限，让定向回忆始终有一席之地。
        recallFloorRatio: 0.06,
    },
    balanced: {
        id: 'balanced',
        name: '均衡',
        triggerRatio: 0.75,
        recallTopK: 10,
        recentFloorMin: 8,
        summaryTargetRatio: 0.18,
        allowHighCompress: false,
        recallFloorRatio: 0.04,
    },
    saving: {
        id: 'saving',
        name: '节省用量',
        triggerRatio: 0.6,
        recallTopK: 6,
        recentFloorMin: 5,
        summaryTargetRatio: 0.14,
        allowHighCompress: false,
        recallFloorRatio: 0.02,
    },
});

export function getTier(id, customOverride = null) {
    if (id === 'custom') {
        // 自定义档：以均衡档为基底，叠加用户设置的字段（白名单 + 夹取，非法值回退均衡默认）
        if (!customOverride || typeof customOverride !== 'object') return { ...TIERS.balanced, id: 'custom', name: '自定义' };
        const base = TIERS.balanced;
        const num = (v, lo, hi, fallback) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
        };
        return {
            id: 'custom',
            name: '自定义',
            triggerRatio: num(customOverride.triggerRatio, 0.3, 0.95, base.triggerRatio),
            recallTopK: Math.round(num(customOverride.recallTopK, 0, 32, base.recallTopK)),
            recallFloorRatio: num(customOverride.recallFloorRatio, 0, 0.2, base.recallFloorRatio),
            summaryTargetRatio: num(customOverride.summaryTargetRatio, 0.02, 0.5, base.summaryTargetRatio),
            recentFloorMin: Math.round(num(customOverride.recentFloorMin, 0, 50, base.recentFloorMin)),
            recentFloorMax: Math.round(num(customOverride.recentFloorMax ?? base.recentFloorMax, 2, 200, base.recentFloorMax ?? 40)),
            allowHighCompress: Boolean(customOverride.allowHighCompress ?? base.allowHighCompress),
        };
    }
    return TIERS[id] ?? TIERS.balanced;
}

/**
 * 计算预算。
 * @param {{ contextLimit: number, outputReserve?: number, safetyMarginRatio?: number, tier?: string }} input
 */
export function computeBudget(input) {
    const contextLimit = Math.max(256, Number(input.contextLimit) || 4096);
    const outputReserve = Math.max(128, Number(input.outputReserve) || 512);
    const ratio = input.safetyMarginRatio ?? 0.05;
    const safetyMargin = Math.max(256, Math.round(contextLimit * ratio));
    const availableInput = Math.max(128, contextLimit - outputReserve - safetyMargin);
    const tier = getTier(input.tier, input.tierOverride);
    return {
        contextLimit,
        outputReserve,
        safetyMargin,
        availableInput,
        tier: tier.id,
        tierName: tier.name,
        triggerAt: Math.round(availableInput * tier.triggerRatio),
    };
}

/**
 * 预算编排。
 *
 * @param {{
 *   blocks: Array<{
 *     id: string, kind: string, text: string, tokens?: number,
 *     priority?: number, protected?: boolean, droppable?: boolean,
 *     layer?: 'fixed'|'recent'|'recall'|'summary'|'old',
 *     alternatives?: Array<{ text: string, tokens?: number, kind?: string, label?: string }>,
 *     sourceIds?: string[], reason?: string, score?: number,
 *     status?: string, floorIndex?: number,
 *   }>,
 *   budget: ReturnType<typeof computeBudget>,
 *   tier?: object,
 * }} input
 */
export function planBudget(input) {
    const budget = input.budget;
    const tier = input.tier ?? getTier(budget.tier, input.tierOverride);
    const actions = [];
    const limit = budget.availableInput;
    // 触发线：档位决定「用掉多少可用预算就开始压缩」（保真 0.85 / 均衡 0.75 / 节省 0.6）。
    // 需求 US-02 要求达到该区间即触发；此前实现只在越过硬预算时才降级。
    const triggerAt = Math.min(budget.triggerAt ?? limit, limit);

    // 归一化：计算 tokens、继承保护标记
    let state = input.blocks.map((b) => ({
        ...b,
        tokens: b.tokens ?? countTokens(b.text ?? ''),
        protected: Boolean(b.protected),
        droppable: b.droppable ?? !b.protected,
        dropped: false,
        truncated: false,
        replacedBy: null,
        text: b.text ?? '',
    }));

    const totalTokens = () => state.reduce((acc, b) => acc + (b.dropped ? 0 : b.tokens), 0);
    /** 越过硬预算：必须继续降级，否则会截断。 */
    const over = () => totalTokens() > limit;
    /**
     * 越过档位触发线：轻量降级（去召回 / 压最老原文 / 合并摘要）的边界，
     * 压到回到触发线以下即停，从而把上下文稳定维持在档位设定的水位。
     */
    const pressured = () => totalTokens() > triggerAt;
    /** 计划开始时的上下文规模（降级前）。 */
    const baselineTokens = input.blocks.reduce((acc, b) => acc + (b.tokens ?? countTokens(b.text ?? '')), 0);

    // 步骤 1：去重固定块（内容完全相同的块只保留一份，优先保留 protected）
    {
        const seen = new Map();
        for (const block of state) {
            const key = contentFingerprint(block.text);
            if (!block.text) continue;
            const prev = seen.get(key);
            if (prev && !prev.dropped) {
                if (block.protected && !prev.protected) {
                    prev.dropped = true;
                    actions.push(makeAction('dedupe', '与受保护块重复，保留受保护版本', [prev.id], prev.tokens, 0));
                    seen.set(key, block);
                } else {
                    block.dropped = true;
                    actions.push(makeAction('dedupe', '内容与已有块完全重复', [block.id], block.tokens, 0));
                }
            } else {
                seen.set(key, block);
            }
        }
    }

    // 步骤 2：移除过期 / superseded 的事实块
    {
        for (const block of state) {
            if (block.dropped || block.protected) continue;
            if (block.status === 'expired' || block.status === 'superseded' || block.status === 'archived') {
                block.dropped = true;
                actions.push(makeAction('drop-stale', `事实状态为 ${block.status}`, block.sourceIds ?? [block.id], block.tokens, 0));
            }
        }
    }

    // 步骤 3：减少低相关召回（按分数从低到高丢弃），但**保底保留一小段配额**。
    //
    // 为什么不整块丢光：超长聊天（几千楼）的上下文会长期越过档位触发线，
    // 而召回块是这一步唯一的牺牲品 —— 结果是「记忆抽了却永远用不上」。
    // 这里先把最高分、且总量不超过 recallFloorRatio 的几条划为保留集，
    // 再从低分往高分丢，直到回到触发线以下（或只剩保留集）。
    // 注意：硬预算（over()）仍由步骤 7 兜底，配额不凌驾于硬上限之上。
    if (pressured()) {
        const recall = state
            .filter((b) => !b.dropped && !b.protected && b.layer === 'recall')
            .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
        const quota = Math.max(0, Math.round(limit * (tier.recallFloorRatio ?? 0)));
        // recall 已按分数升序 → 从尾部（最高分）往前累计，得到保留集
        const keep = new Set();
        let keptTokens = 0;
        for (let i = recall.length - 1; i >= 0; i -= 1) {
            const block = recall[i];
            if (keptTokens + block.tokens > quota) break;
            keep.add(block.id);
            keptTokens += block.tokens;
        }
        for (const block of recall) {
            if (keep.has(block.id)) continue;
            if (!pressured()) break;
            block.dropped = true;
            actions.push(makeAction('reduce-recall', `低相关召回（分数 ${(block.score ?? 0).toFixed(2)}）`, block.sourceIds ?? [block.id], block.tokens, 0));
        }
    }

    // 步骤 4：压缩最老原文（使用 alternatives 中的摘要替代）
    if (pressured()) {
        const oldRaw = state
            .filter((b) => !b.dropped && !b.protected && b.layer === 'old' && b.alternatives?.length)
            .sort((a, b) => (a.floorIndex ?? 0) - (b.floorIndex ?? 0));
        for (const block of oldRaw) {
            if (!pressured()) break;
            const alt = block.alternatives[0];
            const altTokens = alt.tokens ?? countTokens(alt.text ?? '');
            const saved = block.tokens - altTokens;
            if (saved <= 0) continue;
            block.replacedBy = alt.label ?? 'summary';
            block.text = alt.text;
            block.tokens = altTokens;
            actions.push(makeAction('compress-old', `最老原文压缩为${alt.kind === 'extractive' ? '抽取式' : ''}摘要`, block.sourceIds ?? [block.id], block.tokens + saved, block.tokens));
        }
    }

    // 步骤 5：合并摘要（使用预计算的 merged 摘要替代多个摘要块）
    if (pressured()) {
        const summaryBlocks = state
            .filter((b) => !b.dropped && !b.protected && b.layer === 'summary' && b.alternatives?.length)
            .sort((a, b) => (a.floorIndex ?? 0) - (b.floorIndex ?? 0));
        if (summaryBlocks.length > 1) {
            const merged = summaryBlocks[0].alternatives[0];
            const mergedTokens = merged.tokens ?? countTokens(merged.text ?? '');
            let before = 0;
            for (const b of summaryBlocks) before += b.tokens;
            if (mergedTokens < before) {
                for (let i = 0; i < summaryBlocks.length; i += 1) {
                    const block = summaryBlocks[i];
                    if (i === 0) {
                        block.text = merged.text;
                        block.tokens = mergedTokens;
                        block.replacedBy = 'merged-summary';
                        block.sourceIds = summaryBlocks.flatMap((b) => b.sourceIds ?? []);
                    } else {
                        block.dropped = true;
                    }
                }
                actions.push(makeAction(
                    'merge-summaries',
                    `合并 ${summaryBlocks.length} 条章节摘要`,
                    summaryBlocks.flatMap((b) => b.sourceIds ?? []),
                    before,
                    mergedTokens,
                ));
            }
        }
    }

    // 步骤 6：可选高压缩（首版未启用，记录为不可用以保证梯度完整）
    if (over() && !tier.allowHighCompress) {
        actions.push(makeAction('high-compress', '高压缩档位未启用（LLMLingua 为后置可选）', [], totalTokens(), totalTokens()));
    }

    // 步骤 7：截断最老可丢弃内容
    if (over()) {
        // 丢弃优先级：最老原文 → 章节摘要 → 最近原文（楼层从老到新）→ 召回（分数从低到高）→ 用户锚点最后
        const rank = (b) => {
            if (b.layer === 'old') return 0;
            if (b.layer === 'summary') return 1;
            if (b.layer === 'recent') return 2;
            if (b.kind === 'anchor') return 4;
            return 3;
        };
        const discardable = state
            .filter((b) => !b.dropped && !b.protected && b.droppable)
            .sort((a, b) => (rank(a) - rank(b))
                || ((a.floorIndex ?? 0) - (b.floorIndex ?? 0))
                || ((a.score ?? 0) - (b.score ?? 0)));
        for (const block of discardable) {
            if (!over()) break;
            const excess = totalTokens() - limit;
            const keepTokens = Math.max(0, block.tokens - excess - 16);
            if (keepTokens <= 8) {
                block.dropped = true;
                actions.push(makeAction('truncate-oldest', '截断最老可丢弃内容（整块移除）', block.sourceIds ?? [block.id], block.tokens, 0));
            } else {
                const before = block.tokens;
                const truncatedText = truncateToTokens(block.text, keepTokens, countTokens);
                block.text = `${truncatedText}…`;
                block.tokens = countTokens(block.text);
                block.truncated = true;
                actions.push(makeAction('truncate-oldest', '截断最老可丢弃内容（保留片段）', block.sourceIds ?? [block.id], before, block.tokens));
            }
        }
    }

    const finalTokens = totalTokens();
    const kept = state.filter((b) => !b.dropped);
    const dropped = state.filter((b) => b.dropped);
    const result = finalTokens > limit ? 'blocked' : (actions.some((a) => a.savedTokens > 0) ? 'degraded' : 'ok');

    return {
        result,
        blocks: kept,
        dropped,
        actions,
        finalTokens,
        limit,
        triggerAt,
        baselineTokens,
        // 诊断用：本轮是被档位触发线推动的，还是越过了硬预算
        triggered: baselineTokens > triggerAt,
        hardExceeded: baselineTokens > limit,
        savedTokens: Math.max(0, baselineTokens - finalTokens),
        blockReason: result === 'blocked'
            ? `即使移除所有可丢弃内容仍超出硬预算（需要 ${finalTokens}，可用 ${limit}）`
            : null,
        fixActions: result === 'blocked'
            ? [
                '减少固定块：检查预设/世界书注入是否过长',
                '降低目标档位到“节省用量”',
                '提高模型上下文上限或减少输出预留',
                '在记忆中心清理不再需要的大段世界书/预设注入',
            ]
            : [],
        overshoot: Math.max(0, finalTokens - limit),
    };
}

function makeAction(type, reason, sourceIds, tokensBefore, tokensAfter) {
    return {
        type,
        reason,
        sourceIds: sourceIds ?? [],
        tokensBefore,
        tokensAfter,
        savedTokens: Math.max(0, tokensBefore - tokensAfter),
    };
}

/** 计划是否处于压缩触发区间（需求 US-02：70%~80% 默认区间，受档位影响）。 */
export function needsCompression(currentTokens, budget) {
    return currentTokens > budget.triggerAt;
}

export function compressionRatio(before, after) {
    if (!before) return 0;
    return Math.max(0, (before - after) / before);
}
