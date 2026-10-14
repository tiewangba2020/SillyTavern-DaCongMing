/**
 * 事件日志（append-only）。
 *
 * 需求 4.2 / 4.6：原始消息使用 append-only 事件记录，是唯一事实源；
 * 编辑、删除、重生成、切换 swipe、分支复制会立即使受影响派生结果失效。
 * 本模块只追加事件，不做更新；派生记录的失效通过 invalidated 标记完成，
 * 用户“彻底删除”时由 MemoryService 走隐私清理例外（deletion epoch）。
 */

import { uuid } from '../util/ids.js';

export class EventLog {
    /** @param {{ data: any, identities: any, logger?: object }} opts */
    constructor({ data, identities, logger }) {
        this.data = data;
        this.identities = identities;
        this.logger = logger ?? null;
    }

    /**
     * 摄取一批消息（增量或全量）。
     * @param {{ chatId: string, branchId?: string, messages: Array<object>, fullSync?: boolean, deleted?: Array<object> }} input
     */
    ingest(input) {
        const chatId = input.chatId;
        const branchId = input.branchId ?? 'main';
        const messages = input.messages ?? [];
        const result = {
            accepted: 0,
            unchanged: 0,
            edited: 0,
            created: 0,
            deleted: 0,
            events: [],
            invalidated: { memoryIds: [], summaryIds: [], messageIds: [] },
        };

        this.data.txn(() => {
            const seenMessageIds = new Set();
            for (const msg of messages) {
                const identity = this.identities.resolve(chatId, branchId, msg);
                seenMessageIds.add(identity.messageId);
                if (identity.isNew) {
                    const event = this.#appendEvent({
                        chatId,
                        branchId,
                        messageId: identity.messageId,
                        variantId: msg.swipeId ?? null,
                        revision: identity.revision,
                        contentHash: identity.contentHash,
                        role: msg.isUser ? 'user' : (msg.isSystem ? 'system' : 'assistant'),
                        speakerName: msg.name ?? '',
                        isUser: Boolean(msg.isUser),
                        isSystem: Boolean(msg.isSystem),
                        text: msg.content ?? '',
                        sendDate: msg.sendDate ?? null,
                        floorIndex: msg.floorIndex ?? null,
                        kind: 'append',
                    });
                    result.created += 1;
                    result.accepted += 1;
                    result.events.push(event);
                } else if (identity.edited) {
                    const event = this.#appendEvent({
                        chatId,
                        branchId,
                        messageId: identity.messageId,
                        variantId: msg.swipeId ?? null,
                        revision: identity.revision,
                        contentHash: identity.contentHash,
                        role: msg.isUser ? 'user' : (msg.isSystem ? 'system' : 'assistant'),
                        speakerName: msg.name ?? '',
                        isUser: Boolean(msg.isUser),
                        isSystem: Boolean(msg.isSystem),
                        text: msg.content ?? '',
                        sendDate: msg.sendDate ?? null,
                        floorIndex: msg.floorIndex ?? null,
                        kind: 'edit',
                    });
                    result.edited += 1;
                    result.accepted += 1;
                    result.events.push(event);
                    const invalidated = this.#invalidateDerived(identity.messageId, identity.revision);
                    result.invalidated.memoryIds.push(...invalidated.memoryIds);
                    result.invalidated.summaryIds.push(...invalidated.summaryIds);
                    result.invalidated.messageIds.push(identity.messageId);
                } else {
                    result.unchanged += 1;
                }
            }

            // 显式删除（由扩展在 MESSAGE_DELETED 事件中提供）
            for (const del of input.deleted ?? []) {
                const identity = del.messageId
                    ? this.identities.get(del.messageId)
                    : this.#findByFloor(chatId, branchId, del.floorIndex, del.name);
                if (!identity) continue;
                this.#appendEvent({
                    chatId,
                    branchId,
                    messageId: identity.messageId,
                    variantId: null,
                    revision: identity.revision + 1,
                    contentHash: identity.contentHash,
                    role: 'unknown',
                    speakerName: identity.name ?? del.name ?? '',
                    isUser: false,
                    isSystem: false,
                    text: '',
                    sendDate: null,
                    floorIndex: del.floorIndex ?? identity.floorIndex ?? null,
                    kind: 'delete',
                });
                const invalidated = this.#invalidateDerived(identity.messageId, identity.revision + 1);
                result.invalidated.memoryIds.push(...invalidated.memoryIds);
                result.invalidated.summaryIds.push(...invalidated.summaryIds);
                result.invalidated.messageIds.push(identity.messageId);
                result.deleted += 1;
            }

            // 全量同步时检测“消失的消息”（删除的兜底路径）
            if (input.fullSync) {
                for (const identity of this.identities.byChat(chatId, branchId)) {
                    if (seenMessageIds.has(identity.messageId)) continue;
                    if (this.#isDeleted(identity.messageId)) continue;
                    this.#appendEvent({
                        chatId,
                        branchId,
                        messageId: identity.messageId,
                        variantId: null,
                        revision: identity.revision + 1,
                        contentHash: identity.contentHash,
                        role: 'unknown',
                        speakerName: '',
                        isUser: false,
                        isSystem: false,
                        text: '',
                        sendDate: null,
                        floorIndex: identity.floorIndex ?? null,
                        kind: 'delete',
                    });
                    const invalidated = this.#invalidateDerived(identity.messageId, identity.revision + 1);
                    result.invalidated.memoryIds.push(...invalidated.memoryIds);
                    result.invalidated.summaryIds.push(...invalidated.summaryIds);
                    result.invalidated.messageIds.push(identity.messageId);
                    result.deleted += 1;
                }
            }
        });

        if (result.accepted || result.deleted) {
            this.logger?.info?.('events.ingested', {
                chatId,
                branchId,
                created: result.created,
                edited: result.edited,
                deleted: result.deleted,
                invalidatedMemories: result.invalidated.memoryIds.length,
            });
        }
        return result;
    }

    /** 切换 swipe：未选中的变体不得注入当前故事，选中的变体使旧派生失效。 */
    recordSwipeSelection({ chatId, branchId, messageId, variantId }) {
        const identity = this.identities.get(messageId);
        if (!identity) throw new Error(`未知消息：${messageId}`);
        const event = this.#appendEvent({
            chatId,
            branchId,
            messageId,
            variantId,
            revision: identity.revision + 1,
            contentHash: identity.contentHash,
            role: 'assistant',
            speakerName: '',
            isUser: false,
            isSystem: false,
            text: '',
            sendDate: null,
            floorIndex: identity.floorIndex ?? null,
            kind: 'swipe_select',
        });
        const invalidated = this.#invalidateDerived(messageId, identity.revision + 1);
        this.data.update('message_identity', identity.id, {
            revision: identity.revision + 1,
            variantId,
            updatedAt: new Date().toISOString(),
        });
        return { event, invalidated };
    }

    /** 分支复制：记录分支起源，供审计与隔离校验。 */
    recordBranchFork({ chatId, fromBranchId, toBranchId, atMessageId }) {
        return this.#appendEvent({
            chatId,
            branchId: toBranchId,
            messageId: atMessageId ?? null,
            variantId: null,
            revision: 1,
            contentHash: '',
            role: 'system',
            speakerName: '',
            isUser: false,
            isSystem: true,
            text: '',
            sendDate: null,
            floorIndex: null,
            kind: 'branch_fork',
            extra: { fromBranchId },
        });
    }

    #appendEvent(data) {
        const record = {
            id: uuid(),
            eventId: null,
            createdAt: new Date().toISOString(),
            extra: null,
            ...data,
        };
        record.eventId = record.id;
        this.data.insert('message_events', record);
        return record;
    }

    #findByFloor(chatId, branchId, floorIndex, name) {
        const matches = this.data.query('message_identity', (r) => (
            r.chatId === chatId
            && r.branchId === branchId
            && r.floorIndex === floorIndex
            && (!name || r.naturalKey.includes(`|${name}|`))
        ));
        return matches[0] ?? null;
    }

    #isDeleted(messageId) {
        return this.data.query('message_events', (e) => e.messageId === messageId && e.kind === 'delete').length > 0;
    }

    /**
     * 使派生结果失效：来源包含该消息且生成于旧 revision 的记忆/摘要。
     */
    #invalidateDerived(messageId, newRevision) {
        const memoryIds = [];
        const summaryIds = [];
        const now = new Date().toISOString();
        this.data.txn(() => {
            for (const rec of this.data.all('memory_records')) {
                if (!Array.isArray(rec.sourceMessageIds)) continue;
                if (!rec.sourceMessageIds.includes(messageId)) continue;
                if (rec.invalidated) continue;
                if ((rec.sourceRevision ?? 0) >= newRevision) continue;
                this.data.update('memory_records', rec.id, {
                    invalidated: true,
                    invalidatedReason: `来源消息已变更（revision ${newRevision}）`,
                    invalidatedAt: now,
                });
                if (rec.kind === 'summary_chapter' || rec.kind === 'summary_rolling') summaryIds.push(rec.id);
                else memoryIds.push(rec.id);
            }
        });
        return { memoryIds, summaryIds };
    }

    eventsForMessage(messageId) {
        return this.data.query('message_events', (e) => e.messageId === messageId)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }

    latestEventFor(messageId) {
        const events = this.eventsForMessage(messageId);
        return events[events.length - 1] ?? null;
    }

    headRevision(chatId, branchId) {
        const identities = this.identities.byChat(chatId, branchId);
        let max = 0;
        for (const identity of identities) max = Math.max(max, identity.revision ?? 0);
        return max;
    }

    /** 最近一条 append/edit 事件中携带的正文（用于回放与重建）。 */
    latestText(messageId) {
        const events = this.eventsForMessage(messageId)
            .filter((e) => e.kind === 'append' || e.kind === 'edit');
        return events.length ? events[events.length - 1].text : null;
    }
}
