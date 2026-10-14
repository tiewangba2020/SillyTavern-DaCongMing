/**
 * 中文切词与检索分词。
 *
 * 需求 4.3：SQLite FTS5 只是检索设施，不直接视为中文分词方案；
 * 服务端必须统一维护切词版本，索引和查询使用同一规则。
 *
 * 本实现不依赖 FTS5 的 unicode61（它无法切分中文），
 * 而是自建倒排索引（store/data.js），分词规则如下：
 *   - CJK 连续段：输出单字（支持一字名，过滤高频虚词）+ bigram（相邻两字）
 *   - 拉丁/数字段：小写化后整词输出
 *   - 词典词（人名/别名/物品/地点）：整词输出，用于精确实体匹配
 *   - 极短停用 bigram 过滤
 * 索引与查询都调用 segment()，保证同一规则、同一版本。
 */

import { normalizeText } from './text.js';

export const SEGMENTER_VERSION = 'zh-bigram-v1';

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ]+/u;
const LATIN_RUN = /[a-zA-Z0-9_]+/g;

// 高频虚词 bigram，避免污染 BM25 排序
const STOP_BIGRAMS = new Set([
    '的了', '是的', '是在', '在了', '他有', '她有', '我有', '你了', '我们', '他们',
    '这个', '那个', '就是', '不是', '没有', '什么', '怎么', '因为', '所以', '但是',
    '而且', '然后', '如果', '虽然', '可以', '自己', '一个', '一下', '已经', '还是',
    '不过', '只是', '这样', '那样', '时候', '现在', '知道', '觉得', '起来',
]);

// 高频单字虚词，不作为单字 term（仍参与 bigram）
const STOP_CHARS = new Set('的了是在有我你他她它们和与及也就都而但等这那什么很太不没为以到说要去来上下中里对能会可把被让给从向着过吗呢吧啊呀哦嗯并或若之其所于乎者矣');

// 全角转半角（ASCII 范围），并保留中文标点
export function normalizeForIndex(text) {
    const s = normalizeText(text);
    let out = '';
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (code >= 0xff01 && code <= 0xff5e) {
            out += String.fromCodePoint(code - 0xfee0);
        } else if (code === 0x3000) {
            out += ' ';
        } else {
            out += ch;
        }
    }
    return out.toLowerCase();
}

/**
 * 切词。
 * @param {string} text
 * @param {{ dictionary?: Iterable<string> }} [opts] 词典词（实体名/别名），会被整词输出
 * @returns {string[]} term 列表（可能有重复，用于词频）
 */
export function segment(text, opts = {}) {
    const s = normalizeForIndex(text);
    if (!s) return [];
    const terms = [];

    // 词典整词匹配（先做，保证实体词一定进入索引）
    const dictionary = opts.dictionary ? [...opts.dictionary] : [];
    for (const raw of dictionary) {
        const word = normalizeForIndex(raw);
        if (!word) continue;
        let from = 0;
        while (true) {
            const idx = s.indexOf(word, from);
            if (idx === -1) break;
            terms.push(`D:${word}`);
            from = idx + word.length;
        }
    }

    // CJK：单字（支持一字名）+ bigram（两字名/短语），索引与查询使用同一规则
    for (const m of s.matchAll(new RegExp(CJK_RUN, 'gu'))) {
        const run = m[0];
        for (const ch of run) {
            if (!STOP_CHARS.has(ch)) terms.push(ch);
        }
        for (let i = 0; i < run.length - 1; i += 1) {
            const bigram = run.slice(i, i + 2);
            if (STOP_BIGRAMS.has(bigram)) continue;
            terms.push(bigram);
        }
    }

    // 拉丁/数字词
    for (const m of s.matchAll(LATIN_RUN)) {
        const word = m[0];
        if (word.length < 2 && !/\d/.test(word)) continue;
        terms.push(word);
    }

    return terms;
}

/** 去重后的查询词（用于检索入口，避免重复计分）。 */
export function segmentQuery(text, opts = {}) {
    return [...new Set(segment(text, opts))];
}

export function termCount(text, opts = {}) {
    return segment(text, opts).length;
}
