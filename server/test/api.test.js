import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeServer, dialogue } from './helpers.js';

function rawRequest(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method, path: p, headers, setHost: false,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

test('健康检查无需鉴权；受保护接口缺少凭证 → 401 且带修复动作', async () => {
    const s = await makeServer();
    try {
        const health = await s.request('GET', '/api/health', { token: null });
        assert.equal(health.status, 200);
        assert.equal(health.payload.ok, true);
        assert.equal(health.payload.service, 'not-forgotten-memory-service');

        const status = await s.request('GET', '/api/status', { token: null });
        assert.equal(status.status, 401);
        assert.ok(status.payload.fixActions?.length >= 1);

        const wrong = await s.request('GET', '/api/status', { token: 'wrong-token' });
        assert.equal(wrong.status, 401);
    } finally {
        await s.cleanup();
    }
});

test('Host 校验：非 loopback Host 被拒绝（LAN 未开启）', async () => {
    const s = await makeServer();
    try {
        const res = await rawRequest(s.port, { path: '/api/health', headers: { host: 'evil.example.com' } });
        assert.equal(res.status, 403);
        assert.ok(res.body.includes('Host'));
    } finally {
        await s.cleanup();
    }
});

test('Origin 校验：未授权来源被拒绝，配对后放行', async () => {
    const s = await makeServer();
    try {
        const blocked = await rawRequest(s.port, {
            path: '/api/health',
            headers: { host: `127.0.0.1:${s.port}`, origin: 'https://evil.example' },
        });
        assert.equal(blocked.status, 403);

        // 配对时携带 origin → 进入白名单
        await s.request('POST', '/api/pair/request', { token: null, body: { clientName: 'test', origin: 'https://st.example' } });
        const code = s.service.security.pairing.code;
        const paired = await s.request('POST', '/api/pair/confirm', { token: null, body: { code, origin: 'https://st.example' } });
        assert.equal(paired.payload.ok, true);

        const allowed = await rawRequest(s.port, {
            path: '/api/health',
            headers: { host: `127.0.0.1:${s.port}`, origin: 'https://st.example' },
        });
        assert.equal(allowed.status, 200);
    } finally {
        await s.cleanup();
    }
});

test('CSRF 防护：写操作必须是 application/json', async () => {
    const s = await makeServer();
    try {
        const res = await rawRequest(s.port, {
            method: 'POST',
            path: '/api/plan',
            headers: {
                host: `127.0.0.1:${s.port}`,
                'content-type': 'text/plain',
                authorization: `Bearer ${s.token}`,
            },
            body: 'x=1',
        });
        assert.equal(res.status, 403);
        assert.ok(res.body.includes('CSRF'));
    } finally {
        await s.cleanup();
    }
});

test('配对流程：错误码拒绝、正确码颁发凭证、锁定保护', async () => {
    const s = await makeServer();
    try {
        const request = await s.request('POST', '/api/pair/request', { token: null, body: { clientName: 'SillyTavern' } });
        assert.equal(request.payload.ok, true);
        assert.ok(request.payload.hint.includes('启动器'));

        const bad = await s.request('POST', '/api/pair/confirm', { token: null, body: { code: '000001' } });
        assert.equal(bad.status, 400);

        const code = s.service.security.pairing.code;
        const good = await s.request('POST', '/api/pair/confirm', { token: null, body: { code } });
        assert.equal(good.payload.ok, true);
        assert.ok(good.payload.token);

        const status = await s.request('GET', '/api/status', { token: good.payload.token });
        assert.equal(status.status, 200);
        assert.equal(status.payload.ok, true);
    } finally {
        await s.cleanup();
    }
});

test('配对限流：超过尝试上限返回 429', async () => {
    const s = await makeServer();
    try {
        let last = null;
        for (let i = 0; i < 12; i += 1) {
            last = await s.request('POST', '/api/pair/request', { token: null, body: { clientName: 'x' } });
        }
        assert.equal(last.status, 429);
    } finally {
        await s.cleanup();
    }
});

test('完整流程：探针 → 摄取 → 计划 → 记忆列表 → 反馈 → 导出', async () => {
    const s = await makeServer({ settings: { autoManage: false } });
    try {
        const probe = await s.request('POST', '/api/probe', {
            body: {
                chatId: 'http-flow', contextLimit: 8192, outputReserve: 512,
                model: 'test-model', characterName: '林月',
                worldbookKeys: ['云栖镇', '龙渊剑'], tokenizerAvailable: true,
            },
        });
        assert.equal(probe.payload.ok, true);
        assert.equal(probe.payload.effective.contextLimit, 8192);

        const messages = dialogue([['你好，我是林月。', '欢迎来到云栖镇。']], { startFloor: 0 });
        const ingest = await s.request('POST', '/api/ingest', {
            body: { chatId: 'http-flow', branchId: 'main', scope: 'chat:http-flow', messages, fullSync: true },
        });
        assert.equal(ingest.payload.ok, true);
        assert.equal(ingest.payload.created, 2);

        // 手动添加一条记忆（用户固定）
        const created = await s.request('POST', '/api/memories', {
            body: { scope: 'chat:http-flow', chatId: 'http-flow', content: '林月的佩剑是霜华剑', kind: 'fact' },
        });
        assert.equal(created.payload.ok, true);

        const plan = await s.request('POST', '/api/plan', {
            body: {
                chatId: 'http-flow', branchId: 'main', scope: 'chat:http-flow',
                userInput: '我的佩剑叫什么？', messages,
                blocks: [{ id: 'fixed:sys', kind: 'system', text: '你是一个剧情助手。' }],
                budget: { contextLimit: 8192, outputReserve: 512 }, tier: 'balanced',
            },
        });
        assert.equal(plan.payload.ok, true);
        assert.ok(plan.payload.planId);
        assert.ok(plan.payload.injections.some((i) => i.text.includes('霜华剑')));

        const feedback = await s.request('POST', `/api/plans/${plan.payload.planId}/feedback`, { body: { accepted: true } });
        assert.equal(feedback.payload.ok, true);

        const memories = await s.request('GET', '/api/memories?scope=chat%3Ahttp-flow');
        assert.ok(memories.payload.total >= 1);

        const exported = await s.request('GET', '/api/export?scope=chat%3Ahttp-flow');
        assert.equal(exported.payload.export.exportVersion, 1);
        assert.ok(exported.payload.export.data.memory_records.length >= 1);

        const preview = await s.request('POST', '/api/import/preview', { body: { payload: exported.payload.export } });
        assert.equal(preview.payload.preview.ok, true);
        assert.equal(preview.payload.preview.counts.duplicate, exported.payload.export.data.memory_records.length);
    } finally {
        await s.cleanup();
    }
});

test('彻底删除需要显式确认；确认后清理副本并推进 epoch', async () => {
    const s = await makeServer();
    try {
        await s.request('POST', '/api/memories', {
            body: { scope: 'chat:purge-me', chatId: 'purge-me', content: '要被清理的记忆' },
        });
        const noConfirm = await s.request('POST', '/api/purge', { body: { scope: 'chat:purge-me' } });
        assert.equal(noConfirm.payload.ok, false);
        assert.ok(noConfirm.payload.fixActions?.length >= 1);

        const confirmed = await s.request('POST', '/api/purge', { body: { scope: 'chat:purge-me', confirm: 'DELETE' } });
        assert.equal(confirmed.payload.ok, true);
        assert.equal(confirmed.payload.memories, 1);
        assert.ok(confirmed.payload.epoch >= 1);
        assert.ok(confirmed.payload.note.includes('原始聊天未受影响'));
    } finally {
        await s.cleanup();
    }
});

test('SSE 事件订阅：收到 hello 事件', async () => {
    const s = await makeServer();
    try {
        const controller = new AbortController();
        const res = await fetch(`${s.base}/api/events`, {
            headers: { authorization: `Bearer ${s.token}` },
            signal: controller.signal,
        });
        assert.equal(res.status, 200);
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        assert.ok(text.includes('event: hello'), `收到：${text}`);
        controller.abort();
    } finally {
        await s.cleanup();
    }
});

test('未知接口返回 404（不泄露内部信息）', async () => {
    const s = await makeServer();
    try {
        const res = await s.request('GET', '/api/secret-internal');
        assert.equal(res.status, 404);
        assert.ok(res.payload.error.includes('未知接口'));
    } finally {
        await s.cleanup();
    }
});
