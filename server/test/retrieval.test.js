import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

async function seed(service, records) {
    for (const rec of records) {
        service.memories.create({
            kind: 'fact',
            scope: 'chat:r1',
            chatId: 'r1',
            branchId: 'main',
            status: 'confirmed',
            confidence: 0.9,
            importance: 0.7,
            ...rec,
        }, { origin: 'auto' });
    }
}

const ctxFor = (over = {}) => ({ scope: 'chat:r1', chatId: 'r1', branchId: 'main', ...over });

test('中文关键词召回：两字名/物品/地点', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [
            { content: '林月的佩剑是霜华剑', sourceMessageIds: ['m1'] },
            { content: '沈青崖住在云栖镇东边的老宅', sourceMessageIds: ['m2'] },
            { content: '阿澈最喜欢吃桂花糕', sourceMessageIds: ['m3'] },
        ]);
        const result = service.retrieval.recall('林月的佩剑叫什么？', ctxFor());
        assert.ok(result.items.length >= 1);
        assert.equal(result.items[0].text, '林月的佩剑是霜华剑');
        assert.ok(result.items[0].breakdown.bm25 > 0);
        assert.ok(result.items[0].reason.includes('关键词'));
    } finally {
        await ctx.cleanup();
    }
});

test('实体命中：词典词提升相关记忆', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.entities.add('霜华剑', { type: 'item' });
        service.entities.add('龙渊剑', { type: 'item' });
        await seed(service, [
            { content: '林月的佩剑是霜华剑', sourceMessageIds: ['m1'] },
            { content: '师父的佩剑是龙渊剑', sourceMessageIds: ['m2'] },
        ]);
        const result = service.retrieval.recall('霜华剑现在在哪里？', ctxFor({ dictionary: service.entities.dictionary() }));
        assert.ok(result.items.length >= 1);
        assert.equal(result.items[0].text, '林月的佩剑是霜华剑');
        assert.ok(result.items[0].breakdown.entity > 0);
    } finally {
        await ctx.cleanup();
    }
});

test('作用域隔离：其他聊天/其他角色的记忆不注入', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [
            { content: '本聊天的秘密是蓝色', sourceMessageIds: ['m1'] },
        ]);
        service.memories.create({
            kind: 'fact', scope: 'chat:other', chatId: 'other', content: '别的聊天的秘密是红色',
            status: 'confirmed', confidence: 0.9,
        }, { origin: 'auto' });

        const result = service.retrieval.recall('秘密是什么颜色', ctxFor());
        assert.ok(result.items.some((i) => i.text.includes('蓝色')));
        assert.ok(!result.items.some((i) => i.text.includes('红色')), '跨聊天记忆不得注入');
    } finally {
        await ctx.cleanup();
    }
});

test('分支隔离：兄弟分支的记忆不注入', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [
            { content: '主分支中林月拿到了钥匙', branchId: 'main', sourceMessageIds: ['m1'] },
        ]);
        service.memories.create({
            kind: 'fact', scope: 'chat:r1', chatId: 'r1', branchId: 'branch-b',
            content: '另一分支中林月丢掉了钥匙', status: 'confirmed', confidence: 0.9,
        }, { origin: 'auto' });

        const result = service.retrieval.recall('钥匙在哪里', ctxFor({ branchId: 'main' }));
        assert.ok(result.items.some((i) => i.text.includes('拿到了钥匙')));
        assert.ok(!result.items.some((i) => i.text.includes('丢掉了钥匙')), '未选中分支的记忆不得注入');
    } finally {
        await ctx.cleanup();
    }
});

test('未确认状态不召回；用户固定的候选可召回', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [
            { content: '候选记忆不该被召回', status: 'candidate', confidence: 0.3, sourceMessageIds: ['m1'] },
            { content: '冲突记忆不该被召回', status: 'conflict', sourceMessageIds: ['m2'] },
        ]);
        let result = service.retrieval.recall('召回', ctxFor());
        assert.equal(result.items.length, 0);

        const { record } = service.memories.create({
            kind: 'preference', scope: 'chat:r1', chatId: 'r1', content: '用户固定的候选记忆', status: 'candidate',
        }, { origin: 'user' });
        service.memories.setLocked(record.id, true);
        result = service.retrieval.recall('候选记忆', ctxFor());
        assert.ok(result.items.some((i) => i.id === record.id));
    } finally {
        await ctx.cleanup();
    }
});

test('过期记忆不召回；失效（invalidated）不召回', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [
            { content: '过期的地点信息在旧城', validTo: '2020-01-01T00:00:00.000Z', sourceMessageIds: ['m1'] },
            { content: '已失效的地点信息在新城', sourceMessageIds: ['m2'] },
        ]);
        const invalid = service.data.query('memory_records', (r) => r.content.includes('已失效'))[0];
        service.data.update('memory_records', invalid.id, { invalidated: true, invalidatedReason: '测试' });

        const result = service.retrieval.recall('地点信息', ctxFor());
        assert.equal(result.items.length, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('遗忘后的记忆不再被召回（tombstone 生效）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [{ content: '要被遗忘的暗号是月光', sourceMessageIds: ['m1'] }]);
        const rec = service.data.query('memory_records', (r) => r.content.includes('月光'))[0];
        service.memories.forget(rec.id);
        const result = service.retrieval.recall('暗号是什么', ctxFor());
        assert.equal(result.items.length, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('召回受预算裁剪：token 总量不超过 budgetTokens', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        for (let i = 0; i < 6; i += 1) {
            await seed(service, [{ content: `关于星纹石的第 ${i} 条详细记录，内容比较长，用于占用预算。`, sourceMessageIds: [`m${i}`] }]);
        }
        const result = service.retrieval.recall('星纹石', ctxFor({ budgetTokens: 60 }));
        assert.ok(result.meta.tokens <= 60, `tokens=${result.meta.tokens}`);
        assert.ok(result.items.length >= 1);
    } finally {
        await ctx.cleanup();
    }
});

test('低相关冷记忆不注入（minScore 阈值）', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        await seed(service, [{ content: '完全无关的另一段内容', sourceMessageIds: ['m1'] }]);
        const result = service.retrieval.recall('霜华剑的来历', ctxFor());
        assert.equal(result.items.length, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('原文召回开关：includeRaw 控制消息事件检索', async () => {
    const ctx = await makeService({ settings: { autoManage: false } });
    try {
        const { service } = ctx;
        service.ingest({
            chatId: 'r1', branchId: 'main', scope: 'chat:r1',
            messages: [
                { floorIndex: 0, content: '林月在寒潭边发现了冰封的入口。', isUser: false, name: '叙述者', sendDate: '2026-01-01T00:00:00.000Z' },
            ],
        });
        const without = service.retrieval.recall('寒潭入口', ctxFor());
        assert.equal(without.items.length, 0);
        const withRaw = service.retrieval.recall('寒潭入口', ctxFor({ includeRaw: true }));
        assert.ok(withRaw.items.some((i) => i.collection === 'message_events'));
    } finally {
        await ctx.cleanup();
    }
});

// —— D35 回归：长 query 下召回不被原始消息淹没 ——
//
// 背景（真实数据实验，500 楼真实语料）：真实用户消息可能是整章长文
// （实测 29,866 字符 → 切出 11,473 个词）。BM25 分数是「命中词 idf 累加」，
// 长文档能命中数千个词，而一条记忆只有几十个字 → 合并排序取 top-N 时
// **message_events 全额占据**（实测 64/64）；planner 走 includeRaw=false，
// 这些候选随后被全部丢弃 → scored=0 → 召回恒空（实测定向召回命中率 1.2%，
// 与随机基线持平）。
// 修复：候选按集合分别取配额 + BM25 按集合分别归一化。
//
// 构造：100 条消息各含 40 个互不重复的关键词（df=1 → 高 idf）；query 包含
// 前 64 条消息的全部 2560 个关键词 → 这 64 条消息各命中 40 个高 idf 词，
// 而那条「玉佩」记忆只命中 ~5 个 → 旧实现的合并 top-64 里没有它。
test('长 query 下召回不被原始消息淹没（D35）', async () => {
    const { service } = await makeService({ settings: { autoManage: false } });
    try {
        const kw = (n) => `kw${String(n).padStart(4, '0')}`;
        const MSGS = 100, PER = 40;
        service.ingest({
            chatId: 'r1', branchId: 'main', scope: 'chat:r1',
            messages: Array.from({ length: MSGS }, (_, i) => ({
                floorIndex: i,
                content: `剧情推进 ${Array.from({ length: PER }, (_, j) => kw(i * PER + j)).join(' ')}`,
                isUser: i % 2 === 0, isSystem: false, name: i % 2 === 0 ? '用户' : '角色', sendDate: null,
            })),
            fullSync: true,
        });
        seed(service, [{ content: '沈清把半枚玉佩收进了妆匣底层。' }]);

        // 长 query：包含前 64 条消息的全部关键词（模拟真实用户整章长文输入）
        const query = `${Array.from({ length: 64 * PER }, (_, j) => kw(j)).join(' ')} 沈清后来把玉佩放在哪里了？`;
        const r = service.retrieval.recall(query, {
            scope: 'chat:r1', chatId: 'r1', branchId: 'main',
            budgetTokens: 1200, topK: 8, dictionary: [], includeRaw: false,
        });
        assert.ok(
            r.items.some((i) => String(i.text).includes('玉佩')),
            `长 query 应仍能召回含关键词的记忆；实际 ${r.items.length} 条、候选 ${r.meta.candidates}、打分 ${r.meta.scored}`,
        );
    } finally {
        await service.stop();
    }
});
