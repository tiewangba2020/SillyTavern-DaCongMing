/**
 * 宿主胶水层与 SillyTavern 服务端插件（内嵌模式）的契约测试。
 *
 * 不依赖 express / SillyTavern：用伪造的 router/req/res 验证
 * 「路由注册 → 前缀剥离 → 处理器调用 → 响应映射 → 每用户隔离」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeService } from './helpers.js';
import {
    attachServiceRuntime,
    createInertService,
    createPluginSecurity,
    mountRoutesOnRouter,
    toMountPath,
    PLUGIN_BLOCKED_PREFIXES,
} from '../src/api/host.js';
import { resolveConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.resolve(SERVER_ROOT, '..', 'st-plugin', 'dacongming');

function makeFakeRouter() {
    const routes = [];
    const router = {};
    for (const method of ['get', 'post', 'patch', 'delete']) {
        router[method] = (pattern, handler) => {
            routes.push({ method: method.toUpperCase(), path: pattern, handler });
            return router;
        };
    }
    router.routes = routes;
    router.find = (method, pattern) => routes.find((r) => r.method === method && r.path === pattern);
    return router;
}

function makeRes() {
    const state = { status: 200, body: null, headers: {} };
    return {
        state,
        setHeader(k, v) { state.headers[k] = v; },
        status(code) { state.status = code; return this; },
        json(payload) { state.body = payload; return this; },
        write() { return true; },
        end() { /* noop */ },
    };
}

function makeReq({ body = null, query = {}, params = {}, user = null } = {}) {
    return { body, query, params, user, on: () => { /* noop */ } };
}

test('toMountPath：剥掉 /api 前缀，保留参数段', () => {
    assert.equal(toMountPath('/api/plan'), '/plan');
    assert.equal(toMountPath('/api/health'), '/health');
    assert.equal(toMountPath('/api/plans/:planId/feedback'), '/plans/:planId/feedback');
    assert.equal(toMountPath('/api'), '/');
    assert.equal(toMountPath('/apixyz'), '/apixyz');
});

test('固定服务模式：注册路由、跳过配对与关闭接口、处理器返回即响应', async () => {
    const ctx = await makeService();
    try {
        attachServiceRuntime({
            service: ctx.service,
            config: ctx.config,
            logger: ctx.logger,
            security: createPluginSecurity(),
        });
        const router = makeFakeRouter();
        const { mounted, skipped } = mountRoutesOnRouter(router, { service: ctx.service, logger: ctx.logger });

        assert.ok(mounted > 25, `应挂载多数路由，实际 ${mounted}`);
        assert.ok(router.find('GET', '/health'), 'GET /health 应已挂载');
        assert.ok(router.find('POST', '/plan'), 'POST /plan 应已挂载');
        assert.ok(router.find('POST', '/plans/:planId/feedback'), '带参数路由应保留参数段');
        assert.ok(router.find('GET', '/events'), '事件流应已挂载');

        for (const prefix of PLUGIN_BLOCKED_PREFIXES) {
            for (const route of skipped) {
                assert.ok(!route.startsWith(`${prefix} `), `${prefix} 不应被挂载`);
            }
        }
        assert.ok(skipped.includes('POST /api/pair/request'));
        assert.ok(skipped.includes('POST /api/shutdown'));

        // 健康检查：无需凭证也应可用（插件模式由 ST 负责鉴权）
        const res = makeRes();
        await router.find('GET', '/health').handler(makeReq(), res);
        assert.equal(res.state.status, 200);
        assert.equal(res.state.body.ok, true);
        assert.equal(res.state.body.service, 'dacongming-memory-service');
        assert.equal(res.state.body.paired, true, '插件模式应报告已连接');

        // 处理器抛错 → 400 + ok:false
        const planRes = makeRes();
        const planHandler = router.find('POST', '/plan').handler;
        await planHandler(makeReq({ body: null }), planRes);
        assert.ok([200, 400].includes(planRes.state.status));
        assert.equal(typeof planRes.state.body.ok, 'boolean');
    } finally {
        await ctx.cleanup();
    }
});

test('插件模式：解析式挂载按用户隔离服务，惰性建库并写入 seedSettings', async () => {
    const userRoots = [];
    const ctx = await makeService();
    try {
        attachServiceRuntime({
            service: ctx.service,
            config: ctx.config,
            logger: ctx.logger,
            security: createPluginSecurity(),
        });
        // 复用测试服务作为「内核」，但用真实的每用户服务工厂替换数据目录
        const { Service } = await import('../src/service.js');
        const { Logger } = await import('../src/util/logger.js');
        const built = [];
        const resolveService = (req) => {
            const root = req?.user?.directories?.root;
            if (!root) return Promise.reject(Object.assign(new Error('缺少 req.user'), { status: 401 }));
            const dataDir = path.join(root, 'dacongming');
            const found = built.find((b) => b.dataDir === dataDir);
            if (found) return Promise.resolve(found.service);
            return (async () => {
                fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ autoManage: true }), 'utf8');
                const config = resolveConfig({ dataDir });
                const service = await Service.create({ config, logger: new Logger({ level: 'error' }), storeKind: 'auto' });
                attachServiceRuntime({ service, config, logger: new Logger({ level: 'error' }), security: createPluginSecurity() });
                built.push({ dataDir, service });
                return service;
            })();
        };

        const router = makeFakeRouter();
        const { mounted } = mountRoutesOnRouter(router, { resolveService });
        assert.ok(mounted > 25);

        const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-plugin-a-'));
        const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-plugin-b-'));
        userRoots.push(rootA, rootB);

        const resA = makeRes();
        await router.find('GET', '/health').handler(makeReq({ user: { directories: { root: rootA } } }), resA);
        assert.equal(resA.state.body.ok, true);

        // 同一用户第二次请求复用同一个 service（不重复建库）
        await router.find('GET', '/health').handler(makeReq({ user: { directories: { root: rootA } } }), makeRes());
        assert.equal(built.length, 1, '同一用户应复用实例');

        // 另一个用户 → 独立数据目录
        await router.find('GET', '/health').handler(makeReq({ user: { directories: { root: rootB } } }), makeRes());
        assert.equal(built.length, 2, '不同用户应各自建库');
        assert.ok(fs.existsSync(path.join(rootA, 'dacongming', 'settings.json')));
        assert.notEqual(built[0].dataDir, built[1].dataDir);

        // 缺少 req.user → 401
        const denyRes = makeRes();
        await router.find('GET', '/health').handler(makeReq(), denyRes);
        assert.equal(denyRes.state.status, 401);
        assert.equal(denyRes.state.body.ok, false);

        for (const item of built) await item.service.stop();
    } finally {
        await ctx.cleanup();
        for (const dir of userRoots) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
});

test('惰性模板：可直接产出路由清单而不触达任何服务方法', () => {
    const inert = createInertService();
    // 模板上的成员访问不应抛错；调用才抛
    assert.doesNotThrow(() => { void inert.memories.list; void inert.config; });
    assert.throws(() => inert.memories.list({}), /模板路由不可执行/);
});

test('插件安全兼容层与 Security.status() 形状一致', () => {
    const pluginSecurity = createPluginSecurity();
    const fake = pluginSecurity.status();
    // 字段必须覆盖 Security.status() 的全部键（/api/status 与 /api/health 会读取）
    for (const key of ['paired', 'allowedOrigins', 'tokenCreatedAt', 'lanMode', 'pairingActive']) {
        assert.ok(key in fake, `缺少字段 ${key}`);
    }
    assert.equal(fake.paired, true, '插件模式由 ST 鉴权，恒为已连接');
    assert.deepEqual(fake.allowedOrigins, []);
    assert.equal(pluginSecurity.verifyToken(), true);
    assert.equal(pluginSecurity.checkOrigin().ok, true);
    assert.equal(pluginSecurity.checkCsrf().ok, true);
});

test('resolveConfig：按指定数据目录派生全部路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-cfg-'));
    try {
        const config = resolveConfig({ dataDir: dir });
        assert.equal(config.dataDir, dir);
        assert.equal(config.dbFile, path.join(dir, 'memory.sqlite'));
        assert.equal(config.journalDir, path.join(dir, 'journal'));
        assert.equal(config.settingsFile, path.join(dir, 'settings.json'));
        assert.equal(config.autoManage, false, '默认值保持与独立模式一致');
        assert.equal(config.shadowMode, 'first-n', '观察期必须是 first-n；布尔 true 会让事实永远停在 candidate');
        assert.equal(config.settingsPersisted, false, '尚未写入 settings.json');

        // 写入一次设置后应被识别为「已有用户配置」，客户端据此决定采用服务端值
        fs.writeFileSync(config.settingsFile, JSON.stringify({ autoManage: true }), 'utf8');
        const again = resolveConfig({ dataDir: dir });
        assert.equal(again.settingsPersisted, true);
        assert.equal(again.autoManage, true);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test('扩展侧 URL 映射：三种模式拼出的地址与插件实际挂载一致', async () => {
    const mod = await loadBridgeModule();

    // 内嵌插件：宿主挂在 /api/plugins/dacongming，路由不含 /api 前缀
    assert.equal(mod.PLUGIN_PREFIX, '/api/plugins/dacongming');
    assert.equal(mod.buildUrl('plugin', null, '/api/health'), '/api/plugins/dacongming/health');
    assert.equal(mod.buildUrl('plugin', null, '/api/plan'), '/api/plugins/dacongming/plan');
    assert.equal(
        mod.buildUrl('plugin', null, '/api/plans/abc/feedback'),
        '/api/plugins/dacongming/plans/abc/feedback',
    );
    assert.equal(mod.buildUrl('plugin', null, '/api/memories?scope=x'), '/api/plugins/dacongming/memories?scope=x');
    assert.equal(mod.buildUrl('plugin', null, '/api/events'), '/api/plugins/dacongming/events');

    // 同源桥接：代理插件只在 /proxy/* 下转发（D8 修复点）
    assert.equal(mod.BRIDGE_PROXY_BASE, '/api/plugins/dacongming-memory/proxy');
    assert.equal(
        mod.buildUrl('bridge', null, '/api/plan'),
        '/api/plugins/dacongming-memory/proxy/api/plan',
    );

    // 直连：base 即服务地址
    assert.equal(mod.buildUrl('direct', 'http://127.0.0.1:8787', '/api/plan'), 'http://127.0.0.1:8787/api/plan');

    // 插件路由清单里确实存在这些路径（挂载形式与 URL 必须对得上）
    const ctx = await makeService();
    try {
        attachServiceRuntime({
            service: ctx.service, config: ctx.config, logger: ctx.logger, security: createPluginSecurity(),
        });
        const router = makeFakeRouter();
        mountRoutesOnRouter(router, { service: ctx.service, logger: ctx.logger });
        for (const [method, mountedPath] of [
            ['GET', '/health'], ['POST', '/plan'], ['POST', '/plans/:planId/feedback'],
            ['GET', '/memories'], ['GET', '/events'],
        ]) {
            assert.ok(router.find(method, mountedPath), `${method} ${mountedPath} 应存在`);
        }
    } finally {
        await ctx.cleanup();
    }
});

/** 载入扩展侧 bridge.js（扩展目录无 package.json，按 ESM 求值以便单测）。 */
async function loadBridgeModule() {
    const bridgePath = path.resolve(SERVER_ROOT, '..', 'extension', 'dacongming', 'bridge.js');
    const source = fs.readFileSync(bridgePath, 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
}

function jsonResponse(body, status = 200) {
    return { ok: status < 400, status, json: async () => body };
}

test('同源模式自动附带 SillyTavern CSRF 令牌；403 时刷新令牌并重试一次', async () => {
    const mod = await loadBridgeModule();

    // ── 内嵌插件模式：POST 前先取 /csrf-token，并带上 X-CSRF-Token ──
    {
        const calls = [];
        let seq = 0;
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
            if (url === '/csrf-token') return jsonResponse({ token: `tok-${++seq}` });
            return jsonResponse({ ok: true });
        };
        const client = new mod.BridgeClient({
            getMode: () => ({ mode: 'plugin', base: null, token: null }),
            fetchImpl,
        });

        // GET 不需要令牌
        await client.request('GET', '/api/health');
        assert.equal(calls.filter((c) => c.url === '/csrf-token').length, 0, 'GET 不应触发令牌请求');

        await client.request('POST', '/api/plan', { chatId: 'c' });
        const csrfCalls = calls.filter((c) => c.url === '/csrf-token');
        assert.equal(csrfCalls.length, 1, '同源 POST 应取一次令牌');
        const post = calls.find((c) => c.method === 'POST');
        assert.equal(post.url, '/api/plugins/dacongming/plan');
        assert.equal(post.headers['X-CSRF-Token'], 'tok-1', 'POST 必须带上 CSRF 令牌');
        assert.equal(post.headers.authorization, undefined, '插件模式不需要 Bearer');

        // 第二次 POST 复用缓存令牌，不再重复取
        await client.request('POST', '/api/ingest', { messages: [] });
        assert.equal(calls.filter((c) => c.url === '/csrf-token').length, 1, '令牌应缓存复用');
    }

    // ── 直连模式：不带 CSRF，带 Bearer ──
    {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
            return jsonResponse({ ok: true });
        };
        const client = new mod.BridgeClient({
            getMode: () => ({ mode: 'direct', base: 'http://127.0.0.1:8787', token: 'pair-token' }),
            fetchImpl,
        });
        await client.request('POST', '/api/plan', {});
        assert.equal(calls.filter((c) => c.url === '/csrf-token').length, 0, '直连模式无需 CSRF');
        const post = calls.find((c) => c.method === 'POST');
        assert.equal(post.url, 'http://127.0.0.1:8787/api/plan');
        assert.equal(post.headers.authorization, 'Bearer pair-token');
    }

    // ── 403（令牌过期，例如 ST 重启过）→ 刷新令牌并重试一次即成功 ──
    {
        const calls = [];
        let seq = 0;
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
            if (url === '/csrf-token') return jsonResponse({ token: `tok-${++seq}` });
            const posts = calls.filter((c) => c.method === 'POST' && c.url !== '/csrf-token');
            if (posts.length === 1) return jsonResponse({ error: 'Invalid CSRF token.' }, 403);
            return jsonResponse({ ok: true, recovered: true });
        };
        const client = new mod.BridgeClient({
            getMode: () => ({ mode: 'plugin', base: null, token: null }),
            fetchImpl,
        });
        const result = await client.request('POST', '/api/plan', {});
        assert.equal(result.recovered, true, '重试后应成功');
        assert.equal(calls.filter((c) => c.method === 'POST').length, 2, '应恰好重试一次');
        assert.equal(calls.filter((c) => c.url === '/csrf-token').length, 2, '重试前应重新取令牌');
    }
});

test('插件入口：满足 SillyTavern plugin-loader 契约，并能在伪造 router 上完成一次请求', async () => {
    // 复制入口到临时目录，config.json 指向仓库内核，避免污染插件目录
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-plugin-stage-'));
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-plugin-user-'));
    let plugin = null;
    try {
        for (const file of ['index.mjs', 'package.json']) {
            fs.copyFileSync(path.join(PLUGIN_DIR, file), path.join(stage, file));
        }
        fs.writeFileSync(path.join(stage, 'config.json'), JSON.stringify({
            serverRoot: path.join(SERVER_ROOT, 'src'),
            dataSubdir: 'dacongming',
            storeKind: 'auto',
            logLevel: 'error',
            seedSettings: { autoManage: true, shadowMode: 'first-n', shadowTurns: 20 },
        }), 'utf8');

        const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
        assert.equal(pkg.type, 'module');
        assert.ok(!('main' in pkg), '不能有 main 字段，否则 SillyTavern 会按 npm 包加载');

        plugin = await import(pathToFileURL(path.join(stage, 'index.mjs')).href);

        // plugin-loader 的校验规则
        assert.equal(typeof plugin.info, 'object');
        for (const field of ['id', 'name', 'description']) {
            assert.equal(typeof plugin.info[field], 'string', `info.${field} 必须是字符串`);
        }
        assert.match(plugin.info.id, /^[a-z0-9_-]+$/);
        assert.equal(plugin.info.id, 'dacongming');
        assert.equal(typeof plugin.init, 'function');
        assert.equal(typeof plugin.exit, 'function');

        const router = makeFakeRouter();
        const result = await plugin.init(router);
        assert.ok(result.mounted > 25);
        assert.ok(router.find('GET', '/health'));

        const res = makeRes();
        await router.find('GET', '/health').handler(makeReq({ user: { directories: { root: userRoot } } }), res);
        assert.equal(res.state.body.ok, true);
        assert.equal(res.state.body.paired, true);

        // 每用户数据目录 + 首次播种设置（修复「记忆库永远为空」的默认值缺口）
        const dataDir = path.join(userRoot, 'dacongming');
        assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')));
        const seeded = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
        assert.equal(seeded.autoManage, true);
        assert.equal(seeded.shadowMode, 'first-n');
        assert.equal(seeded.shadowTurns, 20);

        // 摄取 + 计划全链路（走插件的解析式挂载）
        const ingestRes = makeRes();
        await router.find('POST', '/ingest').handler(makeReq({
            user: { directories: { root: userRoot } },
            body: {
                chatId: 'plugin-chat', branchId: 'main', scope: 'chat:plugin-chat',
                messages: [{ floorIndex: 0, content: '掌柜的，沈青崖的旧伤是怎么回事？', isUser: true, name: '你' }],
            },
        }), ingestRes);
        assert.notEqual(ingestRes.state.status, 404);
        assert.equal(ingestRes.state.body.ok, true);

        const planRes = makeRes();
        await router.find('POST', '/plan').handler(makeReq({
            user: { directories: { root: userRoot } },
            body: {
                chatId: 'plugin-chat', branchId: 'main', scope: 'chat:plugin-chat',
                userInput: '沈青崖的旧伤？',
                messages: [{ floorIndex: 0, content: '沈青崖的旧伤是怎么回事？', isUser: true }],
                budget: { contextLimit: 4096, outputReserve: 512 },
            },
        }), planRes);
        assert.equal(planRes.state.body.ok, true);
        assert.equal(typeof planRes.state.body.result, 'string');
    } finally {
        if (plugin?.exit) await plugin.exit();
        for (const dir of [stage, userRoot]) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
});
