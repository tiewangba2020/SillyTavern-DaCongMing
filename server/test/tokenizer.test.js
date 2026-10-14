import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateTokensConservative, countMessagesTokens, TOKENIZER_VERSION, tokenAccuracyInfo } from '../src/util/tokenizer.js';

test('空文本为 0 token', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
});

test('中文估算：约 1.5 token/字，且单调递增', () => {
    const short = estimateTokens('你好');
    const long = estimateTokens('你好，欢迎来到云栖镇。');
    assert.ok(short >= 3, `short=${short}`);
    assert.ok(long > short);
    assert.ok(long >= Math.ceil(13 * 1.5 * 0.8), `long=${long}`);
});

test('英文估算约为 1 token / 4 字符', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 10 && tokens <= 20, `tokens=${tokens}`);
});

test('保守估算不小于基础估算，且带 1.15 系数', () => {
    const text = '林月把霜华剑轻轻放在桌上，窗外传来更夫的梆子声。';
    const base = estimateTokens(text);
    const conservative = estimateTokensConservative(text);
    assert.ok(conservative >= base);
    assert.equal(conservative, Math.ceil(base * 1.15));
});

test('消息列表计数包含角色开销', () => {
    const messages = [
        { content: '你好' },
        { content: '你好' },
    ];
    const total = countMessagesTokens(messages);
    assert.ok(total >= estimateTokens('你好') * 2 + 8);
});

test('估算来源标记为 estimate，不宣称精确', () => {
    const info = tokenAccuracyInfo();
    assert.equal(info.level, 'estimate');
    assert.equal(info.method, TOKENIZER_VERSION);
    assert.ok(info.note.includes('估算'));
});
