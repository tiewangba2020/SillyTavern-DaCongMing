/**
 * 诊断日志。
 *
 * 需求 4.7 / US-06：日志默认只存摘要、哈希、来源 id、版本、耗时和错误类型，
 * 不保存完整私密正文。本模块提供 redact() 与固定字段的日志写入，
 * 并把结构化条目同时写入内存环形缓冲与存储层（诊断正文按需截断）。
 */

import { shortHash } from './ids.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
    /**
     * @param {{ level?: string, sink?: (entry: object) => void, maxBuffer?: number }} [opts]
     */
    constructor(opts = {}) {
        this.level = opts.level ?? 'info';
        this.sink = opts.sink ?? null;
        this.buffer = [];
        this.maxBuffer = opts.maxBuffer ?? 500;
    }

    setSink(sink) {
        this.sink = sink;
    }

    setLevel(level) {
        if (LEVELS[level]) this.level = level;
    }

    log(level, event, fields = {}) {
        if (LEVELS[level] < LEVELS[this.level]) return;
        const entry = {
            ts: new Date().toISOString(),
            level,
            event,
            ...redact(fields),
        };
        this.buffer.push(entry);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();
        if (this.sink) {
            try {
                this.sink(entry);
            } catch {
                // 日志失败不能影响主流程
            }
        }
        if (process.env.DCM_LOG_STDOUT !== '0') {
            const line = `[${entry.ts}] ${level.toUpperCase()} ${event} ${JSON.stringify(entry, replacer)}`;
            if (level === 'error') console.error(line);
            else console.log(line);
        }
    }

    debug(event, fields) { this.log('debug', event, fields); }
    info(event, fields) { this.log('info', event, fields); }
    warn(event, fields) { this.log('warn', event, fields); }
    error(event, fields) { this.log('error', event, fields); }

    recent(n = 100) {
        return this.buffer.slice(-n);
    }
}

function replacer(key, value) {
    if (key === 'ts' || key === 'level' || key === 'event') return value;
    return value;
}

const TEXT_KEYS = new Set(['text', 'content', 'message', 'body', 'prompt', 'completion']);
const SECRET_KEYS = /(key|token|secret|password|authorization|credential)/i;

/**
 * 脱敏：正文只保留长度与哈希前缀；密钥类字段整体移除。
 * @param {object} fields
 * @param {{ keepText?: boolean, textLimit?: number }} [opts]
 */
export function redact(fields, opts = {}) {
    const out = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
        if (SECRET_KEYS.test(key)) {
            out[key] = '[redacted]';
            continue;
        }
        if (TEXT_KEYS.has(key) && typeof value === 'string') {
            if (opts.keepText) {
                out[key] = value.slice(0, opts.textLimit ?? 200);
            } else {
                out[`${key}Hash`] = shortHash(value, 16);
                out[`${key}Len`] = value.length;
            }
            continue;
        }
        if (typeof value === 'string' && value.length > 400) {
            out[key] = `${value.slice(0, 120)}…[${value.length} chars]`;
            continue;
        }
        out[key] = value;
    }
    return out;
}

export const defaultLogger = new Logger({ level: process.env.DCM_LOG_LEVEL ?? 'info' });
