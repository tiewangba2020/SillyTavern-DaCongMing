import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Summarizer, buildSummaryRecord } from '../src/core/summarizer.js';
import { estimateTokensConservative as count } from '../src/util/tokenizer.js';

const summarizer = new Summarizer();

const messages = [
    { messageId: 'a1', content: '林月走进了云栖镇的客栈。掌柜周伯正在擦杯子。' },
    { messageId: 'a2', content: '「三年前的冬天，这里被大火烧毁了半条街，」周伯说，「那晚的雪很大。」' },
    { messageId: 'a3', content: '沈青崖沉默了。他的左手旧伤在阴雨天总是隐隐作痛。' },
    { messageId: 'a4', content: '阿澈从屋檐上跳下来，手里还攥着半块桂花糕。' },
    { messageId: 'a5', content: '「哥，」阿澈说，「明天就是祭典了，你会带我去看吗？」' },
    { messageId: 'a6', content: '林月把龙渊剑放在桌上，剑身上的七颗星纹在烛光下微微发亮。' },
];

test('抽取式摘要：确定性（相同输入 → 相同输出与哈希）', () => {
    const first = summarizer.summarizeMessages(messages, { targetTokens: 200, dictionary: ['林月', '沈青崖', '阿澈', '周伯'] });
    const second = summarizer.summarizeMessages(messages, { targetTokens: 200, dictionary: ['林月', '沈青崖', '阿澈', '周伯'] });
    assert.equal(first.text, second.text);
    assert.equal(first.hash, second.hash);
    assert.ok(first.text.length > 0);
});

test('抽取式摘要：只摘录原文句子（不改写，无编造）', () => {
    const result = summarizer.summarizeMessages(messages, { targetTokens: 300 });
    const originals = messages.map((m) => m.content).join('');
    for (const sentence of result.text.split(/\s+/).filter(Boolean)) {
        const core = sentence.replace(/[。！？…」』”"]+$/g, '').replace(/^[「『“"]+/g, '');
        assert.ok(originals.includes(core), `摘要句子应来自原文：${sentence}`);
    }
});

test('抽取式摘要：受目标 token 约束', () => {
    const result = summarizer.summarizeMessages(messages, { targetTokens: 60 });
    assert.ok(result.tokens <= 60, `tokens=${result.tokens}`);
});

test('硬事实（日期/数字）与实体获得保留', () => {
    const result = summarizer.summarizeMessages(messages, {
        targetTokens: 150,
        dictionary: ['林月', '周伯', '龙渊剑'],
    });
    assert.ok(/三年前|大火/.test(result.text), `摘要应包含时间线事实：${result.text}`);
    assert.ok(result.entities.kept.length >= 1, '至少保留一个词典实体');
});

test('来源消息 id 被记录（可追溯）', () => {
    const result = summarizer.summarizeMessages(messages, { targetTokens: 300 });
    assert.ok(result.sourceMessageIds.length >= 1);
    for (const id of result.sourceMessageIds) {
        assert.ok(messages.some((m) => m.messageId === id));
    }
});

test('合并摘要：逐句并集、去重、不产生漂移', () => {
    const s1 = summarizer.summarizeMessages(messages.slice(0, 3), { targetTokens: 200 });
    const s2 = summarizer.summarizeMessages(messages.slice(3), { targetTokens: 200 });
    const merged1 = summarizer.merge([s1, s2], { targetTokens: 500 });
    const merged2 = summarizer.merge([s1, s2], { targetTokens: 500 });
    assert.equal(merged1.text, merged2.text);
    assert.equal(merged1.hash, merged2.hash);

    // 合并结果中的句子必须逐字来自原始消息
    const originals = messages.map((m) => m.content).join('');
    for (const sentence of merged1.text.split(/\s+/).filter(Boolean)) {
        const core = sentence.replace(/[。！？…」』”"]+$/g, '').replace(/^[「『“"]+/g, '');
        assert.ok(originals.includes(core), `合并句子应逐字来自原文：${sentence}`);
    }
    // 来源消息为并集
    const sources = new Set(merged1.sourceMessageIds);
    assert.ok(sources.size >= s1.sourceMessageIds.length);
});

test('重复压缩同一内容不产生漂移（幂等）', () => {
    const first = summarizer.summarizeMessages(messages, { targetTokens: 180 });
    const again = summarizer.summarizeMessages(messages, { targetTokens: 180 });
    const merged = summarizer.merge([first, again], { targetTokens: 400 });
    assert.equal(merged.text, first.text, '同一内容的重复合并应与原文一致（句子级去重）');
});

test('空输入安全返回', () => {
    const result = summarizer.summarizeMessages([], { targetTokens: 100 });
    assert.equal(result.text, '');
    assert.equal(result.sourceMessageIds.length, 0);
});

// —— 埋点保真（回归）——
//
// 背景：长篇角色扮演里绝大多数楼层是「同句式换词」的填充句
// （「我问他：XX 到底把 YY 拿哪里了？」），打分天然偏向这类含实体+对话的句子。
// 实测 40 楼合成章节（reports/回放/scratch/plant-survival.mjs）：
// 旧实现下 8 个「情感转折 / 暗线伏笔」埋点只有 3 个进得了章节摘要；
// 加入「稀有词（IDF）」与「新颖度」两个信号后提升到 8/8。
// 下面的用例把该行为钉死，防止后续调参时回退。

test('独有叙述句（伏笔埋设）优先于同句式填充句', () => {
    const names = ['林月', '沈青崖', '阿澈', '苏婉'];
    const items = ['霜华剑', '龙渊剑', '星纹石', '桂花糕'];
    const msgs = [];
    for (let i = 0; i < 30; i += 1) {
        msgs.push({
            messageId: `t${i}`,
            content: `我问他：“${names[i % 4]}到底把${items[i % 4]}拿到了哪里了？”他说是在云栖镇，可我记得明明不是。`,
        });
    }
    msgs.push({ messageId: 'plant', content: '林月腰间挂着半枚玉佩，断口很整齐，像是被硬生生掰开的。' });

    const result = summarizer.summarizeMessages(msgs, { targetTokens: 120, dictionary: ['林月', '沈青崖'] });
    assert.ok(result.text.includes('半枚玉佩'), `摘要应保留承载伏笔的独有叙述句，实际：${result.text}`);
});

test('情感转折句（含叙事线索词）进入摘要', () => {
    const names = ['林月', '沈青崖', '阿澈', '苏婉'];
    const items = ['霜华剑', '龙渊剑', '星纹石', '桂花糕'];
    const msgs = [];
    for (let i = 0; i < 30; i += 1) {
        msgs.push({
            messageId: `t${i}`,
            content: `我问他：“${names[i % 4]}到底把${items[i % 4]}拿到了哪里了？”他说是在云栖镇，可我记得明明不是。`,
        });
    }
    // 同一段里既有「暗线伏笔」也有「情感转折」，两者都必须进摘要。
    msgs.push({ messageId: 'plant', content: '林月腰间挂着半枚玉佩，断口很整齐，像是被硬生生掰开的。' });
    msgs.push({ messageId: 'turn', content: '沈青崖第一次对他笑了，笑得很轻，像是怕被人看见。' });

    const result = summarizer.summarizeMessages(msgs, { targetTokens: 100, dictionary: ['林月', '沈青崖'] });
    assert.ok(result.text.includes('半枚玉佩'), `摘要应保留伏笔句，实际：${result.text}`);
    assert.ok(result.text.includes('第一次对他笑了'), `摘要应保留情感转折句，实际：${result.text}`);
});

test('摘要长度受控：稀有词加成不会撑爆目标 token', () => {
    const msgs = [];
    for (let i = 0; i < 60; i += 1) {
        msgs.push({ messageId: `m${i}`, content: `第${i}个场景：风穿过回廊，灯影摇晃，某处传来一声极轻的叹息，随后一切归于寂静。` });
    }
    const result = summarizer.summarizeMessages(msgs, { targetTokens: 80 });
    assert.ok(result.tokens <= 80, `tokens=${result.tokens}`);
});

test('buildSummaryRecord 生成记忆记录输入', () => {
    const summary = summarizer.summarizeMessages(messages, { targetTokens: 200 });
    const record = buildSummaryRecord(summary, { scope: 'chat:c1', chatId: 'c1', branchId: 'main', sourceRevision: 3 });
    assert.equal(record.kind, 'summary_chapter');
    assert.equal(record.scope, 'chat:c1');
    assert.equal(record.status, 'confirmed');
    assert.equal(record.derivation.method, 'extractive');
    assert.ok(count(record.content) <= 200);
});

// —— 真实规模性能回归（D34）——
//
// 背景：真实长篇章节（40 楼 / 32 万字符）切出 11,674 句。旧实现对**全章**做
// 两两相似度（每句 × 600 采样参照句 ≈ 700 万次 jaccard），实测单章 2.3 秒、
// 同步阻塞事件循环 4.4~5.0 秒 —— 后台摘要任务跑起来时，酒馆整段时间无法响应
// 任何请求（手机上更久）。
// 现实现 = 粗排池（≤240 句）× 整章均匀参照集（≤600 句），比较次数恒 ≤ 144,000，
// 与章节数量无关。本用例用 stats.pairComparisons 把这一点钉死：
// 它是确定性的、与环境无关的；旧实现下该断言必然失败（≈700 万）。
test('真实规模章节：两两比较次数有界（不随句数增长）', () => {
    const msgs = [];
    // 造 40 楼、每楼 ~290 句的真实量级章节（≈11,600 句）
    for (let i = 0; i < 40; i += 1) {
        const parts = [];
        for (let j = 0; j < 290; j += 1) {
            parts.push(`第${i}-${j}段：沈青崖在云栖镇的回廊里停了一下，风穿过灯影，他想起林月说过的话，没有回答。`);
        }
        msgs.push({ messageId: `m${i}`, content: parts.join('') });
    }
    const result = summarizer.summarizeMessages(msgs, { targetTokens: 400, dictionary: ['沈青崖', '林月'] });
    assert.ok(result.stats.sentences > 10000, `应达到真实规模，实际 ${result.stats.sentences} 句`);
    assert.ok(result.stats.poolSize <= 240, `池大小应 ≤ 240，实际 ${result.stats.poolSize}`);
    assert.ok(
        result.stats.pairComparisons <= 240 * 600,
        `两两比较应有界（≤144000），实际 ${result.stats.pairComparisons}`,
    );
    assert.ok(result.text.length > 0, '摘要仍应正常产出');
    assert.ok(result.kept > 0, `应选出句子，实际 ${result.kept}`);
});
