/**
 * 服务入口：启动、端口探测、运行时文件、优雅退出、修复模式。
 */

import { loadConfig, SERVICE_VERSION, writeJsonAtomic } from './config.js';
import { Logger } from './util/logger.js';
import { Service } from './service.js';
import { createHttpServer, createRepairServer } from './api/server.js';
import { MigrationError } from './store/sqlite-adapter.js';

async function main() {
    const config = loadConfig();
    const logger = new Logger({ level: config.logLevel });

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   大聪明 · 记忆管理与上下文压缩 · 本地服务    ║');
    console.log(`  ║   v${SERVICE_VERSION}   数据目录: ${shorten(config.dataDir, 26)}  ║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    let service;
    try {
        service = await Service.create({ config, logger, storeKind: config.storeKind ?? 'auto' });
    } catch (err) {
        logger.error('service.init_failed', { error: err.message, type: err.name });
        if (err instanceof MigrationError) {
            console.log('');
            console.log('  ⚠ 数据库迁移失败，进入修复模式（原始聊天不受影响）。');
            console.log(`    原因：${err.message}`);
            console.log(`    数据目录：${config.dataDir}`);
            console.log(`    备份目录：${config.backupDir}`);
            console.log('    可用修复动作：重试迁移 / 从最近备份恢复（见 /api/health）');
            console.log('');
            const repair = createRepairServer({
                config, logger, error: err,
                serviceFactory: () => Service.create({ config, logger, storeKind: config.storeKind ?? 'auto' }),
            });
            await listenWithPortScan(repair, config, logger);
            return;
        }
        console.error(`服务启动失败：${err.message}`);
        process.exit(1);
    }

    const server = createHttpServer({ service, config, logger });
    const port = await listenWithPortScan(server, config, logger);
    if (port === null) {
        console.error('端口全部被占用，无法启动。请关闭占用程序或使用 --port 指定其他端口。');
        process.exit(1);
    }

    writeJsonAtomic(config.runtimeFile, {
        pid: process.pid,
        port,
        host: config.host,
        version: SERVICE_VERSION,
        startedAt: service.startedAt,
        dataDir: config.dataDir,
    });

    const base = `http://127.0.0.1:${port}`;
    console.log(`  服务已启动：${base}`);
    console.log(`  存储：${service.adapter.kind}${service.adapter.kind === 'journal' ? '（降级模式：未检测到 node:sqlite）' : ''}`);
    console.log(`  自动管理：${config.autoManage ? '开启' : '关闭（在插件面板中开启）'}   档位：${config.tier}`);
    console.log('');
    console.log('  下一步：在 SillyTavern 扩展面板点击“连接服务”。');
    console.log('  若插件请求配对，本窗口会显示 6 位配对码。');
    console.log('  按 Ctrl+C 停止服务（不会删除聊天或记忆数据）。');
    console.log('');

    const shutdown = async (signal) => {
        console.log(`\n收到 ${signal}，正在停止……`);
        server.close();
        await service.stop();
        try { writeJsonAtomic(config.runtimeFile, { pid: process.pid, port, stoppedAt: new Date().toISOString() }); } catch { /* ignore */ }
        console.log('已停止。数据已安全落盘。');
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function listenWithPortScan(server, config, logger) {
    const startPort = Number(config.port) || 8787;
    const limit = config.portScanLimit ?? 12;
    for (let offset = 0; offset < limit; offset += 1) {
        const port = startPort + offset;
        const ok = await tryListen(server, config.host, port);
        if (ok) {
            if (offset > 0) {
                logger.warn('server.port_shifted', { requested: startPort, actual: port });
                console.log(`  端口 ${startPort} 被占用，已自动改用 ${port}。`);
            }
            return port;
        }
    }
    return null;
}

function tryListen(server, host, port) {
    return new Promise((resolve) => {
        const onError = (err) => {
            server.removeListener('listening', onListening);
            if (err.code === 'EADDRINUSE') resolve(false);
            else {
                console.error(`监听 ${host}:${port} 失败：${err.message}`);
                resolve(false);
            }
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(true);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function shorten(text, max) {
    const s = String(text);
    return s.length > max ? `…${s.slice(-(max - 1))}` : s.padEnd(max);
}

main().catch((err) => {
    console.error(`未捕获错误：${err.stack ?? err.message}`);
    process.exit(1);
});
