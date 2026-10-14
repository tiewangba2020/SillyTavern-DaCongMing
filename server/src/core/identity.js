/**
 * 稳定身份与作用域。
 *
 * 需求 4.6：稳定身份必须包含 chatId、branchId、messageId、variantId、revision
 * 和内容指纹；楼层索引只能作为显示信息，不能作为永久主键。
 *
 * SillyTavern 消息没有原生稳定 id，本模块用自然键
 * （chatId + branchId + sendDate + name + isUser）建立一次映射并持久化，
 * 之后同一消息始终解析为同一 messageId；内容变化时 revision+1。
 * sendDate 缺失时退化为（楼层 + 名称 + 角色）自然键并标记 lowConfidence。
 */

import { uuid, contentFingerprint, sha256 } from '../util/ids.js';

export const SCOPE_TYPES = Object.freeze(['user', 'character', 'preset', 'chat', 'branch', 'scene']);

export function normalizeScope(input) {
    if (!input) return { type: 'chat', id: 'default', key: 'chat:default' };
    if (typeof input === 'string') {
        const [type, ...rest] = input.split(':');
        const id = rest.join(':') || 'default';
        return { type: SCOPE_TYPES.includes(type) ? type : 'chat', id, key: `${type}:${id}` };
    }
    const type = SCOPE_TYPES.includes(input.type) ? input.type : 'chat';
    const id = String(input.id ?? 'default');
    return { type, id, key: `${type}:${id}` };
}

export function scopeKey(scope) {
    return normalizeScope(scope).key;
}

export function scopesEqual(a, b) {
    return scopeKey(a) === scopeKey(b);
}

export function chatScope(chatId) {
    return normalizeScope({ type: 'chat', id: chatId });
}

export function branchScope(chatId, branchId) {
    return normalizeScope({ type: 'branch', id: `${chatId}:${branchId}` });
}

export function userScope(userId = 'default') {
    return normalizeScope({ type: 'user', id: userId });
}

export function characterScope(characterId) {
    return normalizeScope({ type: 'character', id: characterId });
}

export function presetScope(presetId) {
    return normalizeScope({ type: 'preset', id: presetId });
}

export class IdentityResolver {
    /**
     * @param {{ data: any, logger?: object }} opts
     */
    constructor({ data, logger }) {
        this.data = data;
        this.logger = logger ?? null;
        /** @type {Map<string, object>} naturalKey -> identity record */
        this.byNaturalKey = new Map();
        for (const rec of data.all('message_identity')) {
            this.byNaturalKey.set(rec.naturalKey, rec);
        }
    }

    naturalKey(chatId, branchId, msg) {
        const base = `${chatId}|${branchId}|${msg.name ?? ''}|${msg.isUser ? 'u' : 'a'}`;
        if (msg.sendDate) return `${base}|d:${msg.sendDate}`;
        return `${base}|i:${msg.floorIndex ?? 'x'}`;
    }

    /**
     * 解析一条消息的稳定身份。
     * @returns {{ messageId: string, revision: number, isNew: boolean, edited: boolean, contentHash: string, lowConfidence: boolean }}
     */
    resolve(chatId, branchId, msg) {
        const contentHash = contentFingerprint(msg.content ?? '');
        const naturalKey = this.naturalKey(chatId, branchId, msg);
        const existing = this.byNaturalKey.get(naturalKey);

        if (!existing) {
            const record = {
                id: uuid(),
                naturalKey,
                chatId,
                branchId,
                messageId: null, // 下面赋值
                revision: 1,
                contentHash,
                floorIndex: msg.floorIndex ?? null,
                variantId: msg.swipeId ?? null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            record.messageId = record.id;
            this.data.insert('message_identity', record);
            this.byNaturalKey.set(naturalKey, record);
            return {
                messageId: record.messageId,
                revision: 1,
                isNew: true,
                edited: false,
                contentHash,
                lowConfidence: !msg.sendDate,
            };
        }

        const edited = existing.contentHash !== contentHash;
        const patch = {
            updatedAt: new Date().toISOString(),
            floorIndex: msg.floorIndex ?? existing.floorIndex,
            variantId: msg.swipeId ?? existing.variantId,
        };
        if (edited) {
            patch.contentHash = contentHash;
            patch.revision = existing.revision + 1;
        }
        const updated = this.data.update('message_identity', existing.id, patch);
        this.byNaturalKey.set(naturalKey, updated);
        return {
            messageId: updated.messageId,
            revision: updated.revision,
            isNew: false,
            edited,
            contentHash,
            lowConfidence: !msg.sendDate,
        };
    }

    /** 只查找、不创建：供规划器为请求消息补全 messageId（身份由 ingest 建立）。 */
    lookup(chatId, branchId, msg) {
        const record = this.byNaturalKey.get(this.naturalKey(chatId, branchId, msg));
        return record ? { messageId: record.messageId, revision: record.revision } : null;
    }

    get(messageId) {
        return this.data.get('message_identity', messageId);
    }

    byChat(chatId, branchId = null) {
        return this.data.query('message_identity', (r) => (
            r.chatId === chatId && (branchId === null || r.branchId === branchId)
        ));
    }
}

/** 内容指纹导出，便于其他模块统一使用。 */
export { contentFingerprint, sha256 };
