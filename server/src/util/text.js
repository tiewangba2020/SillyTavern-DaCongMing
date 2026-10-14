/**
 * 文本处理：归一化、句子切分、按 token 截断。
 * 句子切分服务于抽取式摘要（逐句摘录，不改写），因此需要保持标点与顺序。
 */

// 句末标点后可跟闭合引号/括号，需一并吞掉，避免「。」与「」」被切成两段。
const SENTENCE_END = /[。！？!?…]+["'”’」』）)】\]]*|\n+|[;；]/gu;
// CJK 字符：汉字/假名/谚文 + CJK 标点（U+3000-303F）+ 全角形式（U+FF00-FFEF）。
// 中文标点（，。？！「」等）在主流 tokenizer 中约 1 token/个，若按“其他字符 1/4”计
// 会把中文文本系统性低估，与“保守估算、避免超限”的设计意图相反。
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;

export function normalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/　/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function isCJKChar(ch) {
    return CJK_RE.test(ch);
}

export function cjkRatio(text) {
    const s = String(text ?? '');
    if (!s.length) return 0;
    let cjk = 0;
    for (const ch of s) {
        if (CJK_RE.test(ch)) cjk += 1;
    }
    return cjk / s.length;
}

/**
 * 句子切分：保留句末标点，合并过短片段。
 * 返回 [{ text, index }]，index 为原顺序。
 */
export function splitSentences(text) {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    // 在整串上匹配句末标记（含其后的闭合引号），而不是逐字符 test——
    // 逐字符 test 会让“吞掉闭合引号”的分支失效，把「。」和「」」切成两段。
    const raw = [];
    let last = 0;
    for (const m of normalized.matchAll(SENTENCE_END)) {
        const end = m.index + m[0].length;
        const piece = normalized.slice(last, end);
        if (piece.trim()) raw.push(piece);
        last = end;
    }
    if (last < normalized.length) {
        const tail = normalized.slice(last);
        if (tail.trim()) raw.push(tail);
    }

    const merged = [];
    for (const piece of raw) {
        const t = piece.trim();
        if (!t) continue;
        if (merged.length && t.length <= 2 && !/[。！？!?]/.test(t)) {
            merged[merged.length - 1] += t;
        } else {
            merged.push(t);
        }
    }
    return merged.map((t, index) => ({ text: t, index }));
}

export function splitParagraphs(text) {
    return normalizeText(text)
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
}

/**
 * 按 token 预算截断文本，优先在句子边界截断。
 * countFn 为 token 计数函数，默认由调用方传入以保持一致性。
 */
export function truncateToTokens(text, maxTokens, countFn) {
    const s = normalizeText(text);
    if (maxTokens <= 0) return '';
    if (countFn(s) <= maxTokens) return s;
    const sentences = splitSentences(s);
    let out = '';
    for (const { text: sentence } of sentences) {
        const next = out ? `${out} ${sentence}` : sentence;
        if (countFn(next) > maxTokens) break;
        out = next;
    }
    if (!out) {
        // 单句超预算：按字符二分截断
        let lo = 0;
        let hi = s.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (countFn(s.slice(0, mid)) <= maxTokens) lo = mid;
            else hi = mid - 1;
        }
        out = s.slice(0, lo);
    }
    return out;
}

/** 提取文本中的数字/日期信号（用于硬事实保留与时间召回）。 */
const DATE_PATTERNS = [
    /\d{4}\s*年\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?/g,
    /\d{1,2}\s*月\s*\d{1,2}\s*日/g,
    /\d{1,2}:\d{2}/g,
    /\d+(\.\d+)?\s*(天|日|周|个月|年|小时|分钟|秒|次|个|枚|把|块|公里|米)前?/g,
    /第[一二三四五六七八九十百千\d]+(天|日|周|月|年|章|节|层|次|回合)/g,
];

export function extractTimeSignals(text) {
    const s = String(text ?? '');
    const out = new Set();
    for (const re of DATE_PATTERNS) {
        for (const m of s.matchAll(re)) out.add(m[0].trim());
    }
    return [...out];
}

export function hasHardFactSignal(text) {
    return extractTimeSignals(text).length > 0 || /\d/.test(String(text ?? ''));
}
