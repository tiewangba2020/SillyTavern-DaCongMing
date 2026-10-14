/**
 * TypeSafe Jev Provider（可选门控）。
 *
 * 需求 3.3：
 *   1. 一次请求并行提出窄问题：本轮意图、记忆类型、重要度、是否需要召回、
 *      压缩等级和冲突风险；
 *   2. 输入只包含当前消息、最近窗口、候选元数据、卡牌/预设摘要和剩余预算，
 *      不发送完整历史；
 *   3. 输出必须通过 schema 校验、置信度阈值、作用域校验和 token 预算校验；
 *   4. 超时、429、额度耗尽、低置信度和结构错误自动回退规则计划；
 *   5. 记录输入/输出 token、耗时、最终动作和用户撤销结果；无净收益时自动降频/停用。
 *
 * 本 Provider 只做判断，不生成摘要、不修改事实、不删除证据。
 */

import { idempotencyKey } from '../util/ids.js';
import { validateDecision, COMPRESSION_LEVELS } from './decision.js';

export class JevError extends Error {
    constructor(message, { code = 'JEV_ERROR', status = null } = {}) {
        super(message);
        this.name = 'JevError';
        this.code = code;
        this.status = status;
    }
}

const INTENT_OPTIONS = ['roleplay', 'question', 'combat', 'summary', 'status', 'travel', 'smalltalk'];
const NEEDS_OPTIONS = ['recency', 'facts', 'timeline', 'relations', 'locations', 'raw'];

/**
 * 问题指令（提示词）两套变体，供对比实验与后续调优。
 * 结构对齐 TypeSafe 官方 API：choice = instructions + criteria；score = 量规（criteria 数组，
 * 分值 0..N-1，两档即 0~1）；noul = 是非概率（0~1）。
 * 每条 instructions 只问一件事（官方建议：原子问题），判断标准写进 criteria 描述。
 */
export const JEV_INSTRUCTIONS = {
    // V1 简洁：最短指令 + 一句话 criteria
    v1: {
        intent: {
            instructions: '这条用户输入的主要意图是什么？',
            criteria: {
                roleplay: '推进剧情或角色的对话行动',
                question: '向角色或系统询问信息',
                combat: '战斗或对抗行动',
                summary: '要求总结或回顾',
                status: '查询或修改状态（属性/物品/时间）',
                travel: '移动、前往或切换场景',
                smalltalk: '闲聊、寒暄或无关推进的内容',
            },
        },
        memoryNeed: {
            instructions: '本轮最需要哪类记忆支持？',
            criteria: {
                recency: '最近的上下文即可',
                facts: '具体事实（人物/物品/设定）',
                timeline: '时间线或事件顺序',
                relations: '人物关系与态度',
                locations: '地点与场景信息',
                raw: '需要原文细节',
            },
        },
        compressionLevel: {
            instructions: '本轮上下文压缩该多激进？',
            criteria: {
                none: '保持原样不压缩',
                light: '轻度压缩，保留大部分细节',
                balanced: '常规压缩',
                aggressive: '预算紧张，大幅压缩',
            },
        },
        needsRecall: { instructions: '回答这轮输入需要从长期记忆召回历史信息吗？' },
        conflictRisk: {
            instructions: '这轮内容与已有记忆冲突的风险？',
            criteria: ['低：与已知信息一致或中立', '高：疑似与已知事实矛盾'],
        },
        importance: {
            instructions: '这轮内容对长期记忆的重要度？',
            criteria: ['低：日常过渡，不值得长期记住', '高：关键情节/事实/转折'],
        },
    },
    // V2 精调：面向中文角色扮演长聊场景，写明判断标准与边界
    v2: {
        intent: {
            instructions: '判断这条用户输入在角色扮演会话中的主导意图。只看输入本身表达了什么，不要推测后续。混合意图时选占比最大的一项。',
            criteria: {
                roleplay: '以角色身份行动、对话、推进剧情（含描写）',
                question: '打破扮演，向角色/系统/作者询问信息或规则',
                combat: '发起或继续战斗、逃跑、对抗等冲突行动',
                summary: '明确要求总结前文、回顾剧情或整理状态',
                status: '查询/修改数值化状态：属性、物品栏、金钱、日期时间',
                travel: '切换场景、赶路、进出地点（纯位置移动）',
                smalltalk: '与剧情无关的闲聊、OOC、寒暄、测试输入',
            },
        },
        memoryNeed: {
            instructions: '为生成这轮的回复，最需要哪一类已有记忆？只选最关键的一类。',
            criteria: {
                recency: '答案就在最近几楼里，不需要更早的记忆',
                facts: '需要具体事实：人物特征、物品、设定、约定',
                timeline: '需要事件先后顺序或时间跨度',
                relations: '需要人物关系、立场、好感/信任变化',
                locations: '需要地点、方位、场景布局',
                raw: '需要某段原文的逐字细节',
            },
        },
        compressionLevel: {
            instructions: '根据剩余预算与输入的信息密度，选择本轮的压缩档位。',
            criteria: {
                none: '预算充裕且输入信息密度高，不压缩',
                light: '预算尚可，只压最旧最冗余的部分',
                balanced: '预算中等，常规梯度压缩',
                aggressive: '预算紧张或当前输入与旧文相关性低，大幅压缩',
            },
        },
        needsRecall: { instructions: '要正确回复这轮输入，是否必须用到「最近窗口之外」的历史信息？（0=最近上下文足够，1=必须召回更早的记忆）' },
        conflictRisk: {
            instructions: '这轮输入引入的新信息与用户已有记忆/设定冲突的风险有多大？',
            criteria: ['低：新信息与已知一致、中立或纯行动', '高：新信息疑似推翻已知事实（改名、复活、换物、时间倒流等）'],
        },
        importance: {
            instructions: '这轮输入承载的信息对「很多轮之后仍然被记住」的价值？',
            criteria: ['低：过渡、重复、闲聊，几轮后无需记住', '高：新事实/伏笔/关系变化/重大决定，值得长期记忆'],
        },
    },
};

export class TypeSafeJevProvider {
    /**
     * @param {{ endpoint: string, apiKey?: string, timeoutMs?: number, fetchImpl?: Function,
     *           logger?: object, minConfidence?: number, model?: string,
     *           instructionsSet?: 'v1'|'v2' }} opts
     */
    constructor(opts) {
        this.endpoint = opts.endpoint;
        this.apiKey = opts.apiKey ?? null;
        this.timeoutMs = opts.timeoutMs ?? 8000;
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        this.logger = opts.logger ?? null;
        this.minConfidence = opts.minConfidence ?? 0.4;
        // TypeSafe 官方模型名（console.typesafe.ai 签发的 key + api.typesafe.ai/v1/systemone）
        this.model = opts.model ?? 'jev-latest';
        this.instructions = JEV_INSTRUCTIONS[opts.instructionsSet ?? 'v1'] ?? JEV_INSTRUCTIONS.v1;
        this.instructionsSet = opts.instructionsSet ?? 'v1';
        this.id = 'jev';
        this._consecutiveFailures = 0;
        this._disabledUntil = 0;
    }

    available() {
        return Boolean(this.endpoint) && Date.now() >= this._disabledUntil;
    }

    /**
     * @param {{ query: string, recentMessages?: Array<{role:string,text:string}>,
     *           candidates?: Array<object>, cardSummary?: string, presetSummary?: string,
     *           budget: object, tier: object, scope?: string }} input
     */
    async decide(input) {
        if (!this.available()) throw new JevError('Jev 已临时停用（连续失败或未配置）', { code: 'JEV_DISABLED' });

        const state = {
            currentMessage: truncate(input.query, 800),
            recentWindow: (input.recentMessages ?? []).slice(-4).map((m) => ({
                role: m.role, text: truncate(m.text, 300),
            })),
            candidateMemories: (input.candidates ?? []).slice(0, 12).map((c) => ({
                id: c.id ?? c.memoryId, kind: c.kind, title: truncate(c.text ?? '', 80), source: c.reason,
            })),
            cardSummary: truncate(input.cardSummary ?? '', 400),
            presetSummary: truncate(input.presetSummary ?? '', 200),
            remainingBudget: Math.max(0, (input.budget?.availableInput ?? 0) - (input.currentTokens ?? 0)),
        };
        const questions = {
            intent: {
                type: 'choice',
                instructions: this.instructions.intent.instructions,
                criteria: this.instructions.intent.criteria,
            },
            memoryNeed: {
                type: 'choice',
                instructions: this.instructions.memoryNeed.instructions,
                criteria: this.instructions.memoryNeed.criteria,
            },
            compressionLevel: {
                type: 'choice',
                instructions: this.instructions.compressionLevel.instructions,
                criteria: this.instructions.compressionLevel.criteria,
            },
            needsRecall: {
                type: 'noul',
                instructions: this.instructions.needsRecall.instructions,
            },
            conflictRisk: {
                type: 'score',
                instructions: this.instructions.conflictRisk.instructions,
                criteria: this.instructions.conflictRisk.criteria,
            },
            importance: {
                type: 'score',
                instructions: this.instructions.importance.instructions,
                criteria: this.instructions.importance.criteria,
            },
        };

        const startedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({ model: this.model, state, questions }),
                signal: controller.signal,
            });
        } catch (err) {
            this.#recordFailure();
            throw new JevError(
                err.name === 'AbortError' ? `Jev 超时（${this.timeoutMs}ms）` : `Jev 请求失败：${err.message}`,
                { code: err.name === 'AbortError' ? 'JEV_TIMEOUT' : 'JEV_NETWORK' },
            );
        } finally {
            clearTimeout(timer);
        }

        if (response.status === 429) {
            this.#recordFailure();
            throw new JevError('Jev 限流（429）', { code: 'JEV_429', status: 429 });
        }
        if (response.status === 402 || response.status === 403) {
            this.#recordFailure();
            throw new JevError(`Jev 额度/权限问题（${response.status}）`, { code: 'JEV_QUOTA', status: response.status });
        }
        if (!response.ok) {
            this.#recordFailure();
            throw new JevError(`Jev 返回错误状态 ${response.status}`, { code: 'JEV_STATUS', status: response.status });
        }

        let payload;
        try {
            payload = await response.json();
        } catch (err) {
            this.#recordFailure();
            throw new JevError(`Jev 返回非 JSON：${err.message}`, { code: 'JEV_SCHEMA' });
        }

        const elapsedMs = Date.now() - startedAt;
        let decision;
        try {
            decision = this.#validateAndMap(payload);
        } catch (err) {
            this.#recordFailure();
            this.#logCall({ input, elapsedMs, ok: false, error: err.message });
            throw err;
        }

        if (decision.confidence < this.minConfidence) {
            this.#logCall({ input, elapsedMs, ok: false, error: `低置信度 ${decision.confidence}` });
            throw new JevError(`Jev 置信度不足（${decision.confidence}）`, { code: 'JEV_LOW_CONFIDENCE' });
        }

        this._consecutiveFailures = 0;
        this.#logCall({ input, elapsedMs, ok: true, decision });
        return decision;
    }

    #validateAndMap(payload) {
        const answers = payload?.answers;
        if (!answers || typeof answers !== 'object') {
            throw new JevError('Jev 响应缺少 answers 字段', { code: 'JEV_SCHEMA' });
        }
        const pick = (id) => answers[id] ?? null;

        // 官方 answer 结构：choice → {type:'choice',choice,confidence,probabilities}；
        // score → {type:'score',score,confidence,legend,probabilities}；noul → {type:'noul',noul}
        const intent = pick('intent');
        if (intent?.choice && !INTENT_OPTIONS.includes(intent.choice)) {
            throw new JevError(`intent 非法选项：${intent.choice}`, { code: 'JEV_SCHEMA' });
        }
        const compression = pick('compressionLevel');
        if (compression?.choice && !COMPRESSION_LEVELS.includes(compression.choice)) {
            throw new JevError(`compressionLevel 非法选项：${compression.choice}`, { code: 'JEV_SCHEMA' });
        }
        const need = pick('memoryNeed');
        const memoryNeeds = (typeof need?.choice === 'string' && NEEDS_OPTIONS.includes(need.choice))
            ? [need.choice]
            : [];

        // score 为量规分（本插件量规均为两档 → 0~1），越界按饱和处理
        const needsRecall = clamp01(pick('needsRecall')?.noul ?? pick('needsRecall')?.probability ?? 0.5);
        const conflictRisk = clamp01(pick('conflictRisk')?.score ?? 0);
        const importance = clamp01(pick('importance')?.score ?? 0);
        const confidence = clamp01(
            intent?.confidence ?? compression?.confidence ?? need?.confidence ?? 0.5,
        );

        const decision = {
            provider: 'jev',
            intent: intent?.choice ?? 'roleplay',
            memoryNeeds: memoryNeeds.length ? memoryNeeds : ['recency'],
            compressionLevel: compression?.choice ?? 'none',
            mustKeepIds: [],
            canDropIds: needsRecall < 0.3 ? (this._lastCandidateIds ?? []) : [],
            conflictRisk,
            importance,
            confidence,
            reason: `Jev(${this.instructionsSet}) 判断：意图=${intent?.choice ?? '?'}，压缩=${compression?.choice ?? '?'}，` +
                `召回需求=${needsRecall.toFixed(2)}，重要度=${importance.toFixed(2)}，冲突风险=${conflictRisk.toFixed(2)}`,
        };
        validateDecision(decision);
        return decision;
    }

    #recordFailure() {
        this._consecutiveFailures += 1;
        if (this._consecutiveFailures >= 3) {
            this._disabledUntil = Date.now() + 5 * 60 * 1000;
            this.logger?.warn?.('jev.auto_disabled', {
                failures: this._consecutiveFailures, retryAt: new Date(this._disabledUntil).toISOString(),
            });
        }
    }

    #logCall({ input, elapsedMs, ok, decision, error }) {
        const record = {
            id: idempotencyKey({ at: Date.now(), q: input.query }).slice(0, 24),
            at: new Date().toISOString(),
            ok,
            elapsedMs,
            inputTokens: estimateTokensLocal(input.query) + (input.candidates?.length ?? 0) * 12,
            outputTokens: ok ? 40 : 0,
            intent: decision?.intent ?? null,
            compressionLevel: decision?.compressionLevel ?? null,
            confidence: decision?.confidence ?? null,
            error: error ?? null,
            scope: input.scope ?? null,
        };
        this.logger?.info?.('jev.call', { ...record, query: input.query });
        this._lastCall = record;
    }

    /** 供服务层持久化的最近调用记录。 */
    lastCall() {
        return this._lastCall ?? null;
    }

    stats() {
        return {
            consecutiveFailures: this._consecutiveFailures,
            disabledUntil: this._disabledUntil ? new Date(this._disabledUntil).toISOString() : null,
            available: this.available(),
        };
    }
}

function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clamp01(n) {
    const v = Number(n);
    if (Number.isNaN(v)) return 0;
    return Math.min(1, Math.max(0, v));
}

function estimateTokensLocal(text) {
    return Math.ceil(String(text ?? '').length / 3);
}
