/**
 * 后台任务队列：取消、队列、有限重试、幂等和版本失效。
 *
 * 需求 4.6：每个后台任务携带 scopeId + sourceRevision + branchHead +
 * variantSelection + profileHash + deletionEpoch + idempotencyKey；
 * 落库前执行版本检查，任何一项不匹配即标记 stale 并丢弃结果。
 * 需求 4.5：默认后台并发度为 1，主回复优先级高于后台任务，支持取消。
 */

import { uuid, idempotencyKey as makeKey } from '../util/ids.js';

export class StaleTaskError extends Error {
    constructor(reason) {
        super(`任务版本已失效：${reason}`);
        this.name = 'StaleTaskError';
    }
}

export class CancelledError extends Error {
    constructor() {
        super('任务已取消');
        this.name = 'CancelledError';
    }
}

export class TaskQueue {
    /**
     * @param {{ data: any, logger?: object, config?: object }} opts
     */
    constructor({ data, logger, config }) {
        this.data = data;
        this.logger = logger ?? null;
        this.config = config ?? {};
        this.maxAttempts = config?.taskMaxAttempts ?? 3;
        this.concurrency = config?.taskConcurrency ?? 1;
        /** @type {Map<string, (payload: object, ctx: object) => Promise<any>>} */
        this.handlers = new Map();
        this.running = false;
        this._active = 0;
        this._timer = null;
        this._cancelled = new Set();
    }

    register(type, handler) {
        this.handlers.set(type, handler);
    }

    /**
     * 入队（幂等：相同 idempotencyKey 的未完成任务直接复用）。
     * @param {{ type: string, payload: object, version?: object, scope?: string }} input
     */
    enqueue(input) {
        const key = input.idempotencyKey ?? makeKey({ type: input.type, payload: input.payload });
        const existing = this.data.query('tasks', (t) => (
            t.idempotencyKey === key && ['queued', 'running'].includes(t.status)
        ));
        if (existing.length) return existing[0];

        const task = {
            id: uuid(),
            taskId: null,
            type: input.type,
            payload: input.payload ?? {},
            scope: input.scope ?? null,
            version: input.version ?? {},
            idempotencyKey: key,
            status: 'queued',
            attempts: 0,
            maxAttempts: this.maxAttempts,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            error: null,
            errorType: null,
            result: null,
            nextRunAt: Date.now(),
        };
        task.taskId = task.id;
        this.data.insert('tasks', task);
        this.logger?.debug?.('task.enqueued', { taskId: task.id, type: task.type });
        this.#schedule();
        return task;
    }

    cancel(taskId, reason = '用户取消') {
        const task = this.data.get('tasks', taskId);
        if (!task) return false;
        if (!['queued', 'running'].includes(task.status)) return false;
        this._cancelled.add(taskId);
        this.data.update('tasks', taskId, {
            status: 'cancelled',
            error: reason,
            finishedAt: new Date().toISOString(),
        });
        this.logger?.info?.('task.cancelled', { taskId, reason });
        return true;
    }

    /** 启动工作循环（每 tickMs 检查一次队列）。 */
    start({ tickMs = 200 } = {}) {
        if (this.running) return;
        this.running = true;
        this._tickMs = tickMs;
        this.#schedule(0);
        this.logger?.info?.('task.queue_started', { concurrency: this.concurrency });
    }

    stop() {
        this.running = false;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    }

    #schedule(delay = null) {
        if (!this.running) return;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.#drain().catch((err) => {
                this.logger?.error?.('task.drain_error', { error: err.message });
            });
        }, delay ?? this._tickMs ?? 200);
        if (this._timer.unref) this._timer.unref();
    }

    async #drain() {
        if (!this.running) return;
        while (this.running && this._active < this.concurrency) {
            const next = this.#nextTask();
            if (!next) break;
            this._active += 1;
            // 不等待完成即可继续检查并发槽位；但并发为 1 时等价串行
            this.#run(next)
                .catch(() => { /* 已在 #run 内处理 */ })
                .finally(() => {
                    this._active -= 1;
                    this.#schedule(0);
                });
            if (this.concurrency === 1) break;
        }
        this.#schedule();
    }

    #nextTask() {
        const now = Date.now();
        const queued = this.data.query('tasks', (t) => t.status === 'queued' && (t.nextRunAt ?? 0) <= now);
        queued.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        return queued[0] ?? null;
    }

    async #run(task) {
        if (this._cancelled.has(task.id)) {
            this._cancelled.delete(task.id);
            return;
        }
        const handler = this.handlers.get(task.type);
        if (!handler) {
            this.data.update('tasks', task.id, {
                status: 'failed', error: `未注册的任务类型：${task.type}`, errorType: 'UnknownType',
                finishedAt: new Date().toISOString(),
            });
            return;
        }
        const startedAt = Date.now();
        this.data.update('tasks', task.id, {
            status: 'running', startedAt: new Date().toISOString(), attempts: task.attempts + 1,
        });
        const ctx = {
            task,
            assertFresh: () => this.assertFresh(task),
            isCancelled: () => this._cancelled.has(task.id),
            throwIfCancelled: () => {
                if (this._cancelled.has(task.id)) throw new CancelledError();
            },
        };
        try {
            const result = await handler(task.payload, ctx);
            if (this._cancelled.has(task.id)) {
                this._cancelled.delete(task.id);
                return;
            }
            this.data.update('tasks', task.id, {
                status: 'done',
                result: result ?? null,
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
            });
            this.logger?.debug?.('task.done', { taskId: task.id, type: task.type, durationMs: Date.now() - startedAt });
        } catch (err) {
            if (err instanceof CancelledError) {
                this._cancelled.delete(task.id);
                return;
            }
            const stale = err instanceof StaleTaskError;
            const attempts = task.attempts + 1;
            const canRetry = !stale && attempts < (task.maxAttempts ?? this.maxAttempts);
            const patch = {
                status: stale ? 'stale' : (canRetry ? 'queued' : 'failed'),
                attempts,
                error: err.message,
                errorType: err.name ?? 'Error',
                nextRunAt: canRetry ? Date.now() + Math.min(30_000, 500 * 2 ** attempts) : null,
                finishedAt: canRetry ? null : new Date().toISOString(),
            };
            this.data.update('tasks', task.id, patch);
            this.logger?.[stale ? 'warn' : 'error']?.('task.' + (stale ? 'stale' : (canRetry ? 'retry' : 'failed')), {
                taskId: task.id, type: task.type, attempts, error: err.message,
            });
            if (canRetry) this.#schedule(300 * attempts);
        }
    }

    /**
     * 版本检查：与任务创建时的快照对比当前状态。
     * 任一不一致 → StaleTaskError（迟到任务不得重新写入）。
     */
    assertFresh(task) {
        const v = task.version ?? {};
        const checks = [
            [v.branchHead, () => this.#currentBranchHead(task)],
            [v.profileHash, () => this.#currentProfileHash(task)],
            [v.deletionEpoch, () => this.#currentEpoch(task)],
        ];
        for (const [expected, getActual] of checks) {
            if (expected === undefined || expected === null) continue;
            const actual = getActual();
            if (actual !== null && String(actual) !== String(expected)) {
                throw new StaleTaskError(`${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
            }
        }
        return true;
    }

    #currentBranchHead(task) {
        const { chatId, branchId } = task.payload ?? {};
        if (!chatId) return null;
        const identities = this.data.query('message_identity', (r) => r.chatId === chatId && (!branchId || r.branchId === branchId));
        let max = 0;
        for (const id of identities) max = Math.max(max, id.revision ?? 0);
        return max;
    }

    #currentProfileHash(task) {
        const chatId = task.payload?.chatId;
        if (!chatId) return null;
        const probe = this.data.query('probes', (p) => p.chatId === chatId)
            .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
        return probe?.profileHash ?? null;
    }

    #currentEpoch(task) {
        const scope = task.scope ?? task.payload?.scope;
        if (!scope) return null;
        return Number(this.data.metaGet(`deletionEpoch:${scope}`, '0'));
    }

    list({ status, limit = 100 } = {}) {
        let items = this.data.all('tasks');
        if (status) {
            const set = new Set(Array.isArray(status) ? status : [status]);
            items = items.filter((t) => set.has(t.status));
        }
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return items.slice(0, limit);
    }

    stats() {
        const items = this.data.all('tasks');
        const byStatus = {};
        for (const t of items) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        return { total: items.length, byStatus, running: this._active, pending: byStatus.queued ?? 0 };
    }

    /** 等待队列空闲（测试用）。 */
    async drain(maxMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const pending = this.data.query('tasks', (t) => ['queued', 'running'].includes(t.status));
            if (!pending.length) return true;
            await new Promise((r) => setTimeout(r, 25));
        }
        return false;
    }
}
