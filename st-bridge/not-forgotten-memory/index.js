/**
 * AI还没忘记忆服务 · SillyTavern 服务端桥接插件。
 *
 * 安装位置：SillyTavern/plugins/not-forgotten-memory/index.js
 * 作用：把浏览器端扩展的请求通过 ST 服务端代理到本机 127.0.0.1 的记忆服务，
 *       复用 SillyTavern 自身的会话鉴权（手机/LAN 访问可用），
 *       服务凭证只存在于服务器磁盘，不进入浏览器。
 *
 * 配置（可选）：同目录 config.json
 *   { "serviceUrl": "http://127.0.0.1:8787",
 *     "credentialPath": "<仓库目录>/server/data/credential.json" }
 * 未配置时按默认路径与端口工作。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'not-forgotten-memory',
    name: 'AI还没忘 · 记忆服务桥接',
    description: '同源代理本地AI还没忘记忆服务（loopback），凭证保存在服务端。',
};

function loadConfig() {
    const defaults = {
        serviceUrl: process.env.DCM_SERVICE_URL ?? 'http://127.0.0.1:8787',
        // 默认凭证位置：仓库目录与 SillyTavern 目录平级时的常见摆放。
        // 同时认新旧目录名（本地仓库文件夹可能仍叫旧名），哪个存在用哪个；都不存在时请显式配置。
        credentialPath: process.env.DCM_CREDENTIAL
            ?? ['AI还没忘', '大聪明']
                .map((dir) => path.resolve(__dirname, '..', '..', '..', dir, 'server', 'data', 'credential.json'))
                .find((file) => fs.existsSync(file))
            ?? path.resolve(__dirname, '..', '..', '..', 'AI还没忘', 'server', 'data', 'credential.json'),
    };
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
        return { ...defaults, ...JSON.parse(raw) };
    } catch {
        return defaults;
    }
}

function readToken(config) {
    try {
        const parsed = JSON.parse(fs.readFileSync(config.credentialPath, 'utf8'));
        return parsed?.token ?? null;
    } catch {
        return null;
    }
}

/** 探测多个常见端口（服务可能因端口占用自动漂移）。 */
function candidateUrls(config) {
    const urls = [config.serviceUrl];
    for (let port = 8788; port <= 8799; port += 1) {
        urls.push(`http://127.0.0.1:${port}`);
    }
    return urls;
}

async function findService(config) {
    for (const url of candidateUrls(config)) {
        try {
            const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
            if (res.ok) {
                const data = await res.json();
                if (data?.service === 'not-forgotten-memory-service') return url;
            }
        } catch { /* 尝试下一个 */ }
    }
    return null;
}

async function proxyTo(req, res, targetPath) {
    const config = loadConfig();
    const serviceUrl = await findService(config);
    if (!serviceUrl) {
        res.status(503).json({
            ok: false,
            error: '本地AI还没忘记忆服务未运行',
            fixActions: ['在电脑上运行“启动AI还没忘.cmd”', '确认服务窗口未关闭'],
        });
        return;
    }
    const token = readToken(config);
    if (!token) {
        res.status(503).json({
            ok: false,
            error: '未找到服务凭证文件',
            fixActions: ['先运行本地服务生成凭证', `检查路径：${config.credentialPath}`],
        });
        return;
    }
    try {
        const res2 = await fetch(`${serviceUrl}${targetPath}`, {
            method: req.method,
            headers: {
                'content-type': req.headers['content-type'] ?? 'application/json',
                authorization: `Bearer ${token}`,
                host: new URL(serviceUrl).host,
            },
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
            signal: AbortSignal.timeout(30_000),
        });
        const text = await res2.text();
        res.status(res2.status).type('application/json').send(text);
    } catch (err) {
        res.status(502).json({ ok: false, error: `代理失败：${err.message}` });
    }
}

function register(router) {
    router.get('/health', async (req, res) => {
        const config = loadConfig();
        const serviceUrl = await findService(config);
        if (!serviceUrl) {
            res.json({ ok: false, error: '本地服务未运行', bridge: true });
            return;
        }
        try {
            const r = await fetch(`${serviceUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
            const data = await r.json();
            res.json({ ...data, bridge: true, serviceUrl });
        } catch (err) {
            res.json({ ok: false, error: err.message, bridge: true });
        }
    });

    // 所有业务接口经 /proxy/* 转发
    router.all('/proxy/*', (req, res) => {
        const target = req.originalUrl.replace(/^.*\/proxy/, '') || '/';
        proxyTo(req, res, target).catch((err) => res.status(500).json({ ok: false, error: err.message }));
    });
}

export async function init(router) {
    if (router) {
        register(router);
        return;
    }
    // 某些 ST 版本不传 router：自行创建（express 来自 ST 的 node_modules）
    try {
        const express = (await import('express')).default;
        const selfRouter = express.Router();
        register(selfRouter);
        module.exports = selfRouter; // eslint-disable-line
    } catch (err) {
        console.error('[not-forgotten-memory] 无法初始化路由：', err.message);
    }
}

export const exit = async () => {};

export { register, findService, loadConfig };
