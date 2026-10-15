/**
 * Token 估算。
 *
 * 需求约束：无法获得精确 tokenizer 时必须保守估算并明确标记“估算”。
 * 本模块只做规划用估算；发送前的最终校验由扩展使用 SillyTavern 自带
 * tokenizer 完成（见 extension/not-forgotten/index.js 的 finalCheck）。
 *
 * 估算模型（heuristic-cjk-v1）：
 *   - CJK 字符：约 1.5 token/字（覆盖 GPT/Llama/Qwen 系常见中文分词密度）
 *   - 其他字符（拉丁、数字、标点、空白）：约 1 token / 4 字符
 *   - 保守系数 1.15，用于预算规划，方向是“高估输入”，避免超限。
 */

import { isCJKChar } from './text.js';

export const TOKENIZER_VERSION = 'heuristic-cjk-v1';
export const CONSERVATIVE_FACTOR = 1.15;

export function estimateTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        if (isCJKChar(ch)) cjk += 1;
        else other += 1;
    }
    const raw = cjk * 1.5 + other / 4;
    return Math.max(1, Math.ceil(raw));
}

export function estimateTokensConservative(text) {
    const base = estimateTokens(text);
    if (base === 0) return 0;
    return Math.ceil(base * CONSERVATIVE_FACTOR);
}

export function countMessagesTokens(messages, { conservative = true } = {}) {
    const fn = conservative ? estimateTokensConservative : estimateTokens;
    let total = 0;
    for (const m of messages ?? []) {
        const content = typeof m === 'string' ? m : (m?.content ?? '');
        total += fn(content);
        total += 4; // 角色/分隔符开销的保守近似
    }
    return total;
}

export function tokenAccuracyInfo() {
    return {
        level: 'estimate',
        method: TOKENIZER_VERSION,
        conservativeFactor: CONSERVATIVE_FACTOR,
        note: '本地估算，未使用精确 tokenizer；发送前由 SillyTavern 侧做最终计数。',
    };
}
