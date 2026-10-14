/**
 * 独立基准：N 条中文记忆的写入、索引重建与召回延迟（P50 / P95 / max）。
 * 用法：node test/bench.js [records=10000] [rounds=15]
 * 使用临时数据目录，不影响正式数据。
 */

import { makeService } from './helpers.js';
import { mulberry32 } from './fixtures/corpus.js';
import { contentFingerprint } from '../src/util/ids.js';
import { SCHEMA_VERSION } from '../src/config.js';

const NAMES = ['林月', '沈青崖', '阿澈', '周伯', '苏婉', '顾长风', '阿九', '小月', 'Alice', 'Bob', 'Kael'];
const PLACES = ['云栖镇', '苍梧山', '寒潭', '城主府', '药铺', '客栈', 'Tavern', '北麓'];
const ITEMS = ['霜华剑', '龙渊剑', '星纹石', '桂花糕', '旧地图', '玉佩', 'Map'];
const VERBS = ['来到了', '离开了', '得到了', '失去了', '想起了', '提到了', '藏起了', '修好了'];
const QUERIES = [
    '林月的剑在哪里', '阿澈去了苍梧山', '沈青崖提到了星纹石', '周伯藏起了旧地图', '澈', '月',
    '小月来到了客栈', 'Alice 在 Tavern 得到了 Map', 'Bob 失去了玉佩', '谁修好了龙渊剑',
    '寒潭里有什么', '城主府的秘密', '第 300 天发生了什么', 'Kael 想起了霜华剑',
];

function record(i, rand, scope) {
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const content = `${pick(NAMES)}在${pick(PLACES)}${pick(VERBS)}${pick(ITEMS)}（记录 ${i}，第 ${Math.floor(rand() * 900)} 天）。`;
    return {
        id: `bench-${i}`, kind: 'fact', scope, scopeType: 'chat', scopeId: 'bench', chatId: 'bench', branchId: 'main',
        content, hash: contentFingerprint(content), structured: null, sourceMessageIds: [`m-${i}`], sourceRevision: 1,
        createdAt: new Date(Date.now() - rand() * 30 * 86_400_000).toISOString(), updatedAt: new Date().toISOString(),
        validFrom: null, validTo: null, confidence: 0.8, importance: 0.5 + rand() * 0.5,
        status: rand() < 0.7 ? 'confirmed' : 'observed', supersedes: null, supersededBy: null,
        userLocked: false, userEdited: false, sensitivity: 'normal', derivation: { method: 'rule', version: 'bench' },
        schemaVersion: SCHEMA_VERSION, sharedScopes: [], invalidated: false, invalidatedReason: null, invalidatedAt: null,
        importBatch: null, importSourceId: null, observedFrom: [],
    };
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

const records = Number(process.argv[2] ?? 10_000);
const rounds = Number(process.argv[3] ?? 15);
const ctx = await makeService();
try {
    const { service } = ctx;
    const scope = 'chat:bench';
    const rand = mulberry32(7);
    let t = Date.now();
    service.data.txn(() => {
        for (let i = 0; i < records; i += 1) service.data.insert('memory_records', record(i, rand, scope));
    });
    const insertMs = Date.now() - t;
    service.entities.addMany(NAMES, { type: 'person' });
    const dictionary = service.entities.dictionary();

    const timings = [];
    for (let r = 0; r < rounds; r += 1) {
        for (const q of QUERIES) {
            const s = process.hrtime.bigint();
            service.retrieval.recall(q, { scope, chatId: 'bench', branchId: 'main', budgetTokens: 800, topK: 10, dictionary });
            timings.push(Number(process.hrtime.bigint() - s) / 1e6);
        }
    }
    t = Date.now();
    const stats = service.data.rebuildIndex();
    const rebuildMs = Date.now() - t;

    console.log(JSON.stringify({
        store: service.adapter.kind,
        records,
        queries: timings.length,
        insertMs,
        rebuildMs,
        terms: stats.terms,
        recallMs: {
            p50: Number(percentile(timings, 50).toFixed(2)),
            p95: Number(percentile(timings, 95).toFixed(2)),
            max: Number(Math.max(...timings).toFixed(2)),
        },
        target: 'P95 <= 200ms',
    }, null, 2));
} finally {
    await ctx.cleanup();
}
