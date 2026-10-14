/**
 * 测试辅助：临时数据目录 + 装配完整服务 + HTTP 服务器。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Logger } from '../src/util/logger.js';
import { Service } from '../src/service.js';
import { createHttpServer } from '../src/api/server.js';

process.env.DCM_LOG_STDOUT = '0';
process.env.DCM_LOG_LEVEL = 'error';

export function tempDir(prefix = 'dcm-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function makeService({ settings = {}, storeKind = 'auto', dir = null } = {}) {
    const dataDir = dir ?? tempDir();
    const config = loadConfig(['--data-dir', dataDir]);
    Object.assign(config, settings);
    const logger = new Logger({ level: 'error' });
    const service = await Service.create({ config, logger, storeKind });
    return {
        service,
        config,
        logger,
        dir: dataDir,
        async cleanup() {
            try { await service.stop(); } catch { /* ignore */ }
            try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
}

export async function makeServer(opts = {}) {
    const ctx = await makeService(opts);
    const server = createHttpServer({ service: ctx.service, config: ctx.config, logger: ctx.logger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    return {
        ...ctx,
        server,
        port,
        base,
        token: ctx.service.security.token,
        async request(method, pathname, { body = null, token = ctx.service.security.token, headers = {} } = {}) {
            const res = await fetch(`${base}${pathname}`, {
                method,
                headers: {
                    ...(body ? { 'content-type': 'application/json' } : {}),
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                    ...headers,
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            let payload = null;
            try { payload = await res.json(); } catch { /* ignore */ }
            return { status: res.status, payload };
        },
        async cleanup() {
            await new Promise((resolve) => server.close(resolve));
            await ctx.cleanup();
        },
    };
}

/** 构造一条 ST 风格消息。 */
export function msg(floorIndex, content, { isUser = false, name = isUser ? '你' : '助手', sendDate = null, swipeId = null, isSystem = false } = {}) {
    return {
        floorIndex,
        content,
        isUser,
        isSystem,
        name,
        sendDate: sendDate ?? `2026-01-01T00:${String(Math.floor(floorIndex / 60)).padStart(2, '0')}:${String(floorIndex % 60).padStart(2, '0')}.000Z`,
        swipeId,
    };
}

/** 交替对话的简单消息序列。 */
export function dialogue(pairs, { startFloor = 0, name = '助手' } = {}) {
    const out = [];
    let floor = startFloor;
    for (const [user, assistant] of pairs) {
        out.push(msg(floor, user, { isUser: true }));
        floor += 1;
        if (assistant !== undefined && assistant !== null) {
            out.push(msg(floor, assistant, { name }));
            floor += 1;
        }
    }
    return out;
}

/** 计划请求的最小构造。 */
export function planRequest(messages, {
    chatId = 'test-chat', branchId = 'main', scope = null, userInput = null,
    blocks = [], contextLimit = 4096, outputReserve = 512, tier = 'balanced', options = {},
} = {}) {
    const lastUser = [...messages].reverse().find((m) => m.isUser);
    return {
        chatId,
        branchId,
        scope: scope ?? `chat:${chatId}`,
        userInput: userInput ?? lastUser?.content ?? '',
        messages,
        blocks,
        budget: { contextLimit, outputReserve },
        tier,
        options,
    };
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
