/**
 * 服务组合根：把存储、核心模块、任务队列、Provider 和 API 装配为一个运行时。
 *
 * 三条回路（需求 4.1）：
 *   1. 在线热路径：plan() —— 本地完成作用域读取、预算、召回、计划和注入编译；
 *   2. 后台写路径：ingest() 入队 extract / summarize_chapter —— 不阻塞主回复；
 *   3. 维护修复路径：health-check / rebuild-index / import —— 用户或系统触发。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_VERSION, SCHEMA_VERSION, PLANNER_VERSION, SUMMARIZER_VERSION } from './config.js';
import { openAdapter } from './store/adapter.js';
import { Data } from './store/data.js';
import { IdentityResolver } from './core/identity.js';
import { EventLog } from './core/events.js';
import { MemoryService } from './core/memory.js';
import { EntityService } from './core/entities.js';
import { Retrieval } from './core/retrieval.js';
import { Summarizer } from './core/summarizer.js';
import { Planner } from './core/planner.js';
import { Snapshots } from './core/snapshot.js';
import { TaskQueue, CancelledError } from './core/tasks.js';
import { ProbeService } from './core/probe.js';
import { extractCandidates, detectConflicts } from './core/extractor.js';
import { healthCheck, applyFix } from './core/health.js';
import { RuleDecisionProvider, DecisionCache, createDecisionRouter } from './providers/decision.js';
import { TypeSafeJevProvider } from './providers/jev.js';
import { Security } from './api/security.js';
import { contentFingerprint } from './util/ids.js';

class EventBus {
    constructor() {
        this.subs = new Set();
    }

    subscribe(fn) {
        this.subs.add(fn);
        return () => this.subs.delete(fn);
    }

    emit(type, data) {
        const event = { type, data, at: new Date().toISOString() };
        for (const fn of this.subs) {
            try { fn(event); } catch { /* 订阅者异常不影响主流程 */ }
        }
    }
}

export class Service {
    constructor({ config, logger }) {
        this.config = config;
        this.logger = logger;
        this.bus = new EventBus();
        this.startedAt = new Date().toISOString();
        this.degraded = null;
    }

    /** 装配并初始化。 */
    static async create({ config, logger, storeKind = 'auto' }) {
        const service = new Service({ config, logger });

        service.adapter = await openAdapter({
            kind: storeKind,
            dataDir: config.dataDir,
            dbFile: config.dbFile,
            journalDir: config.journalDir,
            logger,
        });
        service.data = new Data({ adapter: service.adapter, logger });
        await service.data.init();

        service.identities = new IdentityResolver({ data: service.data, logger });
        service.events = new EventLog({ data: service.data, identities: service.identities, logger });
        service.memories = new MemoryService({ data: service.data, logger, config });
        service.entities = new EntityService({ data: service.data, logger });
        service.retrieval = new Retrieval({ data: service.data, memoryService: service.memories, logger });
        service.summarizer = new Summarizer({ logger });
        service.snapshots = new Snapshots({ data: service.data, logger, config });
        service.probes = new ProbeService({ data: service.data, config, logger });

        // 决策提供者：默认规则；Jev 仅在显式开启且配置端点时启用。
        // 通过 getPrimary 动态解析 + settings 事件监听，UI 改配置后无需重启即可生效。
        const fallback = new RuleDecisionProvider({ logger });
        const cache = new DecisionCache({});
        service.reconfigureJev();
        service.decisionRouter = createDecisionRouter({ getPrimary: () => service.jev, fallback, cache, logger });
        service.bus.subscribe((event) => {
            if (event?.type === 'settings') service.reconfigureJev();
        });

        service.tasks = new TaskQueue({ data: service.data, logger, config });
        service.planner = new Planner({
            data: service.data,
            config,
            logger,
            memoryService: service.memories,
            retrieval: service.retrieval,
            summarizer: service.summarizer,
            snapshots: service.snapshots,
            decisionRouter: service.decisionRouter,
            entities: service.entities,
            tasks: service.tasks,
            identities: service.identities,
        });

        service.#registerTasks();
        service.tasks.start();
        return service;
    }

    /**
     * 依据当前 config 重建 TypeSafe Jev 提供者（设置变更时热更新）。
     * 未开启或未配置端点时置空，决策路由自动回退规则计划。
     * @returns {TypeSafeJevProvider|null}
     */
    reconfigureJev() {
        const { config, logger } = this;
        if (config.allowJev && config.jevEndpoint) {
            this.jev = new TypeSafeJevProvider({
                endpoint: config.jevEndpoint,
                apiKey: config.jevApiKey,
                timeoutMs: config.jevTimeoutMs ?? 8000,
                minConfidence: config.jevMinConfidence ?? 0.4,
                model: config.jevModel ?? 'jev-latest',
                instructionsSet: config.jevInstructions ?? 'v1',
                logger,
            });
        } else {
            this.jev = null;
        }
        return this.jev;
    }

    // ---------------- 在线热路径 ----------------

    /**
     * 生成上下文计划。
     * @param {object} request
     */
    async plan(request) {
        const probe = this.probes.effective(request.chatId);
        const enriched = {
            ...request,
            budget: {
                contextLimit: request.budget?.contextLimit ?? probe.contextLimit,
                outputReserve: request.budget?.outputReserve ?? probe.outputReserve,
            },
        };
        const plan = await this.planner.plan(enriched);
        this.bus.emit('plan', { planId: plan.planId, result: plan.result, savedTokens: plan.estimate.savedTokens });
        return plan;
    }

    recordFeedback(planId, feedback) {
        const result = this.planner.recordFeedback(planId, feedback);
        this.bus.emit('plan_feedback', { planId, feedback });
        return result;
    }

    // ---------------- 后台写路径 ----------------

    /**
     * 摄取消息事件，并按需入队后台抽取。
     */
    ingest(input) {
        const result = this.events.ingest(input);
        const chatId = input.chatId;
        const branchId = input.branchId ?? 'main';
        const scope = input.scope ?? `chat:${chatId}`;

        if (this.config.autoManage && (result.created || result.edited)) {
            const messageIds = result.events
                .filter((e) => e.kind === 'append' || e.kind === 'edit')
                .map((e) => e.messageId);
            if (messageIds.length) {
                this.tasks.enqueue({
                    type: 'extract',
                    scope,
                    payload: { chatId, branchId, scope, messageIds },
                    version: {
                        branchHead: this.events.headRevision(chatId, branchId),
                        profileHash: this.probes.effective(chatId).profileHash ?? null,
                        deletionEpoch: this.memories.currentEpoch(scope),
                    },
                });
            }
        }
        if (result.invalidated.memoryIds.length || result.invalidated.summaryIds.length) {
            this.bus.emit('invalidation', result.invalidated);
        }
        this.bus.emit('ingest', {
            chatId, created: result.created, edited: result.edited, deleted: result.deleted,
        });
        return result;
    }

    #registerTasks() {
        // 事实抽取（规则模式，无外部调用）
        this.tasks.register('extract', async (payload, ctx) => {
            const { chatId, branchId, scope, messageIds } = payload;
            ctx.assertFresh();
            const dictionary = this.entities.dictionary();
            const messages = [];
            for (const messageId of messageIds) {
                ctx.throwIfCancelled();
                const text = this.events.latestText(messageId);
                const identity = this.identities.get(messageId);
                if (!text || !identity) continue;
                const latest = this.events.latestEventFor(messageId);
                messages.push({
                    messageId,
                    content: text,
                    isUser: latest?.isUser ?? false,
                    isSystem: latest?.isSystem ?? false,
                    role: latest?.role ?? 'assistant',
                    speakerName: latest?.speakerName ?? '',
                    floorIndex: latest?.floorIndex ?? null,
                });
                this.entities.learnFromText(text, { scope });
            }
            if (!messages.length) return { extracted: 0 };

            const candidates = extractCandidates({ messages, scope, chatId, branchId, dictionary });
            const turnCount = this.#bumpTurn(chatId);
            const shadow = this.#inShadow(turnCount);
            // messageId → 该消息的楼层与说话人：用于给记忆记录标注来源位置（D12 过滤用）
            const byMessageId = new Map(messages.map((m) => [m.messageId, m]));
            let created = 0;
            let conflicts = 0;

            for (const cand of candidates) {
                ctx.throwIfCancelled();
                const existing = this.data.query('memory_records', (r) => (
                    r.scope === scope
                    && !r.invalidated
                    && ['candidate', 'observed', 'confirmed', 'active', 'conflict'].includes(r.status)
                ));
                const conflictHits = detectConflicts(cand, existing);
                const status = this.#initialStatus(cand, shadow);
                const origins = (cand.sourceMessageIds ?? []).map((id) => byMessageId.get(id)).filter(Boolean);
                const floors = origins.map((m) => m.floorIndex).filter((v) => Number.isFinite(v));
                const { record, blocked } = this.memories.create({
                    ...cand,
                    scope,
                    chatId,
                    branchId,
                    status,
                    floorStart: floors.length ? Math.min(...floors) : null,
                    floorEnd: floors.length ? Math.max(...floors) : null,
                    speakers: [...new Set(origins.map((m) => m.speakerName).filter(Boolean))],
                    sourceRevision: ctx.task.version?.branchHead ?? null,
                }, { origin: 'auto' });
                if (blocked) continue;
                created += 1;
                if (conflictHits.length && record) {
                    this.memories.registerConflict(record.id, conflictHits[0].existingId, conflictHits[0].detail);
                    conflicts += 1;
                } else if (record && !shadow) {
                    this.#autoPromote(record);
                }
            }

            // 观察期结束后，把此前停留在 candidate 的记录按置信度回补晋升；
            // 否则观察期内抽取的事实会永远停在 candidate（不可召回），等于白记。
            const promoted = shadow ? 0 : this.#promoteBacklog(scope);

            this.bus.emit('extract', { chatId, candidates: candidates.length, created, conflicts, shadow, promoted });
            return { extracted: candidates.length, created, conflicts, shadow, promoted };
        });

        // 章节摘要（抽取式，确定性，可复用）
        this.tasks.register('summarize_chapter', async (payload, ctx) => {
            const { chatId, branchId, scope, chapterKey, messageIds, floorStart } = payload;
            ctx.assertFresh();
            const existing = this.data.query('memory_records', (r) => (
                r.structured?.chapterKey === chapterKey && !r.invalidated
            ));
            if (existing.length) return { duplicate: true };

            const msgs = [];
            for (const messageId of messageIds) {
                ctx.throwIfCancelled();
                const text = this.events.latestText(messageId);
                if (text) msgs.push({ messageId, content: text });
            }
            if (!msgs.length) return { skipped: true };
            const summary = this.summarizer.summarizeMessages(msgs, {
                targetTokens: 400,
                dictionary: this.entities.dictionary(),
            });
            if (!summary.text) return { skipped: true };
            // 章节摘要同样标注楼层区间，便于记忆中心按楼层定位（D12）
            const summaryFloors = msgs
                .map((m) => this.events.latestEventFor(m.messageId)?.floorIndex)
                .filter((v) => Number.isFinite(v));
            const summarySpeakers = [...new Set(msgs
                .map((m) => this.events.latestEventFor(m.messageId)?.speakerName)
                .filter(Boolean))];
            const { record } = this.memories.create({
                kind: 'summary_chapter',
                scope,
                chatId,
                branchId,
                content: summary.text,
                structured: { chapterKey, floorStart },
                sourceMessageIds: summary.sourceMessageIds,
                floorStart: Number.isFinite(floorStart) ? floorStart : (summaryFloors.length ? Math.min(...summaryFloors) : null),
                floorEnd: summaryFloors.length ? Math.max(...summaryFloors) : (Number.isFinite(floorStart) ? floorStart : null),
                speakers: summarySpeakers,
                confidence: 0.85,
                importance: 0.7,
                status: 'confirmed',
                derivation: { method: 'extractive', version: SUMMARIZER_VERSION },
            }, { origin: 'auto' });
            this.bus.emit('summary', { chatId, chapterKey, tokens: summary.tokens });
            return { summaryId: record?.id, tokens: summary.tokens };
        });

        this.tasks.register('index_rebuild', async () => {
            const stats = this.data.rebuildIndex();
            return stats;
        });
    }

    #bumpTurn(chatId) {
        const key = `turnCount:${chatId}`;
        const next = Number(this.data.metaGet(key, '0')) + 1;
        this.data.metaSet(key, String(next));
        return next;
    }

    #inShadow(turnCount) {
        const mode = this.config.shadowMode;
        if (mode === 'first-n') return turnCount <= (this.config.shadowTurns ?? 20);
        // 只有「显式开启」才算观察期。'off' / false / null / undefined 一律表示不设观察期。
        // 注意：不能写成 Boolean(mode) —— 字符串 'off' 是真值，会让观察期恒真，
        // 自动抽取的事实永远停在 candidate（不可召回），等于自动记忆完全失效。
        return mode === true || mode === 'on' || mode === 'always';
    }

    #initialStatus(candidate, shadow) {
        if (shadow) return 'candidate';
        if (candidate.derivation?.method === 'rule' && candidate.derivation?.rule === 'explicit-remember') return 'confirmed';
        if ((candidate.confidence ?? 0) >= 0.8) return 'confirmed';
        if ((candidate.confidence ?? 0) >= 0.55) return 'observed';
        return 'candidate';
    }

    /**
     * 观察期回补：把该作用域下仍停留在 candidate 的自动记忆按置信度晋升，
     * 使其进入可召回集合。判定口径与 #initialStatus 保持一致。
     * @returns {number} 被晋升的条数
     */
    #promoteBacklog(scope) {
        const backlog = this.data.query('memory_records', (r) => (
            r.scope === scope
            && !r.invalidated
            && r.status === 'candidate'
        ));
        let promoted = 0;
        for (const rec of backlog) {
            const confidence = rec.confidence ?? 0;
            const next = confidence >= 0.8 ? 'confirmed' : (confidence >= 0.55 ? 'observed' : null);
            if (!next) continue;
            try {
                this.memories.promote(rec.id, next, '观察期结束·按置信度回补');
                promoted += 1;
            } catch { /* 单条失败不影响其余 */ }
        }
        if (promoted) this.logger?.debug?.('extract.backlogPromoted', { scope, promoted });
        return promoted;
    }

    #autoPromote(record) {
        const seen = record.duplicateSeenCount ?? 1;
        if (seen >= 2 && ['candidate', 'observed'].includes(record.status)) {
            this.memories.promote(record.id, 'confirmed', `重复出现 ${seen} 次`);
            return;
        }
        if (record.status === 'observed' && (record.confidence ?? 0) >= 0.75 && (record.importance ?? 0) >= 0.7) {
            this.memories.promote(record.id, 'active', '高置信度自动激活');
        }
    }

    // ---------------- 维护修复路径 ----------------

    healthCheck(scope = null) {
        return healthCheck({ data: this.data, scope });
    }

    applyHealthFix(fix, ids) {
        const result = applyFix({ data: this.data, memoryService: this.memories, fix, ids });
        this.bus.emit('health_fix', result);
        return result;
    }

    rebuildIndex() {
        return this.data.rebuildIndex();
    }

    /** 净收益统计：压缩节省 vs 辅助调用消耗。 */
    stats() {
        const plans = this.data.all('context_plans');
        let baseline = 0;
        let final = 0;
        let blocked = 0;
        let degraded = 0;
        for (const plan of plans) {
            baseline += plan.estimate?.baselineTokens ?? 0;
            final += plan.estimate?.finalTokens ?? 0;
            if (plan.result === 'blocked') blocked += 1;
            if (plan.result === 'degraded') degraded += 1;
        }
        const jevCalls = this.jev?.stats?.() ?? null;
        const memories = this.data.all('memory_records');
        const byStatus = {};
        for (const m of memories) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
        return {
            service: SERVICE_VERSION,
            schemaVersion: SCHEMA_VERSION,
            plannerVersion: PLANNER_VERSION,
            store: this.adapter.stats(),
            plans: {
                total: plans.length,
                blocked,
                degraded,
                baselineTokens: baseline,
                finalTokens: final,
                savedTokens: Math.max(0, baseline - final),
                savedRatio: baseline ? (baseline - final) / baseline : 0,
            },
            auxiliary: {
                jev: jevCalls,
                note: 'Jev/Embedding 未启用时辅助调用为 0；净收益 = 压缩节省 - 辅助消耗',
            },
            memories: { total: memories.length, byStatus },
            tasks: this.tasks.stats(),
            index: this.data.indexStats(),
            entities: this.entities.list().length,
            tombstones: this.data.count('tombstones'),
            snapshots: this.data.count('snapshots'),
        };
    }

    // ---------------- 导出 / 导入 ----------------

    exportData({ scope = null, includeEvents = false } = {}) {
        const pick = (collection, filter = () => true) => this.data.all(collection)
            .filter((r) => (scope ? (r.scope === scope || r.chatId === scope) : true))
            .filter(filter);
        return {
            exportVersion: 1,
            schemaVersion: SCHEMA_VERSION,
            service: SERVICE_VERSION,
            exportedAt: new Date().toISOString(),
            scope,
            includeEvents,
            data: {
                memory_records: pick('memory_records'),
                tombstones: pick('tombstones'),
                entities: this.entities.list(),
                snapshots: pick('snapshots').map((s) => ({ ...s, memoryState: s.memoryState?.slice(0, 200) })),
                ...(includeEvents ? { message_events: pick('message_events'), message_identity: pick('message_identity') } : {}),
            },
        };
    }

    /** 导入预览（版本校验 + 计数），不落库。 */
    importPreview(payload) {
        const errors = [];
        if (!payload || typeof payload !== 'object') errors.push('导入文件不是合法 JSON 对象');
        if (payload?.exportVersion > 1) errors.push(`导出文件版本过新（${payload.exportVersion}），请升级服务`);
        const data = payload?.data ?? {};
        const existingHashes = new Set(this.data.all('memory_records').map((r) => `${r.scope}|${r.hash}`));
        let duplicate = 0;
        let fresh = 0;
        for (const rec of data.memory_records ?? []) {
            if (existingHashes.has(`${rec.scope}|${rec.hash}`)) duplicate += 1;
            else fresh += 1;
        }
        return {
            ok: errors.length === 0,
            errors,
            counts: {
                memories: (data.memory_records ?? []).length,
                fresh,
                duplicate,
                tombstones: (data.tombstones ?? []).length,
                entities: (data.entities ?? []).length,
            },
            note: '导入为合并模式（按内容哈希去重，不覆盖现有数据）',
        };
    }

    /** 原子导入（合并模式）。 */
    importApply(payload) {
        const preview = this.importPreview(payload);
        if (!preview.ok) throw new Error(`导入校验失败：${preview.errors.join('；')}`);
        const data = payload.data ?? {};
        const stats = { memories: 0, skipped: 0, tombstones: 0, entities: 0 };
        this.data.txn(() => {
            for (const rec of data.memory_records ?? []) {
                const existing = this.data.query('memory_records', (r) => r.scope === rec.scope && r.hash === rec.hash);
                if (existing.length) {
                    stats.skipped += 1;
                    continue;
                }
                const { record, blocked } = this.memories.create({ ...rec, id: undefined }, { origin: 'import', allowDuplicate: true });
                if (record && !blocked) stats.memories += 1;
                else stats.skipped += 1;
            }
            for (const tombstone of data.tombstones ?? []) {
                if (this.data.get('tombstones', tombstone.id)) continue;
                this.data.insert('tombstones', tombstone);
                stats.tombstones += 1;
            }
            for (const entity of data.entities ?? []) {
                if (this.data.get('entities', entity.id)) continue;
                this.data.insert('entities', entity);
                stats.entities += 1;
            }
        });
        this.entities.invalidate();
        this.bus.emit('import', stats);
        return { ...stats, preview };
    }

    // ---------------- 记忆库（按聊天作用域）管理 ----------------

    /**
     * 列出所有记忆库：作用域、别名、记录数与近似占用、最后活动时间。
     * 占用 = 相关集合中该作用域记录的 JSON 字节数（近似值，非 SQLite 页级精确值）。
     */
    listScopes() {
        const names = this.data.metaGet('scopeNames', {}) ?? {};
        const stats = new Map(); // scope -> {records, bytes, lastAt, byKind}

        const touch = (scope, rec, kind) => {
            if (!scope) return;
            const entry = stats.get(scope) ?? { records: 0, bytes: 0, lastAt: null, byKind: {} };
            entry.records += 1;
            entry.bytes += JSON.stringify(rec ?? {}).length;
            const at = rec?.updatedAt ?? rec?.createdAt ?? rec?.at ?? null;
            if (at && (!entry.lastAt || at > entry.lastAt)) entry.lastAt = at;
            if (kind) entry.byKind[kind] = (entry.byKind[kind] ?? 0) + 1;
            stats.set(scope, entry);
        };

        for (const r of this.data.all('memory_records')) {
            touch(r.scope, r, r.kind === 'summary_chapter' ? '摘要' : '记忆');
        }
        for (const r of this.data.all('context_plans')) touch(r.scope, r, '计划');
        for (const r of this.data.all('snapshots')) touch(r.scope, r, '快照');
        for (const r of this.data.all('tombstones')) touch(r.scope, r, '阻断');
        // 消息事件按 message_identity 的 chatId 归组
        const chatEvents = new Map(); // chatId -> {records, bytes, lastAt}
        for (const r of this.data.all('message_identity')) {
            if (!r.chatId) continue;
            const e = chatEvents.get(r.chatId) ?? { records: 0, bytes: 0, lastAt: null };
            e.records += 1;
            e.bytes += JSON.stringify(r ?? {}).length;
            const at = r.lastSeenAt ?? r.createdAt ?? null;
            if (at && (!e.lastAt || at > e.lastAt)) e.lastAt = at;
            chatEvents.set(r.chatId, e);
        }

        const scopes = [];
        for (const [scope, s] of stats) {
            const chatId = scope.startsWith('chat:') ? scope.slice(5)
                : scope.startsWith('branch:') ? scope.split(':')[1] : scope;
            const ev = chatEvents.get(chatId);
            if (ev) {
                s.byKind['消息副本'] = ev.records;
                s.bytes += ev.bytes;
                if (ev.lastAt && (!s.lastAt || ev.lastAt > s.lastAt)) s.lastAt = ev.lastAt;
                chatEvents.delete(chatId);
            }
            scopes.push({
                scope,
                chatId,
                name: names[scope] ?? null,
                records: s.records,
                bytes: s.bytes,
                lastAt: s.lastAt,
                byKind: s.byKind,
            });
        }
        // 只剩消息副本、无记忆数据的孤儿 chatId（例如删除聊天后 purge 过的）也列出，便于清理
        for (const [chatId, ev] of chatEvents) {
            const scope = `chat:${chatId}`;
            scopes.push({
                scope, chatId, name: names[scope] ?? null,
                records: ev.records, bytes: ev.bytes, lastAt: ev.lastAt,
                byKind: { '消息副本': ev.records }, orphan: true,
            });
        }
        scopes.sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));
        return { ok: true, scopes };
    }

    /** 重命名记忆库（存储层 meta 别名；null/空串 = 清除别名恢复默认显示）。 */
    renameScope(scope, name) {
        if (typeof scope !== 'string' || !scope) return { ok: false, error: 'scope 不能为空' };
        const clean = String(name ?? '').trim().slice(0, 60);
        const names = this.data.metaGet('scopeNames', {}) ?? {};
        if (clean) names[scope] = clean;
        else delete names[scope];
        this.data.metaSet('scopeNames', names);
        this.bus.emit('scope_renamed', { scope, name: clean || null });
        return { ok: true, scope, name: clean || null };
    }

    /** 删除记忆库（彻底清理该作用域全部副本，等价于 purgeScope；不可逆）。 */
    deleteScope(scope) {
        if (typeof scope !== 'string' || !scope) return { ok: false, error: 'scope 不能为空' };
        const result = this.memories.purgeScope(scope);
        const names = this.data.metaGet('scopeNames', {}) ?? {};
        if (names[scope]) {
            delete names[scope];
            this.data.metaSet('scopeNames', names);
        }
        this.bus.emit('scope_deleted', { scope, ...result });
        return { ok: true, scope, ...result };
    }

    // ---------------- 生命周期 ----------------

    async backup(tag = 'manual') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = `${this.config.backupDir}/memory-${tag}-${stamp}.sqlite`;
        await this.adapter.backup(target);
        this.#pruneBackups();
        return target;
    }

    #pruneBackups() {
        const keep = this.config.backupKeep ?? 5;
        try {
            const files = fs.readdirSync(this.config.backupDir)
                .filter((f) => f.startsWith('memory-'))
                .sort();
            while (files.length > keep) {
                const victim = files.shift();
                fs.unlinkSync(path.join(this.config.backupDir, victim));
            }
        } catch { /* 备份清理失败不影响主流程 */ }
    }

    async stop() {
        this.tasks.stop();
        try { this.data.adapter.checkpoint(); } catch { /* ignore */ }
        try { this.data.adapter.close(); } catch { /* ignore */ }
    }
}

export { Security, contentFingerprint, CancelledError };
