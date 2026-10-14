/**
 * 压缩快照与回滚。
 *
 * 需求 US-06 / 2.6：用户可预览计划、撤销压缩和恢复上一可用快照。
 * 快照捕获计划涉及的记忆状态（status / invalidated / validTo），
 * 恢复时回滚这些状态，并把快照之后生成的同作用域摘要归档，
 * 保证“撤销压缩”不会留下半成品状态。
 */

import { uuid } from '../util/ids.js';

export class Snapshots {
    /** @param {{ data: any, logger?: object, config?: object }} opts */
    constructor({ data, logger, config }) {
        this.data = data;
        this.logger = logger ?? null;
        this.config = config ?? {};
        this.retentionPerScope = config?.snapshotRetention ?? 50;
    }

    /**
     * 捕获快照。
     * @param {{ plan: object, scope: string, chatId?: string, branchId?: string, label?: string, auto?: boolean }} input
     */
    capture(input) {
        const plan = input.plan ?? {};
        const scope = input.scope;
        const referenced = new Set();
        for (const inj of plan.injections ?? []) {
            for (const sid of inj.sourceIds ?? []) referenced.add(sid);
        }
        for (const action of plan.actions ?? []) {
            for (const sid of action.sourceIds ?? []) referenced.add(sid);
        }
        for (const rec of plan.anchors ?? []) referenced.add(rec.id);
        for (const rec of plan.recall ?? []) referenced.add(rec.id);

        const state = [];
        for (const id of referenced) {
            const rec = this.data.get('memory_records', id);
            if (!rec) continue;
            state.push({
                id: rec.id,
                status: rec.status,
                invalidated: Boolean(rec.invalidated),
                validTo: rec.validTo ?? null,
                hash: rec.hash,
            });
        }
        // 同作用域摘要全部纳入（压缩的主要产物）
        for (const rec of this.data.query('memory_records', (r) => (
            r.scope === scope && (r.kind === 'summary_chapter' || r.kind === 'summary_rolling') && !r.invalidated
        ))) {
            if (!state.some((s) => s.id === rec.id)) {
                state.push({
                    id: rec.id, status: rec.status, invalidated: Boolean(rec.invalidated),
                    validTo: rec.validTo ?? null, hash: rec.hash,
                });
            }
        }

        const snapshot = {
            id: uuid(),
            snapshotId: null,
            planId: plan.planId ?? null,
            createdAt: new Date().toISOString(),
            scope,
            chatId: input.chatId ?? plan.chatId ?? null,
            branchId: input.branchId ?? plan.branchId ?? null,
            label: input.label ?? 'manual',
            auto: Boolean(input.auto),
            memoryState: state,
            indexBuiltAt: this.data.index.builtAt,
            tokens: plan.estimate?.finalTokens ?? null,
            reason: plan.degradeReasons?.length ? plan.degradeReasons.join('；') : '常规计划',
        };
        snapshot.snapshotId = snapshot.id;
        this.data.insert('snapshots', snapshot);

        // 保留上限
        const all = this.data.query('snapshots', (s) => s.scope === scope);
        if (all.length > this.retentionPerScope) {
            all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
            const excess = all.slice(0, all.length - this.retentionPerScope);
            this.data.txn(() => {
                for (const s of excess) this.data.remove('snapshots', s.id);
            });
        }
        this.logger?.debug?.('snapshot.captured', { id: snapshot.id, scope, entries: state.length });
        return snapshot;
    }

    get(id) {
        return this.data.get('snapshots', id);
    }

    list({ scope, limit = 20 } = {}) {
        let items = this.data.all('snapshots');
        if (scope) items = items.filter((s) => s.scope === scope);
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return items.slice(0, limit);
    }

    lastGood(scope) {
        const items = this.list({ scope, limit: 50 }).filter((s) => s.label !== 'blocked');
        return items[0] ?? null;
    }

    /**
     * 恢复快照：回滚记忆状态；归档快照之后生成的同作用域摘要。
     * @returns {{ restored: number, archived: number, snapshotId: string }}
     */
    restore(id) {
        const snapshot = this.get(id);
        if (!snapshot) throw new Error(`快照不存在：${id}`);
        let restored = 0;
        let archived = 0;
        const snapshotIds = new Set(snapshot.memoryState.map((s) => s.id));
        const now = new Date().toISOString();

        this.data.txn(() => {
            for (const entry of snapshot.memoryState) {
                const rec = this.data.get('memory_records', entry.id);
                if (!rec) continue;
                const changed = rec.status !== entry.status
                    || Boolean(rec.invalidated) !== entry.invalidated
                    || (rec.validTo ?? null) !== entry.validTo;
                if (!changed) continue;
                this.data.update('memory_records', entry.id, {
                    status: entry.status,
                    invalidated: entry.invalidated,
                    validTo: entry.validTo,
                    invalidatedReason: entry.invalidated ? rec.invalidatedReason : null,
                    restoredFrom: snapshot.id,
                    updatedAt: now,
                });
                restored += 1;
            }
            // 归档快照之后生成、且不在快照内的同作用域摘要。
            // 用 >= 而非 >：同毫秒内“快照之后”写入的摘要同样是回滚对象；
            // 快照自身捕获到的摘要已在 snapshotIds 中，不会被误归档。
            for (const rec of this.data.query('memory_records', (r) => (
                r.scope === snapshot.scope
                && (r.kind === 'summary_chapter' || r.kind === 'summary_rolling')
                && !snapshotIds.has(r.id)
                && r.createdAt >= snapshot.createdAt
                && r.status !== 'archived'
            ))) {
                this.data.update('memory_records', rec.id, {
                    status: 'archived',
                    invalidated: true,
                    invalidatedReason: `快照回滚（${snapshot.id}）`,
                    invalidatedAt: now,
                    updatedAt: now,
                });
                archived += 1;
            }
        });

        this.logger?.info?.('snapshot.restored', { snapshotId: id, restored, archived });
        return { restored, archived, snapshotId: id, at: now };
    }
}
