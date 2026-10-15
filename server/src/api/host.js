/**
 * 宿主胶水层：让同一套核心既能以「独立 HTTP 服务」运行（走 api/server.js），
 * 也能以「SillyTavern 服务端插件」运行（走 st-plugin/not-forgotten）。
 *
 * 只依赖 Node 标准库与 express 风格的 router 接口（router.get/post/... 与 res.status().json()），
 * 不引入任何第三方依赖。
 */

import { createRoutes } from './routes.js';
import { persistSettings, PERSISTED_SETTING_KEYS } from '../config.js';

/**
 * 装配与宿主无关的运行时能力（安全状态、日志、设置写入口）。
 * 独立模式与插件模式都调用它，保证 service 暴露的接口一致。
 */
export function attachServiceRuntime({ service, config, logger, security = null }) {
    if (security) service.security = security;
    service.logger = logger;
    service.updateSettings = (patch) => {
        for (const key of PERSISTED_SETTING_KEYS) {
            if (patch[key] !== undefined) config[key] = patch[key];
        }
        if (patch.tier) config.tier = patch.tier;
        persistSettings(config);
        service.bus.emit('settings', patch);
        return { ok: true, settings: patch };
    };
    return service;
}

/**
 * 插件模式的安全兼容层。
 *
 * SillyTavern 的服务端插件路由挂在 `requireLoginMiddleware` 之后
 * （见 SillyTavern/src/server-main.js），请求已由 ST 自身鉴权并带上 `req.user`，
 * 因此这里不再做配对/令牌/CSRF 校验，只提供与 `Security` 同形状的只读状态，
 * 供 `/api/health`、`/api/status` 之类的接口读取。
 */
export function createPluginSecurity({ user = null } = {}) {
    return {
        mode: 'sillytavern-plugin',
        user,
        status: () => ({
            paired: true,
            allowedOrigins: [],
            tokenCreatedAt: null,
            lanMode: false,
            pairingActive: false,
            mode: 'sillytavern-plugin',
        }),
        verifyToken: () => true,
        checkHost: () => ({ ok: true }),
        checkOrigin: () => ({ ok: true }),
        checkCsrf: () => ({ ok: true }),
        rateLimit: () => ({ ok: true }),
    };
}

/**
 * 组装一个可用的服务实例（含运行时能力）。
 */
export async function createHostedService({ Service, config, logger, storeKind = 'auto', security = null }) {
    const service = await Service.create({ config, logger, storeKind });
    attachServiceRuntime({ service, config, logger, security });
    return service;
}

/** 插件模式下不应暴露的路由前缀（配对无意义；shutdown 会连带停掉 SillyTavern）。 */
export const PLUGIN_BLOCKED_PREFIXES = Object.freeze(['/api/pair', '/api/shutdown']);

/** `/api/plan` → `/plan`；宿主已用 `/api/plugins/<id>` 作前缀挂载。 */
export function toMountPath(routePath) {
    const stripped = String(routePath).replace(/^\/api(?=\/|$)/, '');
    return stripped === '' ? '/' : stripped;
}

/**
 * 只用于枚举「方法 + 路径」的惰性服务模板。
 * `createRoutes` 只在处理器内部触达 service，因此该模板不会被真正调用。
 */
export function createInertService() {
    const cache = new Map();
    const callable = () => {
        throw new Error('插件模式：模板路由不可执行');
    };
    const anyProxy = new Proxy(callable, {
        get(_target, prop) {
            if (prop === 'then') return undefined;
            if (!cache.has(prop)) cache.set(prop, anyProxy);
            return cache.get(prop);
        },
        apply: callable,
    });
    return new Proxy({}, {
        get(_target, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'config' || prop === 'startedAt') return {};
            return anyProxy;
        },
    });
}

/**
 * 把声明式路由表挂到 express 风格 router 上。
 *
 * 两种模式：
 *   - 固定服务（独立进程内测/测试）：传 `service`
 *   - 按请求解析服务（SillyTavern 多用户插件）：传 `resolveService(req)`，
 *     路由清单由惰性模板枚举，真正执行时取该用户自己的路由表
 *
 * @param {{ get: Function, post: Function, patch: Function, delete: Function }} router
 * @param {{
 *   service?: object,
 *   resolveService?: (req: any) => Promise<any>,
 *   logger?: object,
 *   blocked?: readonly string[],
 * }} options
 * @returns {{ mounted: number, skipped: string[] }}
 */
export function mountRoutesOnRouter(router, options = {}) {
    const { service = null, resolveService = null, logger = null, blocked = PLUGIN_BLOCKED_PREFIXES } = options;
    if (!service && !resolveService) throw new Error('mountRoutesOnRouter 需要 service 或 resolveService');
    const template = createRoutes(service ?? createInertService());
    const skipped = [];
    let mounted = 0;

    for (const route of template) {
        if (blocked.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`))) {
            skipped.push(`${route.method} ${route.path}`);
            continue;
        }
        const method = String(route.method ?? '').toLowerCase();
        if (typeof router[method] !== 'function') {
            skipped.push(`${route.method} ${route.path}`);
            continue;
        }
        const handler = resolveService
            ? makeResolvingHandler({ route, resolveService, logger })
            : makeHandler({ route, logger });
        router[method](toMountPath(route.path), handler);
        mounted += 1;
    }

    // 事件流（独立模式下由 api/server.js 处理 /api/events）
    router.get('/events', (req, res) => {
        const stream = (svc) => {
            if (typeof res.setHeader !== 'function' || typeof res.write !== 'function') {
                res.status(501).json({ ok: false, error: '当前宿主不支持事件流' });
                return;
            }
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
            const unsubscribe = svc.bus.subscribe((event) => {
                try {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                } catch { /* 客户端已断开 */ }
            });
            const keepalive = setInterval(() => {
                try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
            }, 25_000);
            const close = () => {
                clearInterval(keepalive);
                unsubscribe();
            };
            req.on?.('close', close);
            req.on?.('error', close);
        };

        if (resolveService) {
            resolveService(req).then(stream).catch((err) => respondError(res, err, { logger, route: { method: 'GET', path: '/events' } }));
            return;
        }
        stream(service);
    });
    mounted += 1;

    return { mounted, skipped };
}

function makeHandler({ route, logger }) {
    return async function handle(req, res) {
        const startedAt = Date.now();
        try {
            const result = await route.handler({
                body: req.body ?? null,
                query: req.query ?? {},
                params: req.params ?? {},
                req,
            });
            respond(res, result);
            logger?.debug?.('plugin.request', {
                method: route.method, path: route.path, elapsedMs: Date.now() - startedAt,
            });
        } catch (err) {
            respondError(res, err, { logger, route });
        }
    };
}

function makeResolvingHandler({ route, resolveService, logger }) {
    const tables = new WeakMap();
    return async function handle(req, res) {
        const startedAt = Date.now();
        try {
            const service = await resolveService(req);
            let table = tables.get(service);
            if (!table) {
                table = createRoutes(service);
                tables.set(service, table);
            }
            const actual = table.find((r) => r.method === route.method && r.path === route.path);
            if (!actual) {
                return res.status(404).json({ ok: false, error: `未知接口：${route.method} ${route.path}` });
            }
            const result = await actual.handler({
                body: req.body ?? null,
                query: req.query ?? {},
                params: req.params ?? {},
                req,
            });
            respond(res, result);
            logger?.debug?.('plugin.request', {
                method: route.method, path: route.path, elapsedMs: Date.now() - startedAt,
            });
        } catch (err) {
            respondError(res, err, { logger, route });
        }
    };
}

function respond(res, result) {
    const status = result && result.ok === false ? 400 : 200;
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(status).json(result ?? { ok: true });
        return;
    }
    res.end?.(JSON.stringify(result ?? { ok: true }));
}

function respondError(res, err, { logger = null, route = null } = {}) {
    logger?.warn?.('plugin.handler_error', {
        route: route ? `${route.method} ${route.path}` : null, error: err?.message,
    });
    const status = Number.isInteger(err?.status) ? err.status : 400;
    const payload = {
        ok: false,
        error: err?.message ?? '处理失败',
        fixActions: err?.fixActions ?? undefined,
    };
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(status).json(payload);
        return;
    }
    res.end?.(JSON.stringify(payload));
}
