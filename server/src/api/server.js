/**
 * HTTP 服务：安全中间件 + 路由分发 + SSE 事件订阅。
 * 也提供“修复模式”服务器：数据库迁移失败时仍可启动，
 * 暴露修复动作（重试迁移 / 从备份恢复）而不是直接崩溃。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRoutes } from './routes.js';
import { Security } from './security.js';
import { attachServiceRuntime } from './host.js';
import { readJsonFile } from '../config.js';

export function createHttpServer({ service, config, logger }) {
    const security = new Security({ config, logger });
    attachServiceRuntime({ service, config, logger, security });
    const routes = createRoutes(service);

    const server = http.createServer((req, res) => {
        handleRequest({ req, res, routes, security, config, logger, service }).catch((err) => {
            logger?.error?.('http.unhandled', { error: err.message, url: req.url });
            sendJson(res, 500, { ok: false, error: `内部错误：${err.message}` });
        });
    });

    server.on('error', (err) => {
        logger?.error?.('http.server_error', { error: err.message, code: err.code });
    });

    return server;
}

async function handleRequest({ req, res, routes, security, config, logger, service }) {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const ip = req.socket.remoteAddress ?? 'unknown';

    // Host / Origin / CSRF
    const hostCheck = security.checkHost(req);
    if (!hostCheck.ok) return sendJson(res, 403, { ok: false, error: hostCheck.reason });
    const originCheck = security.checkOrigin(req);
    if (!originCheck.ok) return sendJson(res, 403, { ok: false, error: originCheck.reason, fixActions: ['在插件面板完成配对', '或在启动参数中显式开启 LAN 模式'] });
    const csrfCheck = security.checkCsrf(req);
    if (!csrfCheck.ok) return sendJson(res, 403, { ok: false, error: csrfCheck.reason });

    // CORS
    if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // SSE 订阅（需要鉴权）
    if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!security.verifyToken(req)) return sendJson(res, 401, { ok: false, error: '未授权：请先完成配对' });
        return handleSse({ req, res, service, logger });
    }

    // 路由匹配
    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) return sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${url.pathname}` });

    const route = match.route;
    const bucket = route.bucket ?? 'api';
    const limit = security.rateLimit(ip, bucket);
    if (!limit.ok) {
        res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
        return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
    }

    if (route.auth && !security.verifyToken(req)) {
        return sendJson(res, 401, {
            ok: false,
            error: '未授权：缺少或错误的凭证',
            fixActions: ['在插件面板点击“连接服务”完成配对', '若凭证已重置，请重新配对'],
        });
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        try {
            body = await readBody(req, config.maxBodyBytes);
        } catch (err) {
            return sendJson(res, 413, { ok: false, error: err.message });
        }
    }

    try {
        const result = await route.handler({
            body,
            query: Object.fromEntries(url.searchParams.entries()),
            params: match.params,
            req,
        });
        const status = result && result.ok === false ? 400 : 200;
        sendJson(res, status, result);
        logger?.debug?.('http.request', {
            method: req.method, path: url.pathname, status, elapsedMs: Date.now() - startedAt,
        });
    } catch (err) {
        logger?.warn?.('http.handler_error', {
            method: req.method, path: url.pathname, error: err.message,
        });
        sendJson(res, 400, {
            ok: false,
            error: err.message,
            fixActions: err.fixActions ?? undefined,
        });
    }
}

function handleSse({ req, res, service, logger }) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const unsubscribe = service.bus.subscribe((event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
        clearInterval(keepalive);
        unsubscribe();
        logger?.debug?.('sse.closed', {});
    });
}

function matchRoute(routes, method, pathname) {
    for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchPath(route.path, pathname);
        if (params) return { route, params };
    }
    return null;
}

function matchPath(pattern, pathname) {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) return null;
    const params = {};
    for (let i = 0; i < patternParts.length; i += 1) {
        const p = patternParts[i];
        if (p.startsWith(':')) {
            params[p.slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (p !== pathParts[i]) {
            return null;
        }
    }
    return params;
}

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error(`请求体过大（>${Math.round(maxBytes / 1024 / 1024)}MB）`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve(null);
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`JSON 解析失败：${err.message}`));
            }
        });
        req.on('error', reject);
    });
}

export function sendJson(res, status, payload) {
    const body = JSON.stringify(payload ?? {}, null, 0);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/**
 * 修复模式服务器：数据库迁移失败等致命初始化错误时启动。
 * 只暴露状态与修复动作，不提供任何数据写入。
 */
export function createRepairServer({ config, logger, error, serviceFactory }) {
    const security = new Security({ config, logger });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!security.rateLimit(ip, 'api').ok) return sendJson(res, 429, { ok: false, error: '请求过于频繁' });
        const hostCheck = security.checkHost(req);
        if (!hostCheck.ok) return sendJson(res, 403, { ok: false, error: hostCheck.reason });

        if (req.method === 'GET' && url.pathname === '/api/health') {
            return sendJson(res, 200, {
                ok: false,
                status: '需要处理',
                reason: '数据库迁移失败，服务处于修复模式（原始聊天未受影响）',
                error: error.message,
                migrationVersion: error.version ?? null,
                fixActions: [
                    { action: 'retry', label: '重试迁移', endpoint: 'POST /api/repair/retry' },
                    { action: 'restore-backup', label: '从最近备份恢复', endpoint: 'POST /api/repair/restore-latest' },
                    { action: 'manual', label: '手动处理', hint: `数据目录：${config.dataDir}；备份目录：${config.backupDir}` },
                ],
            });
        }
        if (req.method === 'POST' && url.pathname === '/api/repair/retry') {
            if (!security.verifyToken(req)) {
                return sendJson(res, 401, { ok: false, error: '需要凭证（配对后可重试）' });
            }
            try {
                await serviceFactory();
                sendJson(res, 200, { ok: true, note: '迁移已成功，请重启服务' });
            } catch (err) {
                sendJson(res, 400, { ok: false, error: `重试失败：${err.message}` });
            }
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/repair/restore-latest') {
            if (!security.verifyToken(req)) {
                return sendJson(res, 401, { ok: false, error: '需要凭证' });
            }
            try {
                const files = fs.existsSync(config.backupDir)
                    ? fs.readdirSync(config.backupDir).filter((f) => f.endsWith('.sqlite') || f.endsWith('.json'))
                    : [];
                if (!files.length) return sendJson(res, 400, { ok: false, error: '没有可用备份' });
                files.sort();
                const latest = path.join(config.backupDir, files[files.length - 1]);
                const { openAdapter } = await import('../store/adapter.js');
                const adapter = await openAdapter({ kind: 'sqlite', dataDir: config.dataDir, dbFile: config.dbFile, journalDir: config.journalDir, logger });
                await adapter.restoreFrom(latest);
                adapter.close();
                sendJson(res, 200, { ok: true, restoredFrom: latest, note: '已从备份恢复，请重启服务' });
            } catch (err) {
                sendJson(res, 400, { ok: false, error: `恢复失败：${err.message}` });
            }
            return;
        }
        sendJson(res, 404, { ok: false, error: '修复模式只提供 /api/health、/api/repair/retry、/api/repair/restore-latest' });
    });
    return server;
}

export { readJsonFile };
