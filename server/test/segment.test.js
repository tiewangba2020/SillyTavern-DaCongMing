import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment, segmentQuery, normalizeForIndex, SEGMENTER_VERSION } from '../src/util/segment.js';

test('两字人名以 bigram 形式进入索引', () => {
    const terms = segment('林月握紧了剑柄');
    assert.ok(terms.includes('林月'), `terms=${terms.join(',')}`);
});

test('一字名以单字形式进入索引', () => {
    const terms = segment('阿澈蹲在屋檐上');
    assert.ok(terms.includes('澈'), `terms=${terms.join(',')}`);
});

test('别名与中英混合', () => {
    const terms = segment('Alice 和 林月 一起走进了 Tavern');
    assert.ok(terms.includes('alice'));
    assert.ok(terms.includes('tavern'));
    assert.ok(terms.includes('林月'));
});

test('全角转半角 + 小写化', () => {
    const terms = segment('ＡＬＩＣＥ１２３');
    assert.ok(terms.includes('alice123'), `terms=${terms.join(',')}`);
});

test('停用 bigram 被过滤', () => {
    const terms = segment('我们的确是这样做的');
    assert.ok(!terms.includes('我们'), `terms=${terms.join(',')}`);
    assert.ok(!terms.includes('这样'));
});

test('词典词整词输出（D: 前缀）', () => {
    const terms = segment('沈青崖看着云栖镇的灯火', { dictionary: ['沈青崖', '云栖镇'] });
    assert.ok(terms.includes('D:沈青崖'));
    assert.ok(terms.includes('D:云栖镇'));
});

test('查询词去重', () => {
    const terms = segmentQuery('林月林月林月');
    const unique = new Set(terms);
    assert.equal(terms.length, unique.size);
});

test('切词版本号固定（索引与查询必须同版本）', () => {
    assert.equal(SEGMENTER_VERSION, 'zh-bigram-v1');
});

test('normalizeForIndex 保留中文标点处理', () => {
    assert.equal(normalizeForIndex('Ａ，Ｂ'), 'a,b');
});
