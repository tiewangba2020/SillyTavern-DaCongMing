/**
 * 性能验收：需求 1.3 —— 本地规则/关键词检索在 10,000 条记忆记录中 P95 ≤ 200 ms。
 * 同时覆盖需求 4.3 中文验收集：一字名、两字名、别名、中英混合。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';
import { mulberry32 } from './fixtures/corpus.js';
import { contentFingerprint } from '../src/util/ids.js';
import { SCHEMA_VERSION } from '../src/config.js';

const NAMES = ['林月', '沈青崖', '阿澈', '周伯', '苏婉', '顾长风', '阿九', '小月', 'Alice', 'Bob', 'Kael'];
const PLACES = ['云栖镇', '苍梧山', '寒潭', '城主府', '药铺', '客栈', 'Tavern', '北麓'];
const ITEMS = ['霜华剑', '龙渊剑', '星纹石', '桂花糕', '旧地图', '玉佩', 'Map'];
const VERBS = ['来到了', '离开了', '得到了', '失去了', '想起了', '提到了', '藏起了', '修好了'];

function buildRecord(i, rand, scope) {
    const name = NAMES[Math.floor(rand() * NAMES.length)];
    const place = PLACES[Math.floor(rand() * PLACES.length)];
    const item = ITEMS[Math.floor(rand() * ITEMS.length)];
    const verb = VERBS[Math.floor(rand() * VERBS.length)];
    const content = `${name}在${place}${verb}${item}（记录 ${i}，第 ${Math.floor(rand() * 900)} 天）。`;
    return {
        id: `perf-${i}`,
        kind: 'fact',
        scope,
        scopeType: 'chat',
        scopeId: 'perf',
        chatId: 'perf',
        branchId: 'main',
        content,
        hash: contentFingerprint(content),
        structured: null,
        sourceMessageIds: [`m-${i}`],
        sourceRevision: 1,
        createdAt: new Date(Date.now() - rand() * 30 * 86_400_000).toISOString(),
        updatedAt: new Date().toISOString(),
        validFrom: null,
        validTo: null,
        confidence: 0.8,
        importance: 0.5 + rand() * 0.5,
        status: rand() < 0.7 ? 'confirmed' : 'observed',
        supersedes: null,
        supersededBy: null,
        userLocked: false,
        userEdited: false,
        sensitivity: 'normal',
        derivation: { method: 'rule', version: 'perf' },
        schemaVersion: SCHEMA_VERSION,
        sharedScopes: [],
        invalidated: false,
        invalidatedReason: null,
        invalidatedAt: null,
        importBatch: null,
        importSourceId: null,
        observedFrom: [],
    };
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

test('10,000 条中文记忆：召回 P95 ≤ 200ms，索引重建可接受', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scope = 'chat:perf';
        const rand = mulberry32(2026);
        const t0 = Date.now();
        service.data.txn(() => {
            for (let i = 0; i < 10_000; i += 1) {
                service.data.insert('memory_records', buildRecord(i, rand, scope));
            }
        });
        const insertMs = Date.now() - t0;
        assert.equal(service.data.count('memory_records'), 10_000);

        service.entities.addMany(['林月', '沈青崖', '阿澈', '周伯', '苏婉', '顾长风', '阿九', 'Alice', 'Bob', 'Kael'], { type: 'person' });
        service.entities.add('林月', { aliases: ['小月'] });
        const dictionary = service.entities.dictionary();

        const queries = [
            '林月的剑在哪里', '阿澈去了苍梧山', '沈青崖提到了星纹石', '周伯藏起了旧地图',
            '澈', '月', '小月来到了客栈', 'Alice 在 Tavern 得到了 Map', 'Bob 失去了玉佩',
            '谁修好了龙渊剑', '寒潭里有什么', '城主府的秘密', '第 300 天发生了什么', 'Kael 想起了霜华剑',
        ];
        const timings = [];
        let totalSelected = 0;
        for (let round = 0; round < 15; round += 1) {
            for (const q of queries) {
                const start = process.hrtime.bigint();
                const result = service.retrieval.recall(q, {
                    scope, chatId: 'perf', branchId: 'main', budgetTokens: 800, topK: 10, dictionary,
                });
                const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
                timings.push(elapsedMs);
                totalSelected += result.items.length;
            }
        }
        const p50 = percentile(timings, 50);
        const p95 = percentile(timings, 95);
        const max = Math.max(...timings);
        assert.ok(p95 <= 200, `P95 ${p95.toFixed(1)}ms > 200ms`);
        assert.ok(totalSelected > 0);

        const r0 = Date.now();
        const stats = service.data.rebuildIndex();
        const rebuildMs = Date.now() - r0;
        assert.equal(stats.documents, 10_000);
        assert.ok(rebuildMs < 10_000, `索引重建 ${rebuildMs}ms 过慢`);

        globalThis.__perfMetrics = {
            records: 10_000, queries: timings.length, insertMs, rebuildMs,
            p50: Number(p50.toFixed(2)), p95: Number(p95.toFixed(2)), max: Number(max.toFixed(2)),
            terms: stats.terms,
        };
        console.log(`[perf] 10k 记忆：写入 ${insertMs}ms，索引重建 ${rebuildMs}ms，召回 P50 ${p50.toFixed(2)}ms / P95 ${p95.toFixed(2)}ms / max ${max.toFixed(2)}ms（${timings.length} 次）`);
    } finally {
        await ctx.cleanup();
    }
});

test('中文验收集：一字名、两字名、别名、中英混合均可命中', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scope = 'chat:zh';
        const seed = (content, i) => service.memories.create({
            kind: 'fact', scope, chatId: 'zh', branchId: 'main', content, status: 'confirmed', confidence: 0.9,
            sourceMessageIds: [`m${i}`],
        }, { origin: 'auto' });
        seed('澈蹲在屋檐上啃桂花糕。', 1);
        seed('林月把霜华剑放回了剑鞘。', 2);
        seed('小月其实就是林月的小名，只有阿澈这么叫她。', 3);
        seed('Alice 在 Tavern 遇到了 Kael，两人聊起了云栖镇。', 4);
        seed('顾长风说城主府的密室在北麓。', 5);
        service.entities.add('林月', { aliases: ['小月'] });
        service.entities.add('阿澈', { aliases: ['澈'] });
        const dictionary = service.entities.dictionary();
        const base = { scope, chatId: 'zh', branchId: 'main', budgetTokens: 600, dictionary };

        const expectHit = (query, needle) => {
            const result = service.retrieval.recall(query, base);
            assert.ok(result.items.some((i) => i.text.includes(needle)), `查询「${query}」应命中「${needle}」：${JSON.stringify(result.items.map((i) => i.text))}`);
        };
        expectHit('澈在干什么', '桂花糕'); // 一字名
        expectHit('林月的剑', '霜华剑'); // 两字名
        expectHit('小月是谁', '小名'); // 别名
        expectHit('Alice 在 Tavern 见到了谁', 'Kael'); // 中英混合
        expectHit('密室在哪里', '北麓');
    } finally {
        await ctx.cleanup();
    }
});
