import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeSafeJevProvider, JevError } from '../src/providers/jev.js';
import { RuleDecisionProvider, DecisionCache, createDecisionRouter, validateDecision } from '../src/providers/decision.js';

function jevFetch(answers, { status = 200 } = {}) {
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ answers }),
    });
}

const validAnswers = {
    intent: { type: 'choice', choice: 'question', confidence: 0.9 },
    memoryNeed: { type: 'choice', choice: 'facts', confidence: 0.8 },
    compressionLevel: { type: 'choice', choice: 'light', confidence: 0.85 },
    needsRecall: { type: 'noul', noul: 0.8 },
    conflictRisk: { type: 'score', score: 0.1, confidence: 0.7 },
    importance: { type: 'score', score: 0.6, confidence: 0.7 },
};

const input = () => ({
    query: '林月的佩剑叫什么？',
    candidates: [{ id: 'm1', kind: 'fact', text: '林月的佩剑是霜华剑', reason: '关键词匹配' }],
    budget: { availableInput: 3000 },
    currentTokens: 1200,
    tier: { id: 'balanced' },
});

test('Jev 成功路径：一次请求并行窄问题 → 映射为受约束决策', async () => {
    const provider = new TypeSafeJevProvider({ endpoint: 'http://jev.local/v1/systemone', fetchImpl: jevFetch(validAnswers) });
    const decision = await provider.decide(input());
    assert.equal(decision.provider, 'jev');
    assert.equal(decision.intent, 'question');
    assert.deepEqual(decision.memoryNeeds, ['facts']);
    assert.equal(decision.compressionLevel, 'light');
    assert.ok(decision.confidence > 0.4);
    assert.equal(decision.importance, 0.6);
    validateDecision(decision);
});

test('Jev 请求体符合 TypeSafe 官方 API 格式（questions 对象 + criteria + noul instructions）', async () => {
    let captured = null;
    const provider = new TypeSafeJevProvider({
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        apiKey: 'k-test',
        model: 'jev-latest',
        instructionsSet: 'v2',
        fetchImpl: async (url, opts) => {
            captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
            return { ok: true, status: 200, json: async () => ({ answers: validAnswers }) };
        },
    });
    await provider.decide(input());
    assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(captured.headers.authorization, 'Bearer k-test');
    assert.equal(captured.body.model, 'jev-latest');
    // questions 必须是对象（按 id 键），choice 用 criteria 描述而非 options 数组
    assert.equal(typeof captured.body.questions, 'object');
    assert.ok(Array.isArray(captured.body.questions) === false);
    assert.equal(captured.body.questions.intent.type, 'choice');
    assert.ok(typeof captured.body.questions.intent.instructions === 'string');
    assert.ok(captured.body.questions.intent.criteria.roleplay.includes('剧情'));
    assert.equal(captured.body.questions.needsRecall.type, 'noul');
    assert.ok(captured.body.questions.needsRecall.instructions.length > 10);
    assert.equal(captured.body.questions.conflictRisk.type, 'score');
    assert.equal(captured.body.questions.conflictRisk.criteria.length, 2);
    // state 携带当前消息与预算
    assert.ok(captured.body.state.currentMessage.includes('佩剑'));
    assert.equal(captured.body.state.remainingBudget, 1800);
});

test('Jev 429 → JevError(JEV_429)，调用方回退规则', async () => {
    const provider = new TypeSafeJevProvider({ endpoint: 'http://x', fetchImpl: jevFetch({}, { status: 429 }) });
    await assert.rejects(() => provider.decide(input()), (err) => err instanceof JevError && err.code === 'JEV_429');
});

test('Jev 超时 → JEV_TIMEOUT', async () => {
    const hanging = (url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
    });
    const provider = new TypeSafeJevProvider({ endpoint: 'http://x', fetchImpl: hanging, timeoutMs: 50 });
    await assert.rejects(() => provider.decide(input()), (err) => err.code === 'JEV_TIMEOUT');
});

test('Jev 结构错误 → JEV_SCHEMA；非法选项被拒绝', async () => {
    const noAnswers = new TypeSafeJevProvider({ endpoint: 'http://x', fetchImpl: jevFetch(null) });
    await assert.rejects(() => noAnswers.decide(input()), (err) => err.code === 'JEV_SCHEMA');

    const badOption = new TypeSafeJevProvider({
        endpoint: 'http://x',
        fetchImpl: jevFetch({ ...validAnswers, compressionLevel: { choice: 'extreme', confidence: 0.9 } }),
    });
    await assert.rejects(() => badOption.decide(input()), (err) => err.code === 'JEV_SCHEMA');
});

test('Jev 低置信度 → JEV_LOW_CONFIDENCE', async () => {
    const provider = new TypeSafeJevProvider({
        endpoint: 'http://x',
    fetchImpl: jevFetch({
        ...validAnswers,
        intent: { type: 'choice', choice: 'question', confidence: 0.2 },
        memoryNeed: { type: 'choice', choice: 'facts', confidence: 0.2 },
        compressionLevel: { type: 'choice', choice: 'light', confidence: 0.2 },
    }),
        minConfidence: 0.4,
    });
    await assert.rejects(() => provider.decide(input()), (err) => err.code === 'JEV_LOW_CONFIDENCE');
});

test('Jev 连续失败后自动停用（无净收益时降频/停用）', async () => {
    const provider = new TypeSafeJevProvider({ endpoint: 'http://x', fetchImpl: jevFetch({}, { status: 500 }) });
    for (let i = 0; i < 3; i += 1) {
        await assert.rejects(() => provider.decide(input()));
    }
    assert.equal(provider.available(), false);
    await assert.rejects(() => provider.decide(input()), (err) => err.code === 'JEV_DISABLED');
});

test('决策路由：主提供者失败 → 回退规则并说明原因', async () => {
    const fallback = new RuleDecisionProvider();
    const failing = { id: 'jev', decide: async () => { throw new Error('超时'); } };
    const router = createDecisionRouter({ primary: failing, fallback });
    const decision = await router.decide(input());
    assert.equal(decision.provider, 'rule');
    assert.ok(decision.reason.includes('回退'));
});

test('决策路由：失败时优先使用缓存计划', async () => {
    const fallback = new RuleDecisionProvider();
    const cache = new DecisionCache({});
    let mode = 'ok';
    const primary = {
        id: 'jev',
        decide: async () => {
            if (mode === 'ok') return { provider: 'jev', intent: 'question', memoryNeeds: ['facts'], compressionLevel: 'light', mustKeepIds: [], canDropIds: [], confidence: 0.9, reason: 'Jev 判断' };
            throw new Error('额度耗尽');
        },
    };
    const router = createDecisionRouter({ primary, fallback, cache });
    await router.decide(input());
    mode = 'fail';
    const cached = await router.decide(input());
    assert.ok(cached.reason.includes('缓存计划'), cached.reason);
    assert.equal(cached.provider, 'jev');
});

test('规则提供者输出合法且包含意图/压缩等级', async () => {
    const rule = new RuleDecisionProvider();
    const decision = await rule.decide({ ...input(), currentTokens: 2900, budget: { availableInput: 3000 } });
    validateDecision(decision);
    assert.equal(decision.provider, 'rule');
    assert.equal(decision.intent, 'question');
    assert.equal(decision.compressionLevel, 'aggressive');
    assert.ok(decision.reason.includes('规则判断'));
});

test('validateDecision 拒绝结构错误', () => {
    assert.throws(() => validateDecision(null), /决策为空/);
    assert.throws(() => validateDecision({ compressionLevel: 'nope' }), /compressionLevel/);
    assert.throws(() => validateDecision({ compressionLevel: 'none', mustKeepIds: 'x' }), /mustKeepIds/);
    assert.throws(() => validateDecision({ compressionLevel: 'none', confidence: 5 }), /confidence/);
    assert.equal(validateDecision({ compressionLevel: 'none', confidence: 0.5 }), true);
});

test('Jev 设置经 UI 热更新：POST /api/settings 后无需重启即生效（旧实现需重启才挂载 provider）', async () => {
    const { makeServer } = await import('./helpers.js');
    const ctx = await makeServer({ settings: { allowJev: false, jevEndpoint: '' } });
    try {
        // 初始：未配置端点 → 无 Jev 提供者
        assert.equal(ctx.service.jev, null);

        // 通过设置接口配置端点（UI 高级设置的推送路径）
        const res = await ctx.request('POST', '/api/settings', {
            body: { allowJev: true, jevEndpoint: 'http://jev.local/v1/decide', jevModel: 'tester', jevMinConfidence: 0.3 },
        });
        assert.equal(res.status, 200);

        // 热更新生效：provider 已挂载且携带新参数
        assert.ok(ctx.service.jev, 'settings 保存后应重建 Jev provider');
        assert.equal(ctx.service.jev.endpoint, 'http://jev.local/v1/decide');
        assert.equal(ctx.service.jev.model, 'tester');
        assert.equal(ctx.service.jev.minConfidence, 0.3);
        assert.equal(ctx.service.jev.available(), true);
        assert.equal(ctx.service.decisionRouter.id, 'jev+rule');

        // 关闭开关 → 回退规则计划
        await ctx.request('POST', '/api/settings', { body: { allowJev: false } });
        assert.equal(ctx.service.jev, null);
        assert.equal(ctx.service.decisionRouter.id, 'rule');

        // 公共设置不回传 apiKey，只回传是否已设置；重新开启后 jevActive=true
        await ctx.request('POST', '/api/settings', { body: { allowJev: true, jevApiKey: 'sk-secret' } });
        const gs = await ctx.request('GET', '/api/settings');
        assert.equal(gs.payload.settings.jevApiKeySet, true);
        assert.equal('jevApiKey' in gs.payload.settings, false);
        assert.equal(gs.payload.settings.jevActive, true);
    } finally {
        await ctx.cleanup();
    }
});
