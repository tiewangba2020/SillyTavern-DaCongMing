/**
 * 1000 楼长聊回放：对应需求 1.3 成功标准与 5.3 P0 验收清单。
 *
 *   - 硬预算违约率 ≤ 1%（本实现目标为 0）
 *   - 达到压缩触发阈值后，平均输入 token 减少率 ≥ 30%
 *   - 关键事实压缩后保留或正确召回率 ≥ 90%
 *   - 事实矛盾率 ≤ 5%
 *   - 原始聊天永不丢失；用户纠正/遗忘后不再复活；分支不串记忆；重启后仍有效
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, planRequest, tempDir } from './helpers.js';
import { generateCorpus, sliceCorpus } from './fixtures/corpus.js';

const CHAT_ID = 'replay-1000';
const SCOPE = `chat:${CHAT_ID}`;
const CHECKPOINTS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

async function replay(service, corpus, { contextLimit = 8192, outputReserve = 1024 } = {}) {
    const results = [];
    let prev = 0;
    for (const n of CHECKPOINTS) {
        const chunk = corpus.messages.filter((m) => m.floorIndex >= prev && m.floorIndex < n);
        service.ingest({ chatId: CHAT_ID, branchId: 'main', scope: SCOPE, messages: chunk });
        assert.ok(await service.tasks.drain(30_000), `第 ${n} 楼抽取任务未在超时内完成`);
        const plan = await service.plan(planRequest(sliceCorpus(corpus, n), {
            chatId: CHAT_ID,
            contextLimit,
            outputReserve,
            userInput: '师父，我们接下来去哪里找星纹石？',
        }));
        assert.ok(await service.tasks.drain(30_000), `第 ${n} 楼章节摘要任务未在超时内完成`);
        results.push({
            n,
            result: plan.result,
            finalTokens: plan.estimate.finalTokens,
            availableInput: plan.budget.availableInput,
            baseline: plan.estimate.baselineTokens,
            savedRatio: plan.estimate.savedRatio,
            triggered: plan.estimate.baselineTokens > plan.budget.triggerAt,
            degradeReasons: plan.degradeReasons,
            chapters: plan.chapters,
        });
        prev = n;
    }
    return results;
}

test('1000 楼回放：零硬预算违约、无阻止、触发后平均节省 ≥ 30%', async () => {
    const corpus = generateCorpus({ floors: 1000, seed: 42 });
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: false, tier: 'balanced' } });
    try {
        const results = await replay(ctx.service, corpus);

        const violations = results.filter((r) => r.result !== 'blocked' && r.finalTokens > r.availableInput);
        assert.equal(violations.length, 0, `硬预算违约：${JSON.stringify(violations)}`);
        assert.equal(results.filter((r) => r.result === 'blocked').length, 0, '预算充足时不应阻止发送');

        const triggered = results.filter((r) => r.triggered);
        assert.ok(triggered.length >= 5, `应有多数检查点触发压缩（实际 ${triggered.length}）`);
        const avgSaved = triggered.reduce((a, r) => a + r.savedRatio, 0) / triggered.length;
        assert.ok(avgSaved >= 0.3, `触发后平均节省率 ${(avgSaved * 100).toFixed(1)}% < 30%`);

        // 后续检查点应复用已存章节摘要（后台写路径生效）
        const last = results[results.length - 1];
        assert.ok(last.chapters.stored >= 1, '最后一轮应复用已存章节摘要（后台写路径生效）');

        // 原始聊天永不丢失：每条消息的最新原文可回放
        const identities = ctx.service.identities.byChat(CHAT_ID, 'main');
        const replayedMessages = corpus.messages.filter((m) => m.floorIndex < 1000);
        assert.equal(identities.length, replayedMessages.length);
        for (const identity of identities) {
            assert.ok(ctx.service.events.latestText(identity.messageId), '原文必须可从事件日志回放');
        }
        globalThis.__replayMetrics = { results, avgSaved };
    } finally {
        await ctx.cleanup();
    }
});

test('关键事实：压缩后保留或正确召回率 ≥ 90%，事实矛盾率 ≤ 5%', async () => {
    const corpus = generateCorpus({ floors: 1000, seed: 42 });
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: false } });
    try {
        const { service } = ctx;
        await replay(service, corpus);
        const dictionary = service.entities.dictionary();
        const base = { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', budgetTokens: 800, topK: 8, dictionary };

        let hitMemory = 0;
        let hitAny = 0;
        const misses = [];
        for (const fact of corpus.keyFacts) {
            const mem = service.retrieval.recall(fact.question, base);
            const any = service.retrieval.recall(fact.question, { ...base, includeRaw: true });
            const memHit = mem.items.some((i) => i.text.includes(fact.expect));
            const anyHit = any.items.some((i) => i.text.includes(fact.expect));
            if (memHit) hitMemory += 1;
            if (anyHit) hitAny += 1;
            else misses.push(`${fact.id}:${fact.question}→${fact.expect}`);
        }
        const recallRate = hitAny / corpus.keyFacts.length;
        assert.ok(recallRate >= 0.9, `关键事实召回率 ${(recallRate * 100).toFixed(1)}% < 90%；未命中：${misses.join('；')}`);

        // 矛盾率：被纠正的事实（龙渊剑→霜华剑）在计划注入中必须以当前值为准
        let contradictions = 0;
        for (const fact of corpus.keyFacts.filter((f) => f.supersedes)) {
            const plan = await service.plan(planRequest(sliceCorpus(corpus, 1000), {
                chatId: CHAT_ID, contextLimit: 8192, outputReserve: 1024, userInput: fact.question,
                options: { preview: true },
            }));
            const injected = plan.injections.map((i) => i.text).join('\n');
            const oldValue = corpus.keyFacts.find((f) => f.id === fact.supersedes)?.expect;
            if (!injected.includes(fact.expect)) contradictions += 1;
            else if (oldValue && injected.includes(oldValue) && !injected.includes('不是' + oldValue)) {
                // 旧值若出现，必须与“不是…而是…”的纠正语句同在（即用户纠正锚点被注入）
                contradictions += injected.includes('记住') ? 0 : 1;
            }
        }
        const contradictionRate = contradictions / corpus.keyFacts.length;
        assert.ok(contradictionRate <= 0.05, `事实矛盾率 ${(contradictionRate * 100).toFixed(1)}% > 5%`);

        globalThis.__replayFacts = { hitMemory, hitAny, total: corpus.keyFacts.length, recallRate, contradictionRate };
    } finally {
        await ctx.cleanup();
    }
});

test('用户纠正后旧事实不再出现；“不再记忆”在重扫与重启后仍有效', async () => {
    const corpus = generateCorpus({ floors: 300, seed: 7 });
    const dir = tempDir();
    const first = await makeService({ dir, settings: { autoManage: true, shadowMode: false } });
    let forgottenId;
    try {
        const { service } = first;
        service.ingest({ chatId: CHAT_ID, branchId: 'main', scope: SCOPE, messages: corpus.messages.filter((m) => m.floorIndex < 300) });
        assert.ok(await service.tasks.drain(30_000));

        // 纠正：找到“龙渊剑”旧事实
        const old = service.memories.list({ scope: SCOPE, search: '龙渊剑' }).items.find((r) => r.content.includes('佩剑'));
        assert.ok(old, '应已抽取出“佩剑名叫龙渊剑”的事实');
        service.memories.correct(old.id, { content: '林月的佩剑是霜华剑，龙渊剑已归还师父。' });
        const recall = service.retrieval.recall('林月的佩剑叫什么？', { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', budgetTokens: 600 });
        assert.ok(!recall.items.some((i) => i.id === old.id), '旧版本不得再被召回');
        assert.ok(recall.items.some((i) => i.text.includes('霜华剑')), '纠正后的版本应可召回');

        // 遗忘：桂花糕
        const sweet = service.memories.list({ scope: SCOPE, search: '桂花糕' }).items[0];
        assert.ok(sweet, '应已抽取出“喜欢吃桂花糕”的记忆');
        forgottenId = sweet.id;
        service.memories.forget(sweet.id);

        // 重扫历史（全量同步）→ 不得复活
        service.ingest({ chatId: CHAT_ID, branchId: 'main', scope: SCOPE, messages: corpus.messages.filter((m) => m.floorIndex < 300), fullSync: true });
        assert.ok(await service.tasks.drain(30_000));
        const alive = service.memories.list({ scope: SCOPE, search: '桂花糕' }).items.filter((r) => r.status !== 'archived');
        assert.equal(alive.length, 0, '重扫后被遗忘的记忆不得复活');
        const rawRecall = service.retrieval.recall('阿澈喜欢吃什么', { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', includeRaw: true });
        assert.ok(!rawRecall.items.some((i) => i.text.includes('桂花糕')), '原文召回同样受阻断');

        await service.stop();
    } catch (err) {
        await first.cleanup();
        throw err;
    }

    // 服务重启后阻断与纠正仍有效
    const second = await makeService({ dir, settings: { autoManage: true, shadowMode: false } });
    try {
        const { service } = second;
        assert.equal(service.memories.get(forgottenId).status, 'archived');
        const retry = service.memories.create({
            kind: 'fact', scope: SCOPE, chatId: CHAT_ID, content: '阿澈是林月的弟弟，今年十二岁，最喜欢吃桂花糕。', status: 'observed',
        }, { origin: 'auto' });
        assert.ok(retry.blocked, '重启后 tombstone 仍阻断');
        const recall = service.retrieval.recall('林月的佩剑叫什么？', { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', budgetTokens: 600 });
        assert.ok(recall.items.some((i) => i.text.includes('霜华剑')));
        assert.ok(!recall.items.some((i) => i.text.includes('佩剑名叫龙渊剑')));
    } finally {
        await second.cleanup();
    }
});

test('分支隔离：兄弟分支与未选中 swipe 的记忆不注入当前故事', async () => {
    const corpus = generateCorpus({ floors: 200, seed: 11 });
    const ctx = await makeService({ settings: { autoManage: true, shadowMode: false } });
    try {
        const { service } = ctx;
        service.ingest({ chatId: CHAT_ID, branchId: 'main', scope: SCOPE, messages: corpus.messages.filter((m) => m.floorIndex < 200) });
        // 另一分支：矛盾事实
        service.ingest({
            chatId: CHAT_ID, branchId: 'alt', scope: SCOPE,
            messages: [{
                floorIndex: 150, content: '林月把霜华剑丢进了寒潭，从此再也不用剑了。', isUser: false, name: '叙述者',
                sendDate: '2026-03-01T00:00:00.000Z', swipeId: 1,
            }],
        });
        assert.ok(await service.tasks.drain(30_000));

        const main = service.retrieval.recall('林月的剑怎么了', { scope: SCOPE, chatId: CHAT_ID, branchId: 'main', budgetTokens: 800, includeRaw: true });
        assert.ok(!main.items.some((i) => i.text.includes('丢进了寒潭')), '兄弟分支的记忆不得注入主分支');
        const alt = service.retrieval.recall('林月的剑怎么了', { scope: SCOPE, chatId: CHAT_ID, branchId: 'alt', budgetTokens: 800, includeRaw: true });
        assert.ok(alt.items.some((i) => i.text.includes('丢进了寒潭')), '本分支的记忆应可召回');

        // 计划层面同样隔离
        const plan = await service.plan(planRequest(sliceCorpus(corpus, 200), {
            chatId: CHAT_ID, branchId: 'main', contextLimit: 8192, userInput: '林月的剑怎么了', options: { preview: true },
        }));
        const injected = plan.injections.map((i) => i.text).join('\n');
        assert.ok(!injected.includes('丢进了寒潭'));
    } finally {
        await ctx.cleanup();
    }
});

test('关闭所有外部 AI（规则模式）仍可完成基础发送计划', async () => {
    const corpus = generateCorpus({ floors: 400, seed: 3 });
    const ctx = await makeService({
        settings: { autoManage: true, shadowMode: false, allowJev: false, allowRemoteEmbedding: false, privacy: 'local-only' },
    });
    try {
        const { service } = ctx;
        assert.equal(service.jev, null, 'Jev 未启用');
        service.ingest({ chatId: CHAT_ID, branchId: 'main', scope: SCOPE, messages: corpus.messages.filter((m) => m.floorIndex < 400) });
        assert.ok(await service.tasks.drain(30_000));
        const plan = await service.plan(planRequest(sliceCorpus(corpus, 400), { chatId: CHAT_ID, contextLimit: 4096, outputReserve: 512 }));
        assert.notEqual(plan.result, 'blocked');
        assert.equal(plan.decisionProvider, 'rule');
        assert.ok(plan.estimate.finalTokens <= plan.budget.availableInput);
    } finally {
        await ctx.cleanup();
    }
});
