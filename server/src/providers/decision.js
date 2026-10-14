/**
 * 决策提供者：规则实现（默认）与缓存。
 *
 * 需求 3.3：定义内部 DecisionProvider 接口，规则提供者为默认实现。
 * Jev/模型失败、低置信度或结构错误时自动回退规则计划。
 *
 * 决策输出是受约束的结构：intent / memoryNeeds / compressionLevel /
 * mustKeepIds / canDropIds / confidence / reason。
 * 决策只影响策略（召回与压缩偏好），不能修改事实或删除原文。
 */

import { idempotencyKey } from '../util/ids.js';

export const COMPRESSION_LEVELS = Object.freeze(['none', 'light', 'normal', 'aggressive']);

/**
 * @typedef {{
 *   provider: string,
 *   intent: string,
 *   memoryNeeds: string[],
 *   compressionLevel: string,
 *   mustKeepIds: string[],
 *   canDropIds: string[],
 *   confidence: number,
 *   reason: string,
 *   cached?: boolean,
 * }} Decision
 */

export class RuleDecisionProvider {
    constructor({ logger } = {}) {
        this.id = 'rule';
        this.logger = logger ?? null;
    }

    /**
     * @param {{ query: string, candidates?: Array<object>, budget: object, tier: object,
     *           currentTokens?: number, recentCount?: number }} input
     * @returns {Promise<Decision>}
     */
    async decide(input) {
        const query = input.query ?? '';
        const intent = detectIntent(query);
        const memoryNeeds = [];
        if (/[？?]|什么|为什么|怎么|哪里|谁|何时|什么时候/.test(query)) memoryNeeds.push('facts', 'timeline');
        if (/(之前|上次|以前|曾经|还记得|回忆)/.test(query)) memoryNeeds.push('timeline', 'raw');
        if (/(关系|和.*的|对.*的|好感|信任)/.test(query)) memoryNeeds.push('relations');
        if (/(去哪|前往|地点|地方)/.test(query)) memoryNeeds.push('locations');
        if (!memoryNeeds.length) memoryNeeds.push('recency');

        const pressure = input.currentTokens && input.budget?.availableInput
            ? input.currentTokens / input.budget.availableInput
            : 0;
        let compressionLevel = 'none';
        if (pressure > 0.95) compressionLevel = 'aggressive';
        else if (pressure > 0.8) compressionLevel = 'normal';
        else if (pressure > 0.65) compressionLevel = 'light';

        const mustKeepIds = [];
        const canDropIds = [];
        for (const cand of input.candidates ?? []) {
            if (cand.userLocked) mustKeepIds.push(cand.id ?? cand.memoryId);
            else if ((cand.score ?? 1) < 0.2) canDropIds.push(cand.id ?? cand.memoryId);
        }

        return {
            provider: 'rule',
            intent,
            memoryNeeds,
            compressionLevel,
            mustKeepIds,
            canDropIds,
            confidence: 0.6,
            reason: `规则判断：意图=${intent}，压力=${(pressure * 100).toFixed(0)}%`,
        };
    }
}

export function detectIntent(query) {
    const q = String(query ?? '');
    if (/(总结|回顾|之前发生|梳理|复述)/.test(q)) return 'summary';
    if (/(战斗|攻击|防御|出招|闪避|对决|开战)/.test(q)) return 'combat';
    if (/(状态|属性|等级|生命|装备|背包|金钱)/.test(q)) return 'status';
    if (/(你好|早|晚安|谢谢|哈哈|嗯|哦)/.test(q) && q.length <= 12) return 'smalltalk';
    if (/(去哪|前往|出发|动身|抵达|进入)/.test(q)) return 'travel';
    if (/[？?]/.test(q)) return 'question';
    return 'roleplay';
}

/**
 * 决策缓存：相同 (query, pressure bucket, tier, candidate fingerprint) 复用结果。
 * 需求 3.3：超时等失败时允许使用缓存计划。
 */
export class DecisionCache {
    constructor({ ttlMs = 10 * 60 * 1000, max = 200 } = {}) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.map = new Map();
    }

    key(input) {
        return idempotencyKey({
            q: input.query,
            p: Math.round(((input.currentTokens ?? 0) / (input.budget?.availableInput ?? 1)) * 10),
            tier: input.tier?.id,
            candidates: (input.candidates ?? []).map((c) => c.id ?? c.memoryId).sort(),
        });
    }

    get(input) {
        const k = this.key(input);
        const hit = this.map.get(k);
        if (!hit) return null;
        if (Date.now() - hit.at > this.ttlMs) {
            this.map.delete(k);
            return null;
        }
        return { ...hit.value, cached: true };
    }

    set(input, value) {
        const k = this.key(input);
        this.map.set(k, { at: Date.now(), value });
        if (this.map.size > this.max) {
            const oldest = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (oldest) this.map.delete(oldest[0]);
        }
    }
}

/**
 * 组合决策：主 provider 失败时回退规则提供者，并记录回退原因。
 * @param {{ primary?: { decide: Function, id?: string }, getPrimary?: () => object|null,
 *           fallback: RuleDecisionProvider, cache?: DecisionCache, logger?: object }} opts
 *   `getPrimary`：每次决策时动态解析主提供者（用于 Jev 设置变更后的热重建）；
 *   与静态 `primary` 二选一，同时给出时 getPrimary 优先。
 */
export function createDecisionRouter({ primary, getPrimary, fallback, cache, logger }) {
    const resolvePrimary = () => (getPrimary ? getPrimary() : primary);
    return {
        get id() {
            const active = resolvePrimary();
            return active ? `${active.id ?? 'primary'}+${fallback.id}` : fallback.id;
        },
        async decide(input) {
            const activePrimary = resolvePrimary();
            if (!activePrimary) {
                const decision = await fallback.decide(input);
                if (cache) cache.set(input, decision);
                return decision;
            }
            try {
                const decision = await activePrimary.decide(input);
                validateDecision(decision);
                if ((decision.confidence ?? 0) < 0.35) {
                    throw new Error(`置信度不足（${decision.confidence}）`);
                }
                if (cache) cache.set(input, decision);
                return decision;
            } catch (err) {
                logger?.warn?.('decision.fallback', { provider: activePrimary.id ?? 'primary', error: err.message });
                const cached = cache?.get(input);
                if (cached) return { ...cached, reason: `${cached.reason}（缓存计划，主提供者失败：${err.message}）` };
                const decision = await fallback.decide(input);
                return { ...decision, reason: `${decision.reason}（回退：${err.message}）` };
            }
        },
    };
}

/** schema 校验：拒绝结构错误的外部决策。 */
export function validateDecision(decision) {
    if (!decision || typeof decision !== 'object') throw new Error('决策为空');
    if (!COMPRESSION_LEVELS.includes(decision.compressionLevel)) {
        throw new Error(`compressionLevel 非法：${decision.compressionLevel}`);
    }
    for (const field of ['mustKeepIds', 'canDropIds']) {
        if (decision[field] !== undefined && !Array.isArray(decision[field])) {
            throw new Error(`${field} 必须是数组`);
        }
    }
    if (decision.confidence !== undefined) {
        const c = Number(decision.confidence);
        if (Number.isNaN(c) || c < 0 || c > 1) throw new Error(`confidence 越界：${decision.confidence}`);
    }
    return true;
}
