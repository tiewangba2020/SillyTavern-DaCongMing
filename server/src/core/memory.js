/**
 * 记忆服务：MemoryRecord 的创建、去重、生命周期、纠正、固定、遗忘与清理。
 *
 * 生命周期（需求 2.5）：
 *   candidate → observed → confirmed → active → superseded/expired → archived
 * 低置信度或冲突内容停留在 candidate/conflict，不覆盖已确认事实。
 *
 * “不再记忆”是持久阻断标记（tombstone）：重扫、导入、重建索引、服务重启后
 * 仍阻止同一内容复活；“彻底删除”走隐私清理例外并推进 deletion epoch。
 */

import { uuid, contentFingerprint } from '../util/ids.js';
import { SCHEMA_VERSION } from '../config.js';
import { normalizeScope, scopeKey } from './identity.js';

export const MEMORY_KINDS = Object.freeze([
    'anchor', 'preference', 'fact', 'entity', 'relation',
    'summary_chapter', 'summary_rolling', 'goal', 'timeline',
    'tool_result', 'attachment', 'scene',
]);

export const MEMORY_STATUS = Object.freeze([
    'candidate', 'observed', 'confirmed', 'active',
    'superseded', 'expired', 'archived', 'conflict',
]);

/** 可被召回的状态：observed（已观察、置信度达标）、confirmed、active；candidate/conflict 不注入 */
export const RECALLABLE_STATUS = new Set(['observed', 'confirmed', 'active']);

export class MemoryService {
    /** @param {{ data: any, logger?: object, config?: object }} opts */
    constructor({ data, logger, config }) {
        this.data = data;
        this.logger = logger ?? null;
        this.config = config ?? {};
    }

    // ---------------- 生命周期 ----------------

    /**
     * 创建记忆记录。默认按 (scope, contentHash) 去重；被 tombstone 阻断的内容直接拒绝。
     * @returns {{ record: object|null, duplicate: object|null, blocked: object|null }}
     */
    create(input, { origin = 'auto', allowDuplicate = false } = {}) {
        const scope = normalizeScope(input.scope);
        const content = String(input.content ?? '').trim();
        if (!content) throw new Error('记忆内容不能为空');
        const hash = contentFingerprint(content);

        const blocked = this.isBlocked(scope, {
            hash,
            text: content,
            sourceMessageIds: input.sourceMessageIds ?? [],
        });
        if (blocked) {
            this.logger?.debug?.('memory.blocked_by_tombstone', { scope: scope.key, tombstoneId: blocked.id });
            return { record: null, duplicate: null, blocked };
        }

        if (!allowDuplicate) {
            const existing = this.data.query('memory_records', (r) => (
                r.scope === scope.key
                && r.hash === hash
                && !r.invalidated
                && !['archived', 'superseded', 'expired'].includes(r.status)
            ));
            if (existing.length) {
                // 重复证据：记录一次重复出现，用于自动提升
                const first = existing[0];
                const seenFrom = new Set([...(first.observedFrom ?? []), ...(input.sourceMessageIds ?? [])]);
                const updated = this.data.update('memory_records', first.id, {
                    observedFrom: [...seenFrom],
                    duplicateSeenCount: (first.duplicateSeenCount ?? 1) + 1,
                    updatedAt: new Date().toISOString(),
                });
                return { record: updated, duplicate: updated, blocked: null };
            }
        }

        const record = {
            id: uuid(),
            kind: MEMORY_KINDS.includes(input.kind) ? input.kind : 'fact',
            scope: scope.key,
            scopeType: scope.type,
            scopeId: scope.id,
            chatId: input.chatId ?? null,
            branchId: input.branchId ?? null,
            content,
            hash,
            structured: input.structured ?? null,
            sourceMessageIds: input.sourceMessageIds ?? [],
            // 来源楼层区间与说话人：供记忆中心「楼层 / 角色」过滤（D12）。
            // 旧记录可能没有这两个字段，读取侧按「无楼层信息」处理。
            floorStart: Number.isFinite(input.floorStart) ? input.floorStart : null,
            floorEnd: Number.isFinite(input.floorEnd) ? input.floorEnd : null,
            speakers: Array.isArray(input.speakers) ? input.speakers.filter(Boolean) : [],
            sourceRevision: input.sourceRevision ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            validFrom: input.validFrom ?? null,
            validTo: input.validTo ?? null,
            confidence: clamp01(input.confidence ?? 0.5),
            importance: clamp01(input.importance ?? 0.5),
            status: MEMORY_STATUS.includes(input.status) ? input.status : 'candidate',
            supersedes: input.supersedes ?? null,
            supersededBy: null,
            userLocked: Boolean(input.userLocked),
            userEdited: Boolean(input.userEdited),
            sensitivity: input.sensitivity ?? 'normal',
            derivation: input.derivation ?? { method: origin, version: 'unknown' },
            schemaVersion: SCHEMA_VERSION,
            sharedScopes: input.sharedScopes ?? [],
            invalidated: false,
            invalidatedReason: null,
            invalidatedAt: null,
            importBatch: input.importBatch ?? null,
            importSourceId: input.importSourceId ?? null,
            observedFrom: input.sourceMessageIds ?? [],
        };
        this.data.insert('memory_records', record);
        this.logger?.debug?.('memory.created', {
            id: record.id, kind: record.kind, scope: record.scope,
            status: record.status, content: record.content,
        });
        return { record, duplicate: null, blocked: null };
    }

    get(id) {
        return this.data.get('memory_records', id);
    }

    /** 状态提升：只允许沿生命周期向前推进，或进入 conflict。 */
    promote(id, status, reason = null) {
        if (!MEMORY_STATUS.includes(status)) throw new Error(`未知状态：${status}`);
        const rec = this.get(id);
        if (!rec) throw new Error(`记忆不存在：${id}`);
        return this.data.update('memory_records', id, {
            status,
            statusReason: reason,
            updatedAt: new Date().toISOString(),
        });
    }

    /**
     * 用户纠正：以用户内容为最高优先级生成新版本，并立即使旧派生记忆失效。
     */
    correct(id, { content, structured = null } = {}) {
        const old = this.get(id);
        if (!old) throw new Error(`记忆不存在：${id}`);
        const newContent = String(content ?? old.content).trim();
        const now = new Date().toISOString();

        return this.data.txn(() => {
            this.data.update('memory_records', id, {
                status: 'superseded',
                supersededBy: null, // 稍后回填
                invalidated: true,
                invalidatedReason: '用户纠正',
                invalidatedAt: now,
                updatedAt: now,
            });
            const { record } = this.create({
                ...old,
                id: undefined,
                content: newContent,
                structured: structured ?? old.structured,
                status: 'confirmed',
                confidence: 1,
                importance: Math.max(old.importance ?? 0.5, 0.8),
                userEdited: true,
                userLocked: true,
                supersedes: id,
                derivation: { method: 'user', version: 'user-correction' },
                sourceMessageIds: old.sourceMessageIds,
                sourceRevision: old.sourceRevision,
                hash: undefined,
            }, { origin: 'user', allowDuplicate: true });
            this.data.update('memory_records', id, { supersededBy: record.id });
            this.logger?.info?.('memory.corrected', { oldId: id, newId: record.id, content: newContent });
            return record;
        });
    }

    setLocked(id, locked) {
        const rec = this.get(id);
        if (!rec) throw new Error(`记忆不存在：${id}`);
        const patch = { userLocked: Boolean(locked), updatedAt: new Date().toISOString() };
        if (locked && ['candidate', 'observed'].includes(rec.status)) {
            patch.status = 'confirmed';
            patch.statusReason = '用户固定';
            patch.confidence = Math.max(rec.confidence, 0.95);
        }
        if (locked) patch.importance = Math.max(rec.importance ?? 0.5, 0.9);
        return this.data.update('memory_records', id, patch);
    }

    setImportance(id, importance) {
        return this.data.update('memory_records', id, {
            importance: clamp01(importance),
            updatedAt: new Date().toISOString(),
        });
    }

    /**
     * 遗忘一条记忆：建立内容阻断标记（防重扫复活）并使其不可召回。
     */
    forget(id, { reason = '用户遗忘' } = {}) {
        const rec = this.get(id);
        if (!rec) throw new Error(`记忆不存在：${id}`);
        return this.data.txn(() => {
            this.addTombstone({
                scope: rec.scope,
                targetHash: rec.hash,
                targetText: rec.content,
                messageIds: rec.sourceMessageIds,
                kind: 'forget',
                reason,
            });
            return this.data.update('memory_records', id, {
                status: 'archived',
                invalidated: true,
                invalidatedReason: reason,
                invalidatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        });
    }

    /** “不再记忆”：对某段文本/某些消息建立持久阻断，防止重扫历史后复活。 */
    forgetText({ scope, text, messageIds = [], reason = '用户标记不再记忆' }) {
        return this.addTombstone({
            scope: scopeKey(scope),
            targetHash: text ? contentFingerprint(text) : null,
            targetText: text ?? null,
            messageIds,
            kind: 'never_remember',
            reason,
        });
    }

    addTombstone({ scope, targetHash, targetText, messageIds = [], kind = 'forget', reason = null }) {
        const record = {
            id: uuid(),
            scope: typeof scope === 'string' ? scope : scopeKey(scope),
            targetHash: targetHash ?? null,
            targetText: targetText ? String(targetText).slice(0, 2000) : null,
            messageIds: messageIds ?? [],
            kind,
            reason,
            deletionEpoch: this.currentEpoch(scope),
            createdAt: new Date().toISOString(),
        };
        this.data.insert('tombstones', record);
        this.logger?.info?.('memory.tombstone_added', { id: record.id, kind, scope: record.scope });
        return record;
    }

    /** 检查内容是否被阻断（去重哈希 + 来源消息 + 归一化文本包含）。 */
    isBlocked(scope, { hash, text, sourceMessageIds = [] } = {}) {
        const scopeStr = typeof scope === 'string' ? scope : scopeKey(scope);
        const tombstones = this.data.query('tombstones', (t) => (
            t.scope === scopeStr || t.scope === scopeKey(normalizeScope('user:default'))
        ));
        for (const t of tombstones) {
            if (t.targetHash && hash && t.targetHash === hash) return t;
            if (t.messageIds?.length && sourceMessageIds.some((id) => t.messageIds.includes(id))) return t;
            if (t.targetText && text) {
                const a = normalizeForBlock(t.targetText);
                const b = normalizeForBlock(text);
                if (a && (a === b || (a.length >= 8 && b.includes(a)))) return t;
            }
        }
        return null;
    }

    restore(id) {
        const rec = this.get(id);
        if (!rec) throw new Error(`记忆不存在：${id}`);
        return this.data.update('memory_records', id, {
            status: rec.userEdited ? 'confirmed' : 'observed',
            invalidated: false,
            invalidatedReason: null,
            invalidatedAt: null,
            updatedAt: new Date().toISOString(),
        });
    }

    supersede(oldId, newId) {
        const now = new Date().toISOString();
        this.data.update('memory_records', oldId, {
            status: 'superseded', supersededBy: newId, invalidated: true,
            invalidatedReason: '被新版本替代', invalidatedAt: now, updatedAt: now,
        });
        return this.data.update('memory_records', newId, { supersedes: oldId, updatedAt: now });
    }

    /** 标记过期（validTo 已过），不删除内容。 */
    expireDue(now = new Date()) {
        const iso = now.toISOString();
        const due = this.data.query('memory_records', (r) => (
            r.validTo && r.validTo < iso && !['expired', 'archived', 'superseded'].includes(r.status)
        ));
        for (const rec of due) {
            this.data.update('memory_records', rec.id, {
                status: 'expired',
                statusReason: '有效期已过',
                updatedAt: iso,
            });
        }
        return due.length;
    }

    /**
     * 冲突登记：同一 (subject, attribute) 出现不同 value 时，双方进入 conflict。
     * 不覆盖已确认事实，交由用户或维护路径处理。
     */
    registerConflict(aId, bId, detail) {
        const now = new Date().toISOString();
        this.data.update('memory_records', aId, {
            status: 'conflict', conflictWith: bId, conflictDetail: detail, updatedAt: now,
        });
        this.data.update('memory_records', bId, {
            status: 'conflict', conflictWith: aId, conflictDetail: detail, updatedAt: now,
        });
        this.logger?.warn?.('memory.conflict', { aId, bId, detail });
    }

    list(filters = {}) {
        const {
            scope, status, kind, chatId, branchId, sourceMessageId,
            search, includeInvalidated = false, limit = 500, offset = 0,
            sourcePlugin, createdAfter, createdBefore,
            floorFrom, floorTo, speaker,
        } = filters;
        let items = this.data.all('memory_records');
        if (scope) {
            const key = typeof scope === 'string' ? scope : scopeKey(scope);
            items = items.filter((r) => r.scope === key);
        }
        if (status) {
            const set = new Set(Array.isArray(status) ? status : [status]);
            items = items.filter((r) => set.has(r.status));
        }
        if (kind) {
            const set = new Set(Array.isArray(kind) ? kind : [kind]);
            items = items.filter((r) => set.has(r.kind));
        }
        if (chatId) items = items.filter((r) => r.chatId === chatId);
        if (branchId) items = items.filter((r) => r.branchId === branchId);
        if (sourceMessageId) {
            items = items.filter((r) => r.sourceMessageIds?.includes(sourceMessageId));
        }
        // 来源（导入自哪个旧插件）
        if (sourcePlugin) items = items.filter((r) => r.derivation?.sourcePlugin === sourcePlugin);
        // 时间范围（ISO 字符串比较即可，记录里存的就是 ISO）
        if (createdAfter) items = items.filter((r) => String(r.createdAt ?? '') >= String(createdAfter));
        if (createdBefore) items = items.filter((r) => String(r.createdAt ?? '') <= String(createdBefore));

        // 楼层范围：与记录的 [floorStart, floorEnd] 有交集即命中；没有楼层信息的记录在有筛选时排除
        const hasFloorFilter = Number.isFinite(floorFrom) || Number.isFinite(floorTo);
        if (hasFloorFilter) {
            const from = Number.isFinite(floorFrom) ? floorFrom : -Infinity;
            const to = Number.isFinite(floorTo) ? floorTo : Infinity;
            items = items.filter((r) => {
                const start = Number.isFinite(r.floorStart) ? r.floorStart : null;
                if (start === null) return false;
                const end = Number.isFinite(r.floorEnd) ? r.floorEnd : start;
                return start <= to && end >= from;
            });
        }
        // 说话人 / 角色
        if (speaker) {
            const q = String(speaker).trim().toLowerCase();
            items = items.filter((r) => {
                if (r.structured?.speaker && String(r.structured.speaker).toLowerCase().includes(q)) return true;
                return (r.speakers ?? []).some((name) => String(name).toLowerCase().includes(q));
            });
        }
        if (!includeInvalidated) items = items.filter((r) => !r.invalidated);
        if (search) {
            const q = String(search).toLowerCase();
            items = items.filter((r) => r.content.toLowerCase().includes(q));
        }
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return { total: items.length, items: items.slice(offset, offset + limit) };
    }

    // ---------------- 删除与作用域隔离 ----------------

    currentEpoch(scope) {
        const key = typeof scope === 'string' ? scope : scopeKey(scope);
        return Number(this.data.metaGet(`deletionEpoch:${key}`, '0'));
    }

    nextEpoch(scope) {
        const key = typeof scope === 'string' ? scope : scopeKey(scope);
        const next = this.currentEpoch(key) + 1;
        this.data.metaSet(`deletionEpoch:${key}`, String(next));
        return next;
    }

    /**
     * 彻底删除插件副本：清理原文副本、摘要、事实、索引、缓存、任务结果和诊断正文。
     * 不删除 SillyTavern 原始聊天；tombstone 只保留最少标识。
     */
    purgeScope(scope, { includeChatScope = true } = {}) {
        const scopeStr = typeof scope === 'string' ? scope : scopeKey(scope);
        const epoch = this.nextEpoch(scopeStr);
        const stats = { memories: 0, events: 0, identities: 0, tasks: 0, plans: 0, snapshots: 0, diagnostics: 0 };
        // 精确匹配作用域；chat/branch 作用域时连带同一聊天的分支与消息副本（避免 chat:m1 误伤 chat:m10 的前缀碰撞）
        const parsed = normalizeScope(scopeStr);
        const chatId = parsed.type === 'chat'
            ? parsed.id
            : (parsed.type === 'branch' ? parsed.id.split(':')[0] : null);
        this.data.txn(() => {
            const inScope = (r) => r.scope === scopeStr
                || (includeChatScope && chatId && (
                    r.chatId === chatId
                    || r.scope === `chat:${chatId}`
                    || String(r.scope ?? '').startsWith(`branch:${chatId}:`)
                ));
            stats.memories = this.data.removeWhere('memory_records', inScope);
            stats.plans = this.data.removeWhere('context_plans', (r) => r.scope === scopeStr || (chatId && r.chatId === chatId));
            stats.snapshots = this.data.removeWhere('snapshots', (r) => r.scope === scopeStr || (chatId && r.chatId === chatId));
            stats.tasks = this.data.removeWhere('tasks', (r) => r.scope === scopeStr || (chatId && r.payload?.chatId === chatId));
            if (chatId) {
                const msgIds = new Set(
                    this.data.query('message_identity', (r) => r.chatId === chatId).map((r) => r.messageId),
                );
                stats.events = this.data.removeWhere('message_events', (e) => msgIds.has(e.messageId));
                stats.identities = this.data.removeWhere('message_identity', (r) => r.chatId === chatId);
            }
        });
        // 清理 tombstone 正文，只保留标识
        for (const t of this.data.query('tombstones', (t) => t.scope === scopeStr)) {
            this.data.update('tombstones', t.id, {
                targetText: null,
                messageIds: [],
                purgedAt: new Date().toISOString(),
                deletionEpoch: epoch,
            });
        }
        this.logger?.warn?.('memory.purged', { scope: scopeStr, epoch, ...stats });
        return { epoch, ...stats };
    }

    /** 任务提交前的版本校验：epoch 变化说明数据已被清理，迟到任务不得写入。 */
    checkEpoch(scope, epochAtTask) {
        const current = this.currentEpoch(scope);
        return Number(epochAtTask ?? 0) === current;
    }
}

function clamp01(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 0.5;
    return Math.min(1, Math.max(0, n));
}

function normalizeForBlock(text) {
    return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}
