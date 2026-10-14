/**
 * 桥接客户端：与本地大聪明记忆服务通信。
 *
 * 三种模式（需求 2.2 / 4.5）：
 *   0. 同源内嵌（首选）：SillyTavern 服务端插件直接提供记忆服务，
 *      `/api/plugins/dacongming/*`，随 ST 启停、无端口、无配对；
 *   1. 同源桥接（手机/LAN 可用）：通过 ST 服务端代理插件
 *      `/api/plugins/dacongming-memory/proxy/*` 转发到独立服务，复用 ST 会话鉴权；
 *   2. 直连 loopback：浏览器直接访问 http://127.0.0.1:PORT，使用配对凭证。
 *
 * 任何请求失败都抛出 BridgeError（带 status / fixActions），
 * 由调用方决定降级（拦截器失败必须原样放行）。
 */

export const DEFAULT_DIRECT_BASE = 'http://127.0.0.1:8787';
/** 独立服务代理插件的前缀；业务请求走其 /proxy/* 转发（/health 为专用探测接口）。 */
export const BRIDGE_PREFIX = '/api/plugins/dacongming-memory';
export const BRIDGE_PROXY_BASE = `${BRIDGE_PREFIX}/proxy`;
/** 内嵌服务端插件的前缀（路由已由插件挂载，不再带 /api 前缀）。 */
export const PLUGIN_PREFIX = '/api/plugins/dacongming';

/**
 * 构造请求 URL。
 *
 * - plugin：宿主挂在 `/api/plugins/dacongming`，路由不含 `/api` 前缀 → 去掉路径里的 `/api`
 * - bridge：宿主只在 `/proxy/*` 下转发 → 补上 `/proxy`，后面保留原始服务路径
 * - direct：base 即服务地址
 */
export function buildUrl(mode, base, path) {
    if (mode === 'plugin') return `${PLUGIN_PREFIX}${String(path).replace(/^\/api(?=\/|$)/, '')}`;
    if (mode === 'bridge') return `${BRIDGE_PROXY_BASE}${path}`;
    return `${base}${path}`;
}

/** GET/HEAD/OPTIONS 不触发 SillyTavern 的 CSRF 校验。 */
export function isSafeMethod(method) {
    return ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

export class BridgeError extends Error {
    constructor(message, { status = 0, fixActions = [], code = 'BRIDGE_ERROR' } = {}) {
        super(message);
        this.name = 'BridgeError';
        this.status = status;
        this.fixActions = fixActions;
        this.code = code;
    }
}

export class BridgeClient {
    /**
     * @param {{ getMode: () => {mode: string, base: string, token: string|null},
     *           fetchImpl?: Function, timeoutMs?: number }} opts
     */
    constructor(opts) {
        this.getMode = opts.getMode;
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.timeoutMs = opts.timeoutMs ?? 15_000;
        /** 同源模式下的 SillyTavern CSRF 令牌缓存（见 #ensureCsrfToken） */
        this.csrfToken = null;
        this.csrfPending = null;
    }

    /**
     * 探测内嵌服务端插件是否可用（装了大聪明的 ST 服务端插件时为真）。
     */
    static async detectPlugin(fetchImpl = globalThis.fetch) {
        try {
            const res = await fetchImpl(`${PLUGIN_PREFIX}/health`, { method: 'GET' });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.ok ? data : null;
        } catch {
            return null;
        }
    }

    /**
     * 探测同源桥接是否可用（已安装独立服务的代理插件，且独立服务在运行）。
     */
    static async detectBridge(fetchImpl = globalThis.fetch) {
        try {
            const res = await fetchImpl(`${BRIDGE_PREFIX}/health`, { method: 'GET' });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.ok ? data : null;
        } catch {
            return null;
        }
    }

    async request(method, path, body = null, { timeoutMs = null, raw = false, retriedCsrf = false } = {}) {
        const { mode, base, token } = this.getMode();
        if (!base && mode !== 'plugin' && mode !== 'bridge') {
            throw new BridgeError('尚未连接本地服务', {
                code: 'NOT_CONNECTED',
                fixActions: [
                    '安装大聪明的 SillyTavern 服务端插件（推荐，无需窗口）',
                    '或运行“启动大聪明.cmd”启动本地服务后点击“连接服务”',
                ],
            });
        }
        const sameOrigin = mode === 'plugin' || mode === 'bridge';
        const url = buildUrl(mode, base, path);

        // SillyTavern 在插件路由之前挂了 csrf-sync（server-main.js），
        // 同源的非 GET 请求必须带 X-CSRF-Token，否则 403 Invalid CSRF token。
        let csrf = {};
        if (sameOrigin && !isSafeMethod(method)) {
            const csrfToken = await this.#ensureCsrfToken();
            if (csrfToken) csrf = { 'X-CSRF-Token': csrfToken };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
        let res;
        try {
            res = await this.fetchImpl(url, {
                method,
                headers: {
                    ...(body ? { 'content-type': 'application/json' } : {}),
                    ...(token && mode === 'direct' ? { authorization: `Bearer ${token}` } : {}),
                    ...csrf,
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            throw new BridgeError(
                err.name === 'AbortError' ? '本地服务响应超时' : `无法连接本地服务：${err.message}`,
                {
                    code: 'NETWORK',
                    fixActions: mode === 'plugin'
                        ? ['确认 SillyTavern 控制台里有 [大聪明] 插件加载日志', '重启 SillyTavern 后重试']
                        : [
                            '确认“大聪明”本地服务正在运行（启动器窗口未关闭）',
                            '检查端口是否被防火墙拦截',
                            '在插件面板点击“重新连接”',
                        ],
                },
            );
        }
        clearTimeout(timer);

        let payload = null;
        try {
            payload = await res.json();
        } catch {
            payload = null;
        }

        // 令牌失效（例如 ST 重启过或页面放置过久）→ 刷新令牌重试一次
        if (res.status === 403 && sameOrigin && !retriedCsrf) {
            this.csrfToken = null;
            this.csrfPending = null;
            return this.request(method, path, body, { timeoutMs, raw, retriedCsrf: true });
        }
        if (!res.ok || payload?.ok === false) {
            throw new BridgeError(payload?.error ?? `服务返回 ${res.status}`, {
                status: res.status,
                fixActions: payload?.fixActions ?? defaultFixActions(res.status, mode),
                code: res.status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR',
            });
        }
        return raw ? payload : (payload ?? {});
    }

    /**
     * 取 SillyTavern 的 CSRF 令牌（同源模式用）。
     * 形状为 `{ token }`；未开启 CSRF 保护时返回 `'disabled'`，此时不必附带。
     */
    async #ensureCsrfToken() {
        if (this.csrfToken) return this.csrfToken;
        if (this.csrfPending) return this.csrfPending;
        this.csrfPending = (async () => {
            try {
                const res = await this.fetchImpl('/csrf-token', { method: 'GET' });
                const data = await res.json();
                this.csrfToken = data?.token && data.token !== 'disabled' ? data.token : null;
            } catch {
                this.csrfToken = null;
            } finally {
                this.csrfPending = null;
            }
            return this.csrfToken;
        })();
        return this.csrfPending;
    }

    // ---------------- 连接 ----------------
    health() { return this.request('GET', '/api/health', null, { timeoutMs: 4000 }); }
    status() { return this.request('GET', '/api/status'); }
    pairRequest(clientName) { return this.request('POST', '/api/pair/request', { clientName, origin: location.origin }, { timeoutMs: 6000 }); }
    pairConfirm(code) { return this.request('POST', '/api/pair/confirm', { code, origin: location.origin }, { timeoutMs: 6000 }); }

    // ---------------- 探针与摄取 ----------------
    probe(payload) { return this.request('POST', '/api/probe', payload); }
    ingest(payload) { return this.request('POST', '/api/ingest', payload, { timeoutMs: 20_000 }); }

    // ---------------- 计划 ----------------
    plan(payload) { return this.request('POST', '/api/plan', payload, { timeoutMs: 10_000 }); }
    preview(payload) { return this.request('POST', '/api/preview', payload, { timeoutMs: 10_000 }); }
    latestPlan(chatId) { return this.request('GET', `/api/plans/latest?chatId=${encodeURIComponent(chatId)}`); }
    feedback(planId, feedback) { return this.request('POST', `/api/plans/${encodeURIComponent(planId)}/feedback`, feedback); }

    // ---------------- 记忆中心 ----------------
    memories(query = {}) {
        const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        return this.request('GET', `/api/memories?${qs.toString()}`);
    }
    createMemory(payload) { return this.request('POST', '/api/memories', payload); }
    memoryAction(id, payload) { return this.request('PATCH', `/api/memories/${encodeURIComponent(id)}`, payload); }
    forgetMemory(id, reason) { return this.request('POST', `/api/memories/${encodeURIComponent(id)}/forget`, { reason }); }
    restoreMemory(id) { return this.request('POST', `/api/memories/${encodeURIComponent(id)}/restore`, {}); }
    forgetText(payload) { return this.request('POST', '/api/forget-text', payload); }
    purge(payload) { return this.request('POST', '/api/purge', payload); }
    listScopes() { return this.request('GET', '/api/scopes'); }
    renameScope(scope, name) { return this.request('POST', '/api/scopes/rename', { scope, name }); }
    deleteScope(scope, purgeTombstones = false) { return this.request('POST', '/api/scopes/delete', { scope, purgeTombstones }); }

    // ---------------- 快照 / 体检 / 索引 ----------------
    snapshots(scope) { return this.request('GET', `/api/snapshots?scope=${encodeURIComponent(scope ?? '')}`); }
    createSnapshot(payload) { return this.request('POST', '/api/snapshots', payload); }
    restoreSnapshot(id) { return this.request('POST', `/api/snapshots/${encodeURIComponent(id)}/restore`, {}); }
    healthCheck(scope) { return this.request('GET', `/api/health-check?scope=${encodeURIComponent(scope ?? '')}`); }
    healthFix(fix, ids) { return this.request('POST', '/api/health-check/fix', { fix, ids }); }
    rebuildIndex() { return this.request('POST', '/api/index/rebuild', {}); }
    probeInfo(chatId) { return this.request('GET', `/api/probe?chatId=${encodeURIComponent(chatId ?? 'default')}`); }

    // ---------------- 导出 / 导入 / 迁移 ----------------
    exportData(scope) { return this.request('GET', `/api/export?scope=${encodeURIComponent(scope ?? '')}`); }
    importPreview(payload) { return this.request('POST', '/api/import/preview', { payload }); }
    importApply(payload) { return this.request('POST', '/api/import/apply', { payload }); }
    migrateScan(payload, source, scope) { return this.request('POST', '/api/migrate/scan', { payload, source, scope }); }
    migrateApply(payload, opts) { return this.request('POST', '/api/migrate/apply', { payload, ...opts }); }
    migrateRollback(batchId) { return this.request('POST', '/api/migrate/rollback', { batchId }); }

    // ---------------- 任务 / 诊断 / 设置 ----------------
    tasks(status) { return this.request('GET', `/api/tasks${status ? `?status=${status}` : ''}`); }
    cancelTask(id) { return this.request('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, {}); }
    diagnostics(limit = 100) { return this.request('GET', `/api/diagnostics?limit=${limit}`); }
    getSettings() { return this.request('GET', '/api/settings'); }
    updateSettings(patch) { return this.request('POST', '/api/settings', patch); }
    scopeInfo(chatId, branchId) { return this.request('GET', `/api/scope?chatId=${encodeURIComponent(chatId)}&branchId=${encodeURIComponent(branchId ?? 'main')}`); }
    stats() { return this.request('GET', '/api/status'); }

    /** SSE 订阅（三种模式统一走 buildUrl 拼地址）。 */
    subscribe(onEvent, onError) {
        const { mode, base } = this.getMode();
        if (!base && mode !== 'plugin' && mode !== 'bridge') return () => {};
        if (typeof EventSource === 'undefined') return () => {};
        const es = new EventSource(buildUrl(mode, base, '/api/events'));
        const handler = (type) => (ev) => {
            try { onEvent({ type, data: JSON.parse(ev.data) }); } catch { /* ignore */ }
        };
        const types = ['hello', 'plan', 'plan_feedback', 'ingest', 'extract', 'summary', 'invalidation', 'health_fix', 'import', 'settings', 'migrate'];
        for (const type of types) es.addEventListener(type, handler(type));
        es.onerror = (err) => { onError?.(err); };
        return () => es.close();
    }
}

function defaultFixActions(status, mode = 'direct') {
    if (mode === 'plugin') {
        if (status === 403) {
            return ['刷新页面（F5）后重试：SillyTavern 重启后旧令牌会失效', '确认 SillyTavern 的 config.yaml 未被改动过 CSRF 相关设置'];
        }
        if (status === 404) {
            return ['确认 config.yaml 中 enableServerPlugins: true 并重启 SillyTavern', '确认 plugins/dacongming/ 已完整安装'];
        }
        if (status >= 500) {
            return ['查看 SillyTavern 控制台中的 [大聪明] 日志', '必要时删除该用户目录下的 dacongming/ 数据目录后重试'];
        }
        return ['在 SillyTavern 控制台查看 [大聪明] 插件日志', '重启 SillyTavern 后重试'];
    }
    if (status === 403) {
        if (mode === 'bridge') {
            return ['刷新页面（F5）后重试：SillyTavern 重启后旧令牌会失效', '确认已开启 SillyTavern 服务端插件并重启'];
        }
        return ['检查是否通过 SillyTavern 同源访问', 'LAN 模式需要在服务端显式开启'];
    }
    if (status === 401) {
        return ['在插件面板点击“连接服务”重新配对', '若服务重启后凭证失效，重新配对即可'];
    }
    if (status >= 500) {
        return ['查看本地服务窗口的错误日志', '尝试在启动器中重启服务'];
    }
    return [];
}
