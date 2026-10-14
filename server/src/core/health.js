/**
 * 记忆体检：冲突、过期、无来源、孤儿来源、跨作用域污染、重复摘要、损坏索引。
 *
 * 需求 2.6：记忆体检显示上述问题，并给出一键锁定、忘记、重建、导出和恢复动作。
 * 本模块只诊断并给出修复建议；实际修复动作走对应的 command 接口。
 */

import { RECALLABLE_STATUS } from './memory.js';

const SOURCE_REQUIRED_KINDS = new Set([
    'fact', 'entity', 'relation', 'timeline', 'goal',
    'summary_chapter', 'summary_rolling', 'tool_result', 'attachment',
]);

export function healthCheck({ data, scope = null, now = new Date() }) {
    const issues = [];
    const memories = data.all('memory_records').filter((r) => !scope || r.scope === scope);
    const iso = now.toISOString();

    // 1. 冲突
    const conflicts = memories.filter((r) => r.status === 'conflict');
    const conflictPairs = new Set();
    for (const rec of conflicts) {
        const key = [rec.id, rec.conflictWith].sort().join('|');
        if (conflictPairs.has(key)) continue;
        conflictPairs.add(key);
        issues.push({
            type: 'conflict',
            severity: 'high',
            ids: [rec.id, rec.conflictWith].filter(Boolean),
            detail: rec.conflictDetail ?? `冲突事实：${rec.content.slice(0, 80)}`,
            fix: 'resolve-conflict',
            fixHint: '在记忆中心选择正确版本（纠正），旧版本将被替代',
        });
    }

    // 2. 过期但仍活跃
    for (const rec of memories) {
        if (rec.validTo && rec.validTo < iso && RECALLABLE_STATUS.has(rec.status)) {
            issues.push({
                type: 'expired',
                severity: 'medium',
                ids: [rec.id],
                detail: `有效期已过（${rec.validTo}）但仍为 ${rec.status}：${rec.content.slice(0, 60)}`,
                fix: 'expire-record',
                fixHint: '标记过期（不删除内容）',
            });
        }
    }

    // 3. 无来源
    for (const rec of memories) {
        if (!SOURCE_REQUIRED_KINDS.has(rec.kind)) continue;
        if (rec.derivation?.method === 'user' || rec.userEdited) continue;
        if (!rec.sourceMessageIds?.length) {
            issues.push({
                type: 'no_source',
                severity: 'medium',
                ids: [rec.id],
                detail: `缺少来源消息：${rec.content.slice(0, 60)}`,
                fix: 'manual-review',
                fixHint: '检查该记忆，补来源或遗忘',
            });
        }
    }

    // 4. 孤儿来源（引用了不存在的消息）
    const knownMessageIds = new Set(data.all('message_identity').map((r) => r.messageId));
    for (const rec of memories) {
        if (!rec.sourceMessageIds?.length) continue;
        const missing = rec.sourceMessageIds.filter((id) => !knownMessageIds.has(id));
        if (missing.length) {
            issues.push({
                type: 'orphan_source',
                severity: 'low',
                ids: [rec.id, ...missing],
                detail: `来源消息缺失（${missing.length} 条）：${rec.content.slice(0, 60)}`,
                fix: 'rebuild-or-archive',
                fixHint: '重建索引或归档该记忆',
            });
        }
    }

    // 5. 跨作用域污染（记忆的来源消息属于其他聊天）
    const identityById = new Map(data.all('message_identity').map((r) => [r.messageId, r]));
    for (const rec of memories) {
        if (!rec.chatId || !rec.sourceMessageIds?.length) continue;
        const foreign = rec.sourceMessageIds.filter((id) => {
            const identity = identityById.get(id);
            return identity && identity.chatId !== rec.chatId;
        });
        if (foreign.length) {
            issues.push({
                type: 'cross_scope',
                severity: 'high',
                ids: [rec.id, ...foreign],
                detail: `来源消息属于其他聊天（${foreign.length} 条）：${rec.content.slice(0, 60)}`,
                fix: 'forget-record',
                fixHint: '遗忘该记忆（防止串卡）',
            });
        }
    }

    // 6. 重复摘要（同作用域同 hash）
    const summaryHashes = new Map();
    for (const rec of memories) {
        if (rec.kind !== 'summary_chapter' && rec.kind !== 'summary_rolling') continue;
        if (rec.invalidated) continue;
        const key = `${rec.scope}|${rec.hash}`;
        if (summaryHashes.has(key)) {
            issues.push({
                type: 'duplicate_summary',
                severity: 'low',
                ids: [summaryHashes.get(key), rec.id],
                detail: '存在内容完全相同的重复摘要',
                fix: 'archive-duplicate',
                fixHint: '归档重复摘要',
            });
        } else {
            summaryHashes.set(key, rec.id);
        }
    }

    // 7. 损坏索引（活跃记忆缺少索引条目 / 索引引用缺失记录）
    const missingFromIndex = [];
    for (const rec of memories) {
        if (rec.invalidated) continue;
        const docId = data.docId('memory_records', rec.id);
        if (!data.index.docTerms.has(docId)) missingFromIndex.push(rec.id);
    }
    const danglingIndex = [];
    for (const docId of data.index.docTerms.keys()) {
        if (!docId.startsWith('m:')) continue;
        const id = docId.slice(2);
        if (!data.get('memory_records', id)) danglingIndex.push(id);
    }
    if (missingFromIndex.length || danglingIndex.length) {
        issues.push({
            type: 'broken_index',
            severity: 'medium',
            ids: [...missingFromIndex.slice(0, 20), ...danglingIndex.slice(0, 20)],
            detail: `索引不一致：${missingFromIndex.length} 条记忆缺少索引条目，${danglingIndex.length} 条索引指向缺失记录`,
            fix: 'rebuild-index',
            fixHint: '重建索引（可由原始事件完整重建）',
        });
    }

    const byType = {};
    for (const issue of issues) byType[issue.type] = (byType[issue.type] ?? 0) + 1;

    return {
        at: iso,
        scope: scope ?? 'all',
        summary: {
            totalMemories: memories.length,
            issues: issues.length,
            byType,
            bySeverity: {
                high: issues.filter((i) => i.severity === 'high').length,
                medium: issues.filter((i) => i.severity === 'medium').length,
                low: issues.filter((i) => i.severity === 'low').length,
            },
            healthy: issues.length === 0,
        },
        issues,
    };
}

/** 修复动作分发。 */
export function applyFix({ data, memoryService, fix, ids = [] }) {
    switch (fix) {
        case 'rebuild-index':
            data.rebuildIndex();
            return { action: 'rebuild-index', ok: true };
        case 'expire-record': {
            const now = new Date().toISOString();
            for (const id of ids) {
                if (data.get('memory_records', id)) {
                    data.update('memory_records', id, { status: 'expired', statusReason: '体检标记过期', updatedAt: now });
                }
            }
            return { action: 'expire-record', ok: true, count: ids.length };
        }
        case 'forget-record': {
            for (const id of ids) {
                if (data.get('memory_records', id)) memoryService.forget(id, { reason: '体检：跨作用域污染' });
            }
            return { action: 'forget-record', ok: true, count: ids.length };
        }
        case 'archive-duplicate': {
            const now = new Date().toISOString();
            for (const id of ids.slice(1)) {
                if (data.get('memory_records', id)) {
                    data.update('memory_records', id, {
                        status: 'archived', invalidated: true,
                        invalidatedReason: '体检：重复摘要', invalidatedAt: now, updatedAt: now,
                    });
                }
            }
            return { action: 'archive-duplicate', ok: true, count: Math.max(0, ids.length - 1) };
        }
        default:
            return { action: fix, ok: false, reason: '该问题需要用户手动处理（manual-review）' };
    }
}
