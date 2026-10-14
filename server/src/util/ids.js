/**
 * 稳定标识与哈希工具。
 * 所有派生记录的来源、去重、幂等键都依赖这里的确定性哈希。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export function uuid() {
    return randomUUID();
}

export function sha256(input) {
    return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

export function shortHash(input, len = 12) {
    return sha256(input).slice(0, len);
}

/** 归一化文本用于内容指纹：统一换行、压缩空白、去首尾空白。 */
export function normalizeForHash(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 内容指纹：用于去重、编辑检测与摘要漂移检测。 */
export function contentFingerprint(text) {
    return sha256(normalizeForHash(text));
}

/** 确定性 JSON 序列化（键排序），用于幂等键与快照校验。 */
export function stableStringify(value) {
    return JSON.stringify(sortValue(value));
}

function sortValue(value) {
    if (Array.isArray(value)) {
        return value.map(sortValue);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortValue(value[key]);
        }
        return out;
    }
    return value === undefined ? null : value;
}

export function idempotencyKey(parts) {
    return sha256(stableStringify(parts));
}

/** 常数时间比较，用于服务凭证校验。 */
export function safeEqual(a, b) {
    const bufA = Buffer.from(String(a ?? ''), 'utf8');
    const bufB = Buffer.from(String(b ?? ''), 'utf8');
    if (bufA.length !== bufB.length) {
        // 长度不同也做一次比较，避免计时侧信道泄露长度信息。
        timingSafeEqual(bufA, bufA);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}

/** 生成随机服务凭证 / 配对码。 */
export function randomToken(bytes = 32) {
    return createHash('sha256')
        .update(randomUUID() + randomUUID())
        .digest('hex')
        .slice(0, bytes * 2);
}

export function randomPairingCode() {
    const n = Math.floor(Math.random() * 1_000_000);
    return String(n).padStart(6, '0');
}
