/**
 * 混合检索：BM25 + 实体 + 时间 + 最近性 + 重要度。
 *
 * 需求 US-03 / 4.3：
 *   - 默认关键词/BM25、实体和时间信号；Embedding 为可选增强（后置）。
 *   - 召回结果必须通过作用域、时间有效期、版本和预算校验。
 *   - 未命中或低置信度的冷记忆不注入请求。
 *
 * 每个召回项都带 score 分解（可解释性），供上下文计划展示“为什么召回”。
 */

import { segmentQuery } from '../util/segment.js';
import { extractTimeSignals } from '../util/text.js';
import { estimateTokensConservative as countTokens } from '../util/tokenizer.js';
import { RECALLABLE_STATUS } from './memory.js';
import { scopeKey, normalizeScope } from './identity.js';

const WEIGHTS = Object.freeze({
    bm25: 0.5,
    entity: 0.2,
    time: 0.1,
    recency: 0.1,
    importance: 0.1,
});

export class Retrieval {
    /** @param {{ data: any, memoryService: any, logger?: object }} opts */
    constructor({ data, memoryService, logger }) {
        this.data = data;
        this.memoryService = memoryService;
        this.logger = logger ?? null;
    }

    /**
     * @param {string} query 当前用户输入（或意图文本）
     * @param {{
     *   scope: string|object, chatId?: string, branchId?: string,
     *   budgetTokens?: number, topK?: number, minScore?: number,
     *   dictionary?: string[], includeRaw?: boolean, now?: Date, includeKinds?: string[],
     * }} ctx
     */
    recall(query, ctx = {}) {
        const started = Date.now();
        const scope = normalizeScope(ctx.scope);
        const topK = ctx.topK ?? 12;
        const minScore = ctx.minScore ?? 0.12;
        const budgetTokens = ctx.budgetTokens ?? 1200;
        const dictionary = ctx.dictionary ?? [];
        const now = ctx.now ?? new Date();

        const terms = segmentQuery(query ?? '', { dictionary });
        if (!terms.length) {
            return { items: [], meta: { terms: 0, candidates: 0, selected: 0, elapsedMs: 0, reason: '空查询' } };
        }

        // 候选按集合分别取配额。
        //
        // 为什么不能对两个集合合并排序后统一取 top-N（旧实现）：
        // 真实聊天的用户消息可能是整章长文（实测 29,866 字符 → 切出 11,473 个词），
        // BM25 的分数是「命中词的 idf 累加」——原始消息（每条几千~几万字）能命中
        // 数千个词，而一条记忆只有几十个字，于是 top-N **被 message_events 全额占据**
        // （实测 64/64）。若 includeRaw=false（planner 的线上路径），这些候选随后
        // 被全部丢弃 → scored=0 → 召回恒为空。实测 500 楼真实语料上定向召回命中率
        // 因此只有 1.2%（与随机基线持平）。
        // 分集合取配额后，记忆条目始终有自己的名额；message_events 只在
        // includeRaw=true 时参与（且同样受配额约束，不会再挤掉记忆）。
        const candLimit = Math.max(60, topK * 8);
        const candidates = [
            ...this.data.search(terms, { limit: candLimit, collection: 'memory_records' }),
            ...(ctx.includeRaw ? this.data.search(terms, { limit: candLimit, collection: 'message_events' }) : []),
        ];
        const timeSignals = extractTimeSignals(query ?? '');
        // BM25 分数必须**按集合分别归一化**：message_events 是长文档（几千~几万字），
        // 命中词多 → 累计分天然比几十字的记忆条目高一到两个数量级
        // （实测 500 楼真实语料：原始消息 7592 vs 记忆 948）。合并归一化会让
        // 记忆的 bm25n 全部被压到 0.1 左右，即使进了候选也过不了 minScore 门槛。
        const maxBm25ByColl = new Map();
        for (const c of candidates) {
            const cur = maxBm25ByColl.get(c.collection) ?? 0;
            if (c.score > cur) maxBm25ByColl.set(c.collection, c.score);
        }

        const scored = [];
        for (const cand of candidates) {
            const record = this.data.get(cand.collection, cand.id);
            if (!record) continue;

            if (cand.collection === 'memory_records') {
                if (!this.#memoryEligible(record, ctx, scope, now)) continue;
            } else if (cand.collection === 'message_events') {
                if (!ctx.includeRaw) continue;
                if (!this.#eventEligible(record, ctx, scope)) continue;
            }

            const text = cand.collection === 'memory_records' ? record.content : record.text;
            const maxBm25 = maxBm25ByColl.get(cand.collection) ?? 0;
            const bm25n = maxBm25 > 0 ? cand.score / maxBm25 : 0;
            const entity = this.#entityScore(query, text, dictionary);
            const time = this.#timeScore(timeSignals, record, text);
            const recency = this.#recencyScore(record, ctx, cand.collection);
            const importance = cand.collection === 'memory_records'
                ? (record.importance ?? 0.5) * (record.userLocked ? 1.5 : 1)
                : 0.4;

            // observed（仅观察到一次）的记忆略降权，confirmed/active 优先
            const statusWeight = cand.collection === 'memory_records' && record.status === 'observed' ? 0.85 : 1;
            const score = (WEIGHTS.bm25 * bm25n
                + WEIGHTS.entity * entity
                + WEIGHTS.time * time
                + WEIGHTS.recency * recency
                + WEIGHTS.importance * Math.min(1, importance)) * statusWeight;

            if (score < minScore) continue;

            scored.push({
                id: record.id,
                collection: cand.collection,
                kind: cand.collection === 'memory_records' ? record.kind : 'raw_message',
                text,
                tokens: countTokens(text),
                score,
                breakdown: { bm25: round3(bm25n), entity: round3(entity), time: round3(time), recency: round3(recency), importance: round3(importance) },
                sourceMessageIds: cand.collection === 'memory_records' ? record.sourceMessageIds : [record.messageId],
                userLocked: Boolean(record.userLocked),
                status: record.status ?? 'raw',
                reason: this.#reason(bm25n, entity, time),
            });
        }

        scored.sort((a, b) => b.score - a.score);

        // 预算裁剪：按分数累加，超出预算的低分项不注入
        const selected = [];
        let used = 0;
        for (const item of scored) {
            if (selected.length >= topK) break;
            if (used + item.tokens > budgetTokens) continue;
            selected.push(item);
            used += item.tokens;
        }

        const meta = {
            terms: terms.length,
            candidates: candidates.length,
            scored: scored.length,
            selected: selected.length,
            tokens: used,
            elapsedMs: Date.now() - started,
            timeSignals,
        };
        this.logger?.debug?.('retrieval.recall', {
            query, selected: selected.length, candidates: candidates.length, elapsedMs: meta.elapsedMs,
        });
        return { items: selected, meta };
    }

    #memoryEligible(record, ctx, scope, now) {
        if (record.invalidated) return false;
        if (!RECALLABLE_STATUS.has(record.status) && !record.userLocked) return false;
        if (ctx.includeKinds && !ctx.includeKinds.includes(record.kind)) return false;
        // 有效期校验：已过期不注入（除非查询明确询问过去——由调用方通过 includeExpired 控制）
        if (record.validTo && record.validTo < now.toISOString() && !ctx.includeExpired) return false;
        if (record.validFrom && record.validFrom > now.toISOString()) return false;
        // 作用域校验
        if (!this.#scopeMatch(record, ctx, scope)) return false;
        // 跨聊天污染防线
        if (record.chatId && ctx.chatId && record.chatId !== ctx.chatId) return false;
        // 分支隔离：派生自分支的记忆只在同分支召回
        if (record.branchId && ctx.branchId && record.branchId !== ctx.branchId) return false;
        // tombstone 校验
        const blocked = this.memoryService.isBlocked(record.scope, {
            hash: record.hash, text: record.content, sourceMessageIds: record.sourceMessageIds,
        });
        if (blocked) return false;
        return true;
    }

    #eventEligible(event, ctx, scope) {
        if (event.kind === 'delete') return false;
        if (!event.text) return false;
        if (ctx.chatId && event.chatId !== ctx.chatId) return false;
        if (ctx.branchId && event.branchId && event.branchId !== ctx.branchId) return false;
        // “不再记忆 / 不再召回”对原文同样生效
        const blocked = this.memoryService.isBlocked(scope.key, {
            text: event.text, sourceMessageIds: [event.messageId],
        });
        if (blocked) return false;
        return true;
    }

    #scopeMatch(record, ctx, scope) {
        if (record.scope === scope.key) return true;
        if (Array.isArray(record.sharedScopes) && record.sharedScopes.includes(scope.key)) return true;
        // 聊天级记忆在分支内可见（但受上面的 branchId 防线约束）
        if (scope.type === 'branch' && record.scope === `chat:${scope.id.split(':')[0]}`) return true;
        return false;
    }

    #entityScore(query, text, dictionary) {
        if (!dictionary.length || !text) return 0;
        let hits = 0;
        let total = 0;
        for (const name of dictionary) {
            if (!name) continue;
            if (query.includes(name)) {
                total += 1;
                if (text.includes(name)) hits += 1;
            }
        }
        return total ? hits / total : 0;
    }

    #timeScore(timeSignals, record, text) {
        if (!timeSignals.length) return 0;
        const inText = timeSignals.filter((s) => text.includes(s)).length;
        const inStructured = record?.structured?.timeSignals
            ? timeSignals.filter((s) => record.structured.timeSignals.includes(s)).length
            : 0;
        const hits = Math.max(inText, inStructured);
        return hits ? Math.min(1, hits / timeSignals.length) : 0;
    }

    #recencyScore(record, ctx, collection) {
        if (collection === 'message_events') {
            const head = ctx.headFloor ?? null;
            if (head === null || record.floorIndex === null || record.floorIndex === undefined) return 0.5;
            const distance = Math.max(0, head - record.floorIndex);
            return 1 / (1 + distance / 50);
        }
        const created = Date.parse(record.createdAt ?? '') || 0;
        if (!created) return 0.3;
        const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
        return 1 / (1 + ageDays / 7);
    }

    #reason(bm25n, entity, time) {
        const parts = [];
        if (bm25n >= 0.5) parts.push('关键词匹配');
        else if (bm25n > 0.1) parts.push('关键词弱匹配');
        if (entity > 0) parts.push('实体命中');
        if (time > 0) parts.push('时间信号命中');
        return parts.join('+') || '低相关';
    }
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

export { scopeKey };
