/**
 * API 安全层：本地凭证、配对、Origin/Host 校验、请求限额、CSRF 防护。
 *
 * 需求 4.7：
 *   - 本地服务默认 loopback，随机凭证，Origin/Host 校验，CSRF 防护和请求限额；
 *   - 同源桥接只允许当前 SillyTavern 会话访问；
 *   - LAN 模式必须显式开启并提供鉴权说明；
 *   - API Key 不得写入 URL、日志、导出文件或诊断包。
 */

import { randomToken, randomPairingCode, safeEqual } from '../util/ids.js';
import { readJsonFile, writeJsonAtomic } from '../config.js';

const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_LOCKOUT_MS = 5 * 60 * 1000;

export class Security {
    /** @param {{ config: object, logger?: object }} opts */
    constructor({ config, logger }) {
        this.config = config;
        this.logger = logger ?? null;
        this.pairing = null; // { code, expiresAt, origin }
        this.pairFailures = 0;
        this.lockedUntil = 0;
        this.rateBuckets = new Map();
        this.allowedOrigins = new Set();
        this.#loadCredential();
        this.#loadOrigins();
    }

    #loadCredential() {
        const existing = readJsonFile(this.config.credentialFile, null);
        if (existing?.token) {
            this.token = existing.token;
            this.tokenCreatedAt = existing.createdAt ?? null;
            return;
        }
        this.token = this.config.token ?? randomToken(32);
        this.tokenCreatedAt = new Date().toISOString();
        writeJsonAtomic(this.config.credentialFile, { token: this.token, createdAt: this.tokenCreatedAt });
    }

    #loadOrigins() {
        const stored = readJsonFile(`${this.config.dataDir}/allowed-origins.json`, null);
        for (const origin of stored?.origins ?? []) this.allowedOrigins.add(origin);
    }

    #saveOrigins() {
        writeJsonAtomic(`${this.config.dataDir}/allowed-origins.json`, {
            origins: [...this.allowedOrigins],
            updatedAt: new Date().toISOString(),
        });
    }

    /** 轮换凭证（用户手动重置连接时使用）。 */
    rotateToken() {
        this.token = randomToken(32);
        this.tokenCreatedAt = new Date().toISOString();
        writeJsonAtomic(this.config.credentialFile, { token: this.token, createdAt: this.tokenCreatedAt });
        this.logger?.warn?.('security.token_rotated', {});
        return this.token;
    }

    // ---------------- 配对 ----------------

    /** 请求配对：生成 6 位配对码（在启动器控制台显示，不走网络返回）。 */
    requestPairing({ origin = null, clientName = 'unknown' } = {}) {
        if (Date.now() < this.lockedUntil) {
            return { ok: false, error: '尝试次数过多，请稍后再试', retryAfterMs: this.lockedUntil - Date.now() };
        }
        this.pairing = {
            code: randomPairingCode(),
            expiresAt: Date.now() + PAIR_TTL_MS,
            origin,
            clientName,
        };
        this.logger?.info?.('security.pair_requested', { clientName, origin });
        // 控制台醒目显示配对码
        console.log('');
        console.log('==============================================');
        console.log(`  大聪明配对码： ${this.pairing.code}`);
        console.log(`  来源：${clientName}  有效期：5 分钟`);
        console.log('  在 SillyTavern 插件面板输入此码完成连接。');
        console.log('==============================================');
        console.log('');
        return { ok: true, expiresAt: new Date(this.pairing.expiresAt).toISOString(), hint: '配对码显示在服务启动器窗口' };
    }

    /** 确认配对：校验配对码并颁发凭证。 */
    confirmPairing({ code, origin = null }) {
        if (Date.now() < this.lockedUntil) {
            return { ok: false, error: '尝试次数过多，请稍后再试' };
        }
        if (!this.pairing || Date.now() > this.pairing.expiresAt) {
            return { ok: false, error: '配对码不存在或已过期，请重新发起配对' };
        }
        if (!safeEqual(String(code ?? ''), this.pairing.code)) {
            this.pairFailures += 1;
            if (this.pairFailures >= (this.config.pairAttemptLimit ?? 5)) {
                this.lockedUntil = Date.now() + PAIR_LOCKOUT_MS;
                this.pairFailures = 0;
                this.logger?.warn?.('security.pair_lockout', {});
            }
            return { ok: false, error: '配对码错误' };
        }
        this.pairFailures = 0;
        const pairOrigin = origin ?? this.pairing.origin;
        if (pairOrigin && pairOrigin !== 'null') {
            this.allowedOrigins.add(pairOrigin);
            this.#saveOrigins();
        }
        const clientName = this.pairing.clientName;
        this.pairing = null;
        this.logger?.info?.('security.paired', { clientName, origin: pairOrigin });
        return { ok: true, token: this.token, note: '凭证仅保存在本机，请勿分享' };
    }

    // ---------------- 请求校验 ----------------

    /** Host 校验：非 LAN 模式只允许 loopback。 */
    checkHost(req) {
        const host = String(req.headers.host ?? '');
        const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
        if (this.config.lanMode) return { ok: true, lan: true };
        const loopback = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
        if (loopback.includes(hostname)) return { ok: true };
        return { ok: false, reason: `Host 校验失败：${hostname}（LAN 模式未开启）` };
    }

    /** Origin 校验：允许同源桥接、已配对来源与 loopback 页面。 */
    checkOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return { ok: true, origin: 'none' }; // 非浏览器客户端（curl/测试）
        if (this.allowedOrigins.has(origin)) return { ok: true, origin };
        try {
            const url = new URL(origin);
            const loopbackHosts = ['127.0.0.1', 'localhost', '::1'];
            if (loopbackHosts.includes(url.hostname)) return { ok: true, origin };
            if (this.config.lanMode) {
                // LAN 模式下允许同主机访问（ST 服务地址），但要求已鉴权（token 校验在后）
                return { ok: true, origin, lan: true };
            }
        } catch {
            return { ok: false, reason: `Origin 非法：${origin}` };
        }
        return {
            ok: false,
            reason: `Origin 未授权：${origin}。请先在插件中完成配对（同源桥接），或在服务启动参数中开启 LAN 模式。`,
        };
    }

    verifyToken(req) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!token) return false;
        return safeEqual(token, this.token);
    }

    /** 简单令牌桶：按 IP 与桶类型限流。 */
    rateLimit(ip, bucket = 'api') {
        const limit = bucket === 'pair' ? 10 : (this.config.rateLimitPerMinute ?? 240);
        const key = `${bucket}:${ip}`;
        const now = Date.now();
        const entry = this.rateBuckets.get(key);
        if (!entry || now > entry.resetAt) {
            this.rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
            return { ok: true, remaining: limit - 1 };
        }
        entry.count += 1;
        if (entry.count > limit) {
            return { ok: false, retryAfterMs: entry.resetAt - now };
        }
        return { ok: true, remaining: limit - entry.count };
    }

    /** CSRF 防护：写操作要求 JSON Content-Type（表单跨站提交无法携带）。 */
    checkCsrf(req) {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return { ok: true };
        const contentType = String(req.headers['content-type'] ?? '');
        if (!contentType.includes('application/json')) {
            return { ok: false, reason: '写操作必须使用 application/json（CSRF 防护）' };
        }
        return { ok: true };
    }

    status() {
        return {
            paired: this.allowedOrigins.size > 0,
            allowedOrigins: [...this.allowedOrigins],
            tokenCreatedAt: this.tokenCreatedAt,
            lanMode: Boolean(this.config.lanMode),
            pairingActive: Boolean(this.pairing && Date.now() < this.pairing.expiresAt),
        };
    }
}
