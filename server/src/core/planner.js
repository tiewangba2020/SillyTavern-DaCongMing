/**
 * 上下文规划器：在线热路径的编排核心。
 *
 * 流程（需求 3.2）：
 *   采集当前请求和作用域 → 读取模型预算、输出预留和安全余量
 *   → 收集系统/预设/卡牌/世界书/其他扩展注入（保护块）
 *   → 过滤硬约束和用户锁定内容
 *   → BM25/实体/时间召回候选
 *   → Jev 可选门控（DecisionProvider）
 *   → 预算规划（降级梯度）
 *   → 去重、状态更新、滚动摘要和分层摘要
 *   → 注入编译、最终 token 校验
 *   → 发送或安全阻止
 *
 * 每个计划带 reason、sourceIds、plannerVersion、decisionProvider、
 * token 成本和快照版本（需求 US-06）。
 */

import { uuid, contentFingerprint } from '../util/ids.js';
import { estimateTokensConservative as countTokens } from '../util/tokenizer.js';
import { PLANNER_VERSION } from '../config.js';
import { normalizeScope } from './identity.js';
import { computeBudget, planBudget, getTier, compressionRatio } from './budget.js';
import { RECALLABLE_STATUS } from './memory.js';

const CHAPTER_SIZE = 40;
const PLAN_RETENTION_PER_CHAT = 300;
const INJECTION_HEADER = '以下内容由“AI还没忘”从历史对话中压缩整理，仅作背景参考；与最新原文冲突时以最新原文为准。';
const DEFAULT_FIX_ACTIONS = [
    '减少固定块：检查预设/世界书注入是否过长',
    '降低目标档位到“节省用量”',
    '提高模型上下文上限或减少输出预留',
];

const KIND_LABELS = {
    anchor: '设定', preference: '偏好', fact: '事实', entity: '人物', relation: '关系',
    summary_chapter: '摘要', summary_rolling: '摘要', goal: '目标', timeline: '时间线',
    tool_result: '工具结论', attachment: '附件', scene: '场景',
};

export class Planner {
    /**
     * @param {{
     *   data: any, config: object, logger?: object, memoryService: any,
     *   retrieval: any, summarizer: any, snapshots: any,
     *   decisionRouter: { decide: Function, id: string }, entities: any, tasks?: any,
     * }} deps
     */
    constructor(deps) {
        this.data = deps.data;
        this.config = deps.config ?? {};
        this.logger = deps.logger ?? null;
        this.memoryService = deps.memoryService;
        this.retrieval = deps.retrieval;
        this.summarizer = deps.summarizer;
        this.snapshots = deps.snapshots;
        this.decisionRouter = deps.decisionRouter;
        this.entities = deps.entities;
        this.tasks = deps.tasks ?? null;
        this.identities = deps.identities ?? null;
    }

    async plan(request) {
        const startedAt = Date.now();
        const scope = normalizeScope(request.scope ?? { type: 'chat', id: request.chatId ?? 'default' });
        const chatId = request.chatId ?? scope.id;
        const branchId = request.branchId ?? 'main';
        const preview = Boolean(request.options?.preview);
        const hardMode = request.options?.pressure === 'hard';
        const tier = getTier(request.tier ?? this.config.tier, this.config.customTier);
        const dictionary = this.entities?.dictionary?.() ?? [];

        const budget = computeBudget({
            contextLimit: request.budget?.contextLimit,
            outputReserve: request.budget?.outputReserve,
            safetyMarginRatio: this.config.safetyMarginRatio,
            tier: tier.id,
            tierOverride: this.config.customTier,
        });

        // ---- 1. 固定保护块（系统提示、预设、卡牌、世界书、其他扩展注入、最新输入）----
        const fixedBlocks = [];
        for (const block of request.blocks ?? []) {
            const text = String(block.text ?? '');
            if (!text.trim()) continue;
            fixedBlocks.push({
                id: block.id ?? `fixed:${uuid()}`,
                kind: block.kind ?? 'system',
                layer: 'fixed',
                text,
                tokens: countTokens(text),
                protected: true,
                droppable: false,
                sourceIds: [],
                reason: '硬约束块（不可压缩）',
            });
        }

        const messages = (request.messages ?? [])
            .filter((m) => String(m.content ?? '').trim().length > 0)
            .map((m, i) => {
                const floorIndex = m.floorIndex ?? i;
                // 只查找、不创建身份：身份由 /api/ingest 建立；未摄取的消息没有 messageId（仍可参与本轮计划）
                const known = m.messageId
                    ? { messageId: m.messageId }
                    : this.identities?.lookup?.(chatId, branchId, { ...m, floorIndex });
                return { ...m, floorIndex, messageId: known?.messageId ?? null };
            });
        const userInput = String(request.userInput ?? lastUserText(messages) ?? '');

        // ---- 2. 预算切分 ----
        const fixedTokens = fixedBlocks.reduce((a, b) => a + b.tokens, 0);
        const anchorBudget = Math.round(budget.availableInput * 0.05);
        const recallBudget = hardMode ? 0 : Math.round(budget.availableInput * 0.15);
        const summaryBudget = Math.round(budget.availableInput * tier.summaryTargetRatio);
        const recentBudget = Math.max(
            256,
            budget.availableInput - fixedTokens - anchorBudget - recallBudget - summaryBudget,
        );

        // ---- 3. 最近窗口 / 旧消息切分 ----
        const { recent, old } = splitRecent(messages, recentBudget, tier.recentFloorMin, countTokens);

        // ---- 4. 召回候选 ----
        let recallItems = [];
        let recallMeta = { selected: 0, candidates: 0, elapsedMs: 0 };
        if (recallBudget > 0 && userInput) {
            const recall = this.retrieval.recall(userInput, {
                scope,
                chatId,
                branchId,
                budgetTokens: recallBudget,
                topK: hardMode ? 0 : tier.recallTopK,
                dictionary,
                includeRaw: false,
                headFloor: messages.length ? Math.max(...messages.map((m) => m.floorIndex)) : 0,
            });
            recallItems = recall.items;
            recallMeta = recall.meta;
        }

        // ---- 5. 核心锚点（用户锁定/偏好，始终注入，受硬预算约束）----
        // 注意：锚点选择不排除已命中召回的记忆——否则一条被纠正/锁定的锚点
        // 会只留在召回里，随后可能在预算降级中被当作“低相关召回”丢弃，
        // 导致旧事实从章节摘要漏回注入（矛盾）。去重方向反过来：锚点优先，
        // 召回侧再排除锚点（见第 8 步）。
        const anchors = this.#selectAnchors(scope, chatId, branchId, anchorBudget);

        // ---- 6. 决策（规则 / Jev 路由，失败自动回退）----
        // 基线与 finalTokens 同口径：逐条计数再求和（拼接成一段会让分词边界不同，
        // 未压缩时会出现 finalTokens 比 baseline 多/少几个 token 的假差异）
        const estimateBefore = fixedTokens + messages.reduce((a, m) => a + countTokens(m.content), 0);
        const decision = await this.decisionRouter.decide({
            query: userInput,
            candidates: recallItems,
            budget,
            tier,
            currentTokens: estimateBefore,
            recentCount: recent.length,
        });
        const mustKeep = new Set(decision.mustKeepIds ?? []);
        const canDrop = new Set(decision.canDropIds ?? []);

        // ---- 7. 章节摘要 / 旧原文 ----
        const chapters = this.#buildChapters({
            old, chatId, branchId, scope, dictionary, summaryBudget, preview,
            firstRecentFloor: recent.length ? recent[0].floorIndex : Infinity,
        });

        // ---- 8. 组装块 ----
        const blocks = [
            ...fixedBlocks,
            ...anchors.map((rec) => this.#anchorBlock(rec)),
            ...recent.map((m) => this.#messageBlock(m, 'recent', countTokens)),
            ...recallItems
                .filter((item) => !anchors.some((a) => a.id === item.id))
                .map((item) => this.#recallBlock(item, mustKeep, canDrop)),
            ...chapters.blocks,
        ];

        // ---- 9. 预算规划（降级梯度）----
        // 为注入文本的固定开销（头部说明、分节标题、每条的标签/来源后缀）预留空间，
        // 保证“梯度内合规”即“最终 token 合规”
        const injectionOverhead = countTokens(INJECTION_HEADER) + 3 * 8
            + (anchors.length + recallItems.length + chapters.blocks.length) * 20;
        const ladderBudget = {
            ...budget,
            availableInput: Math.max(128, budget.availableInput - injectionOverhead),
        };
        const planResult = planBudget({ blocks, budget: ladderBudget, tier, tierOverride: this.config.customTier });

        // ---- 10. 注入编译 ----
        const keptBlocks = planResult.blocks;
        const keptIds = new Set(keptBlocks.map((b) => b.id));
        const keptAnchors = anchors.filter((a) => keptIds.has(`anchor:${a.id}`));
        const keptRecall = recallItems.filter((i) => keptIds.has(`recall:${i.id}`));
        // 进入注入的摘要：已存章节摘要块 + 被梯度压缩/截断为摘要的旧原文块
        const keptSummaries = keptBlocks
            .filter((b) => b.layer === 'summary' || (b.layer === 'old' && (b.replacedBy || b.truncated)))
            .sort((a, b) => (a.floorIndex ?? 0) - (b.floorIndex ?? 0))
            .map((b) => ({
                blockId: b.id, memoryId: b.memoryId ?? null, text: b.text,
                sourceMessageIds: b.sourceIds ?? [], derived: b.layer === 'old',
            }));
        const injection = this.#compileInjection({ anchors: keptAnchors, recall: keptRecall, summaries: keptSummaries });

        // ---- 11. 消息保留 / 丢弃 / 截断替换清单 ----
        const { retain, drop, replacements } = this.#compileMessageLists({ recent, chapters, keptBlocks });

        // ---- 12. 最终 token 校验 ----
        // 实际发送 = 固定块 + 保留的原文（最近窗口、未压缩的旧原文）+ 注入文本；
        // 锚点 / 召回 / 摘要块只经注入文本计一次，避免重复计数
        const rawTokens = keptBlocks
            .filter((b) => b.layer === 'fixed' || b.layer === 'recent' || (b.layer === 'old' && !b.replacedBy && !b.truncated))
            .reduce((a, b) => a + b.tokens, 0);
        const finalTokens = rawTokens + injection.tokens;
        const measured = Number(request.options?.measuredTokens);
        const hasMeasured = Number.isFinite(measured) && measured > 0;
        const effectiveTokens = hasMeasured ? Math.max(measured, finalTokens) : finalTokens;
        let result = planResult.result;
        if (result !== 'blocked' && effectiveTokens > budget.availableInput) result = 'blocked';

        const savedTokens = Math.max(0, estimateBefore - finalTokens);
        const planId = uuid();
        const response = {
            planId,
            createdAt: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            plannerVersion: PLANNER_VERSION,
            decisionProvider: decision.provider ?? this.decisionRouter.id,
            decision: {
                intent: decision.intent,
                memoryNeeds: decision.memoryNeeds,
                compressionLevel: decision.compressionLevel,
                confidence: decision.confidence,
                reason: decision.reason,
                cached: Boolean(decision.cached),
            },
            result,
            tokenAccuracy: hasMeasured ? 'measured-by-st' : 'estimate',
            budget,
            // 本轮为何（未）压缩：档位触发线推动 vs 越过硬预算（D6 诊断）
            triggered: planResult.triggered,
            hardExceeded: planResult.hardExceeded,
            estimate: {
                baselineTokens: estimateBefore,
                finalTokens,
                effectiveTokens,
                savedTokens,
                savedRatio: compressionRatio(estimateBefore, finalTokens),
                injectionTokens: injection.tokens,
                compressed: savedTokens > 0,
            },
            injections: injection.blocks,
            retain,
            drop,
            replacements,
            recall: keptRecall.map((i) => ({
                id: i.id, kind: i.kind, score: Math.round(i.score * 1000) / 1000,
                breakdown: i.breakdown, reason: i.reason, status: i.status,
            })),
            anchors: keptAnchors.map((a) => ({ id: a.id, kind: a.kind, content: a.content, userLocked: a.userLocked })),
            chapters: {
                total: keptSummaries.length,
                stored: chapters.summaries.length,
                kept: keptSummaries.length,
                pending: chapters.pending,
            },
            actions: planResult.actions,
            degraded: planResult.actions.some((a) => a.savedTokens > 0),
            degradeReasons: [...new Set(planResult.actions.filter((a) => a.savedTokens > 0).map((a) => a.reason))],
            blockReason: result === 'blocked' ? (planResult.blockReason ?? '应用计划后仍超过硬预算') : null,
            fixActions: result === 'blocked'
                ? (planResult.fixActions?.length ? planResult.fixActions : DEFAULT_FIX_ACTIONS)
                : [],
            recallMeta,
            scope: scope.key,
            chatId,
            branchId,
            preview,
        };

        // ---- 13. 持久化 + 快照 ----
        if (!preview) {
            this.#persistPlan(response);
            if (result !== 'blocked' && this.snapshots) {
                const snapshot = this.snapshots.capture({
                    plan: response,
                    scope: scope.key,
                    chatId,
                    branchId,
                    label: response.degraded ? 'auto-compress' : 'auto-plan',
                    auto: true,
                });
                response.snapshotId = snapshot.id;
                // 回填快照号，保证刷新页面后「撤销本次压缩」仍可用
                this.data.update('context_plans', planId, { snapshotId: snapshot.id });
            }
            // 缺失章节摘要入队（后台生成，供下轮复用）
            if (this.tasks && this.config.autoManage && chapters.pending.length) {
                for (const chapterKey of chapters.pending) {
                    const chapter = chapters.byKey[chapterKey];
                    this.tasks.enqueue({
                        type: 'summarize_chapter',
                        scope: scope.key,
                        payload: {
                            chatId, branchId, scope: scope.key, chapterKey,
                            messageIds: chapter.messageIds,
                            floorStart: chapter.floorStart,
                        },
                        version: {
                            branchHead: null,
                            deletionEpoch: this.memoryService.currentEpoch(scope.key),
                        },
                    });
                }
            }
        }

        this.logger?.info?.('planner.plan', {
            planId, result, savedTokens, finalTokens,
            availableInput: budget.availableInput, provider: response.decisionProvider,
            elapsedMs: response.elapsedMs,
        });
        return response;
    }

    // ---------------- 内部 ----------------

    #selectAnchors(scope, chatId, branchId, budgetTokens) {
        const candidates = this.data.query('memory_records', (r) => (
            r.scope === scope.key
            && !r.invalidated
            && RECALLABLE_STATUS.has(r.status)
            && (r.userLocked || r.kind === 'anchor' || r.kind === 'preference')
            && (!r.chatId || r.chatId === chatId)
            && (!r.branchId || r.branchId === branchId)
        ));
        candidates.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (a.createdAt < b.createdAt ? -1 : 1));
        const selected = [];
        let used = 0;
        for (const rec of candidates) {
            const t = countTokens(rec.content);
            if (used + t > budgetTokens) continue;
            selected.push(rec);
            used += t;
        }
        return selected;
    }

    #anchorBlock(rec) {
        return {
            id: `anchor:${rec.id}`,
            kind: 'anchor',
            // 独立 layer：预算降级梯第 3 步只裁剪 layer==='recall' 的召回块，
            // 若锚点也叫 'recall' 就会被当作“低相关召回”先丢；
            // 步骤 7 的 rank() 对 anchor 给最高优先级（最后才丢）。
            layer: 'anchor',
            text: `[${KIND_LABELS[rec.kind] ?? '设定'}] ${rec.content}`,
            tokens: countTokens(rec.content),
            score: 10,
            protected: false,
            droppable: true,
            sourceIds: rec.sourceMessageIds ?? [],
            status: rec.status,
            floorIndex: 0,
            reason: rec.userLocked ? '用户固定' : '核心锚点',
        };
    }

    #messageBlock(msg, layer, countFn) {
        return {
            id: `msg:${msg.messageId ?? msg.floorIndex}`,
            kind: 'raw_message',
            layer,
            text: msg.content,
            tokens: countFn(msg.content),
            // 系统注入（世界书等）即使落在最近窗口也标记受保护，永不进入降级候选
            protected: Boolean(msg.isSystem),
            droppable: !msg.isSystem,
            sourceIds: [msg.messageId].filter(Boolean),
            messageId: msg.messageId,
            floorIndex: msg.floorIndex,
            reason: msg.isSystem ? '系统注入（不可压缩）' : (layer === 'recent' ? '最近原文' : '旧原文'),
        };
    }

    #recallBlock(item, mustKeep, canDrop) {
        const label = KIND_LABELS[item.kind] ?? '记忆';
        return {
            id: `recall:${item.id}`,
            kind: 'recall',
            layer: 'recall',
            text: `[${label}] ${item.text}`,
            tokens: item.tokens,
            score: canDrop.has(item.id) ? 0 : item.score + (mustKeep.has(item.id) ? 1 : 0),
            protected: false,
            droppable: true,
            sourceIds: item.sourceMessageIds ?? [],
            status: item.status,
            floorIndex: 0,
            reason: item.reason,
            memoryId: item.id,
        };
    }

    #buildChapters({ old, chatId, branchId, scope, dictionary, summaryBudget, preview, firstRecentFloor = Infinity }) {
        const byChapter = new Map();
        for (const msg of old) {
            const key = `${chatId}|${branchId}|${Math.floor(msg.floorIndex / CHAPTER_SIZE)}`;
            if (!byChapter.has(key)) {
                byChapter.set(key, { key, messages: [], floorStart: Math.floor(msg.floorIndex / CHAPTER_SIZE) * CHAPTER_SIZE });
            }
            byChapter.get(key).messages.push(msg);
        }

        const blocks = [];
        const summaries = [];
        const pending = [];
        const byKey = {};

        const sortedKeys = [...byChapter.keys()].sort((a, b) => byChapter.get(a).floorStart - byChapter.get(b).floorStart);
        const storedSummaries = [];
        for (const key of sortedKeys) {
            const chapter = byChapter.get(key);
            // 系统注入（世界书等）不参与章节摘要与压缩：单独作保护块按原文保留，
            // token 照常计入预算（账实一致），drop/replacements 也不再出现这些楼层
            const sysMsgs = chapter.messages.filter((m) => m.isSystem);
            const chatMsgs = chapter.messages.filter((m) => !m.isSystem);
            if (sysMsgs.length) {
                const sysText = sysMsgs.map((m) => m.content).join('\n');
                blocks.push({
                    id: `system:${key}`,
                    kind: 'system_injected',
                    layer: 'fixed',
                    text: sysText,
                    tokens: countTokens(sysText),
                    protected: true,
                    droppable: false,
                    sourceIds: [],
                    floors: sysMsgs.map((m) => m.floorIndex),
                    floorIndex: chapter.floorStart,
                    reason: '系统注入（世界书等，不可压缩）',
                });
            }
            byKey[key] = {
                messageIds: chatMsgs.map((m) => m.messageId).filter(Boolean),
                entries: chatMsgs.map((m) => ({ messageId: m.messageId ?? null, floorIndex: m.floorIndex })),
                floorStart: chapter.floorStart,
            };
            // 纯系统章节：没有可摘要的聊天内容
            if (chatMsgs.length === 0) continue;
            // 完整章节 = 整章都在最近窗口之外；只有完整章节才复用/持久化摘要，避免滑动窗口留下残缺摘要
            const complete = chapter.floorStart + CHAPTER_SIZE <= firstRecentFloor;
            const stored = complete ? this.data.query('memory_records', (r) => (
                r.kind === 'summary_chapter'
                && r.structured?.chapterKey === key
                && !r.invalidated
                && RECALLABLE_STATUS.has(r.status)
            ))[0] : null;

            if (stored) {
                const block = {
                    id: `chapter:${key}`,
                    kind: 'summary_chapter',
                    layer: 'summary',
                    text: stored.content,
                    tokens: countTokens(stored.content),
                    protected: false,
                    droppable: true,
                    sourceIds: stored.sourceMessageIds ?? [],
                    floorIndex: chapter.floorStart,
                    reason: '章节摘要（已存）',
                    memoryId: stored.id,
                };
                blocks.push(block);
                summaries.push({ blockId: block.id, memoryId: stored.id, text: stored.content, sourceMessageIds: stored.sourceMessageIds });
                storedSummaries.push(block);
            } else {
                // 章节原文与摘要都不含系统注入（世界书），后者已单独作保护块保留
                const chapterText = chatMsgs.map((m) => m.content).join('\n');
                const summary = this.summarizer.summarizeMessages(
                    chatMsgs.map((m) => ({ messageId: m.messageId, content: m.content, floorIndex: m.floorIndex })),
                    { targetTokens: Math.max(120, Math.min(summaryBudget, 400)), dictionary },
                );
                if (!summary.text) continue;
                const block = {
                    id: `chapter:${key}`,
                    kind: 'raw_chapter',
                    layer: 'old',
                    text: chapterText,
                    tokens: countTokens(chapterText),
                    protected: false,
                    droppable: true,
                    sourceIds: chatMsgs.map((m) => m.messageId).filter(Boolean),
                    floorIndex: chapter.floorStart,
                    reason: '旧原文（可压缩为摘要）',
                    alternatives: [{
                        text: summary.text,
                        tokens: summary.tokens,
                        kind: 'extractive',
                        label: 'extractive-summary',
                    }],
                };
                blocks.push(block);
                if (!preview && complete) pending.push(key);
            }
        }

        // 多个摘要块时，附加“合并摘要”替代项（planBudget 的 merge 步骤使用）
        if (blocks.filter((b) => b.layer === 'summary').length >= 2) {
            const merged = this.summarizer.merge(
                blocks.filter((b) => b.layer === 'summary').map((b) => ({
                    id: b.id, text: b.text, sourceMessageIds: b.sourceIds,
                })),
                { targetTokens: Math.max(160, summaryBudget) },
            );
            for (const block of blocks) {
                if (block.layer !== 'summary') continue;
                block.alternatives = [{ text: merged.text, tokens: merged.tokens, kind: 'merged', label: 'merged-summary' }];
            }
        }

        return { blocks, summaries, pending, byKey };
    }

    #compileInjection({ anchors, recall, summaries }) {
        const blocks = [];
        const lines = [];

        if (anchors.length) {
            const parts = ['【核心设定·始终生效】'];
            for (const rec of anchors) parts.push(`- ${rec.content}`);
            const text = parts.join('\n');
            const tokens = countTokens(text);
            blocks.push({
                kind: 'anchors', text, tokens,
                sourceIds: anchors.flatMap((a) => a.sourceMessageIds ?? []),
                reason: '用户固定与核心锚点，始终注入',
            });
            lines.push(text);
        }

        if (recall.length) {
            const parts = ['【相关记忆·本轮召回】'];
            for (const item of recall) {
                const floor = item.sourceMessageIds?.length ? `（来源 ${item.sourceMessageIds.length} 条消息）` : '';
                parts.push(`- [${KIND_LABELS[item.kind] ?? '记忆'}] ${item.text}${floor}`);
            }
            const text = parts.join('\n');
            const tokens = countTokens(text);
            blocks.push({
                kind: 'recall', text, tokens,
                sourceIds: recall.flatMap((i) => i.sourceMessageIds ?? []),
                reason: `关键词/实体/时间混合召回（${recall.length} 条，已通过作用域与预算校验）`,
            });
            lines.push(text);
        }

        if (summaries.length) {
            const parts = ['【章节摘要】'];
            for (const s of summaries) parts.push(`- ${s.text}`);
            const text = parts.join('\n');
            const tokens = countTokens(text);
            blocks.push({
                kind: 'summaries', text, tokens,
                sourceIds: summaries.flatMap((s) => s.sourceMessageIds ?? []),
                reason: '旧章节抽取式摘要（逐句摘录，未改写）',
            });
            lines.push(text);
        }

        if (!lines.length) return { blocks: [], text: '', tokens: 0 };

        const header = INJECTION_HEADER;
        const text = `${header}\n${lines.join('\n')}`;
        const totalTokens = countTokens(text);
        return { blocks, text, tokens: totalTokens };
    }

    #compileMessageLists({ recent, chapters, keptBlocks }) {
        const keptById = new Map(keptBlocks.map((b) => [b.id, b]));
        const retain = { floors: [], messageIds: [] };
        const drop = [];
        const replacements = [];

        // 系统注入（世界书等）：列为「保留原文」，不参与丢弃/压缩判定
        for (const block of chapters.blocks) {
            if (block.kind !== 'system_injected') continue;
            for (const f of block.floors ?? []) retain.floors.push(f);
        }

        for (const msg of recent) {
            const blockId = `msg:${msg.messageId ?? msg.floorIndex}`;
            const block = keptById.get(blockId);
            if (block) {
                retain.floors.push(msg.floorIndex);
                if (msg.messageId) retain.messageIds.push(msg.messageId);
                if (block.truncated) {
                    replacements.push({
                        floorIndex: msg.floorIndex,
                        messageId: msg.messageId ?? null,
                        text: block.text,
                        reason: '截断最老可丢弃内容（保留片段）',
                    });
                }
            } else {
                drop.push({
                    floorIndex: msg.floorIndex,
                    messageId: msg.messageId ?? null,
                    reason: '预算裁剪（最近窗口）',
                    tokens: countTokens(msg.content),
                });
            }
        }

        for (const [key, chapter] of Object.entries(chapters.byKey)) {
            const blockId = `chapter:${key}`;
            const original = chapters.blocks.find((b) => b.id === blockId);
            if (!original) continue;
            const kept = keptById.get(blockId);
            const compressed = Boolean(kept && (kept.layer === 'summary' || kept.replacedBy || kept.truncated));
            for (const entry of chapter.entries) {
                if (kept && !compressed) {
                    retain.floors.push(entry.floorIndex);
                    if (entry.messageId) retain.messageIds.push(entry.messageId);
                    continue;
                }
                let reason = '预算裁剪（旧原文）';
                if (compressed) reason = kept.layer === 'summary' ? '已压缩为章节摘要' : '已压缩为抽取式摘要';
                drop.push({ floorIndex: entry.floorIndex, messageId: entry.messageId, reason, tokens: 0 });
            }
        }

        retain.floors.sort((a, b) => a - b);
        drop.sort((a, b) => a.floorIndex - b.floorIndex);
        return { retain, drop, replacements };
    }

    #persistPlan(response) {
        const record = {
            // 完整保存计划：记忆中心「本轮计划」刷新后读的是这条持久化记录，
            // 若只存 estimate/actions，注入内容、消息处理、触发原因等都会显示为空。
            ...response,
            id: response.planId,
            feedback: null,
        };
        this.data.insert('context_plans', record);
        const plans = this.data.query('context_plans', (p) => p.chatId === response.chatId);
        if (plans.length > PLAN_RETENTION_PER_CHAT) {
            plans.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
            const excess = plans.slice(0, plans.length - PLAN_RETENTION_PER_CHAT);
            this.data.txn(() => {
                for (const p of excess) this.data.remove('context_plans', p.id);
            });
        }
    }

    /** 记录用户对计划的反馈（撤销/接受），用于策略学习与净收益统计。 */
    recordFeedback(planId, feedback) {
        const plan = this.data.get('context_plans', planId);
        if (!plan) throw new Error(`计划不存在：${planId}`);
        return this.data.update('context_plans', planId, {
            feedback: { ...feedback, at: new Date().toISOString() },
        });
    }
}

// ---------------- 工具函数 ----------------

function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].isUser) return messages[i].content;
    }
    return messages.length ? messages[messages.length - 1].content : '';
}

/**
 * 从最新消息向前累积到 recentBudget，至少保留 minFloors 条。
 */
function splitRecent(messages, recentBudget, minFloors, countFn) {
    const recent = [];
    const old = [];
    let used = 0;
    let idx = messages.length - 1;
    for (; idx >= 0; idx -= 1) {
        const msg = messages[idx];
        const t = countFn(msg.content);
        const count = messages.length - idx;
        if (used + t > recentBudget && count > minFloors) break;
        used += t;
        recent.unshift(msg);
    }
    for (let i = 0; i <= idx; i += 1) old.push(messages[i]);
    return { recent, old };
}

export { CHAPTER_SIZE, KIND_LABELS, contentFingerprint };
