import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates } from '../src/core/extractor.js';

/** 构造单条消息的抽取输入。 */
const one = (content, isUser = false) => ({
    messages: [{ messageId: 'm1', content, isUser, isSystem: false }],
    scope: 'chat:c1',
});

const rules = (out) => out.map((c) => c.derivation.rule);

test('情感转折：靠神态/动作暗示的关系变化也会被抽取', () => {
    // 长篇角色扮演里关系变化大多不是「变成了」这种显式措辞，
    // 而是「冷冷地别过脸去」这类神态/动作。旧规则表完全漏掉这类句子。
    const out = extractCandidates(one('沈青崖冷冷地别过脸去，没有回答林月的问话。'));
    assert.ok(
        rules(out).includes('emotion-shift'),
        `应命中 emotion-shift，实际命中：${JSON.stringify(rules(out))}`,
    );
});

test('情感转折：显式措辞优先走 state-change（不重复产出同一条记忆）', () => {
    const out = extractCandidates(one('沈青崖对他的态度已经变成了信任，不再处处设防。'));
    assert.ok(rules(out).includes('state-change'));
    // 同一句话命中多条 fact 规则时，按 kind|content 去重，只保留先命中的那条。
    assert.equal(out.filter((c) => c.kind === 'fact').length, 1, '同内容不应产出重复 fact 候选');
});

test('情感转折：不误伤普通环境叙述句', () => {
    const out = extractCandidates(one('窗外的风卷着碎雪敲在窗棂上，屋里只剩炭火噼啪。'));
    assert.equal(out.length, 0, `普通叙述句不应产出候选，实际：${JSON.stringify(rules(out))}`);
});

test('抽取结果只摘录原文句子（不改写、不编造）', () => {
    const text = '其实那半枚玉佩，是沈青崖母亲留下的信物，断口是当年摔的。';
    const out = extractCandidates(one(text));
    assert.ok(out.length >= 1);
    for (const c of out) {
        assert.ok(text.includes(c.content), `候选内容应逐字来自原文：${c.content}`);
    }
});

test('抽取是确定性的（相同输入 → 相同输出）', () => {
    const input = one('沈青崖冷冷地别过脸去，没有回答林月的问话。');
    assert.deepEqual(extractCandidates(input), extractCandidates(input));
});

test('系统消息不作为记忆来源', () => {
    const out = extractCandidates({
        messages: [{ messageId: 's1', content: '沈青崖冷冷地别过脸去。', isSystem: true }],
        scope: 'chat:c1',
    });
    assert.equal(out.length, 0);
});

test('模板文本过滤：状态栏/世界书注入/推理标签不再被抽成记忆（v0.2.8）', () => {
    const mk = (content, isUser = false) => ({
        content, isUser, role: isUser ? 'user' : 'assistant',
        name: isUser ? '你' : '角色', floorIndex: 1, sendDate: null,
    });
    const res = extractCandidates({
        messages: [
            // 状态栏：整句【】包裹 → 过滤
            mk('【24小时内未进行标准回路疏导，重塑代偿速率将提升150%】'),
            // 模板头 ::: 开头 → 过滤
            mk(':::newspaper 2024-04-08|周一|13:42 / 小鱼干 # 第十章 骨障的刻度'),
            // 整行方括号标签 → 过滤
            mk('[Start a new chat]'),
            // 整条 <think> 无正文 → 过滤
            mk('<think>用户似乎想测试推理剥离。</think>'),
            // think + 正文混合 → 剥离 think，正文照常抽取
            mk('<think>她提到了玉佩。</think>隔壁401宣传来一声极其细微的关门声，苏清对林月的態度變成了戒备与疏离。'),
            // 尖括号标签头 + 大量模板行 → 过滤
            mk('<疏珩修正>\n不强调疏珩的设定\n不把世界书中的设定复述到剧情中'),
            // 普通剧情句 → 正常抽取
            mk('苏清把半枚玉佩收进了妆匣底层。'),
        ],
    });
    const contents = res.map((c) => c.content);
    assert.equal(contents.some((c) => c.includes('150%')), false, '状态栏不应被抽取');
    assert.equal(contents.some((c) => c.includes('newspaper')), false, '::: 模板不应被抽取');
    assert.equal(contents.some((c) => c.includes('Start a new chat')), false, '开场标签不应被抽取');
    assert.equal(contents.some((c) => c.includes('推理剥离')), false, 'think 内容不应被抽取');
    assert.equal(contents.some((c) => c.includes('戒备与疏离')), true, 'think 剥离后正文应照常抽取（state-change 规则命中）');
    });
