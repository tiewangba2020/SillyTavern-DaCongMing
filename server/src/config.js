/**
 * 服务配置与运行时文件。
 * 配置来源优先级：命令行参数 > 环境变量 > dataDir/settings.json > 默认值。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(__dirname, '..');
export const SERVICE_NAME = 'not-forgotten-memory-service';
export const SERVICE_VERSION = '0.4.1';
export const SCHEMA_VERSION = 1;
export const PLANNER_VERSION = 'planner-v1';
export const EXTRACTOR_VERSION = 'rule-extractor-v1';
export const SUMMARIZER_VERSION = 'extractive-v1';

export const DEFAULTS = Object.freeze({
    host: '127.0.0.1',
    port: 8787,
    portScanLimit: 12,
    lanMode: false,
    logLevel: 'info',
    maxBodyBytes: 24 * 1024 * 1024,
    rateLimitPerMinute: 240,
    pairAttemptLimit: 5,
    taskConcurrency: 1,
    taskMaxAttempts: 3,
    tier: 'balanced',
    // 自定义档位参数（tier='custom' 时生效；null = 全部用均衡档默认）
    // 字段见 budget.js getTier 的白名单与夹取范围
    customTier: null,
    privacy: 'local-only', // local-only | reuse-st | dedicated
    autoManage: false,
    // 观察期（dry-run）档位：'first-n' = 前 shadowTurns 轮只记录不注入；'off' = 不设观察期。
    // 注意：不要用布尔值——旧默认 `true` 会让 #inShadow() 恒真，自动抽取的事实永远停在
    // candidate（不可召回），等于自动记忆完全失效。
    shadowMode: 'first-n',
    shadowTurns: 20,
    allowRemoteEmbedding: false,
    allowJev: false,
    // TypeSafe Jev 门控的外置决策端点（见 providers/jev.js）。
    // 端点需接受 POST {model, state, questions} 并返回 {answers:{...}}；
    // 为空时即使 allowJev=true 也只走规则计划。
    jevEndpoint: '',
    jevApiKey: '',
    jevModel: 'jev-latest',
    jevTimeoutMs: 8000,
    jevMinConfidence: 0.4,
    // 问题指令（提示词）变体：v1 简洁 / v2 精调（面向中文角色扮演长聊）
    jevInstructions: 'v1',
    allowCloudSync: false,
    allowTelemetry: false,
    diagnosticsRetentionDays: 7,
    backupKeep: 5,
    safetyMarginRatio: 0.05,
    compressionTriggerRatio: 0.75,
});

export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function readJsonFile(file, fallback = null) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/** 原子写入 JSON：临时文件 + rename，Windows 下对 EPERM 做一次重试。 */
export function writeJsonAtomic(file, value) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY')) {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
            fs.renameSync(tmp, file);
        } else {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            throw err;
        }
    }
    return file;
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === '--port') out.port = Number(next());
        else if (arg === '--host') out.host = next();
        else if (arg === '--data-dir') out.dataDir = next();
        else if (arg === '--lan') out.lanMode = true;
        else if (arg === '--token') out.token = next();
        else if (arg === '--log-level') out.logLevel = next();
        else if (arg === '--store') out.storeKind = next(); // auto | sqlite | journal
        else if (arg === '--print-pairing') out.printPairing = true;
    }
    return out;
}

/**
 * 由「显式数据目录 + 可选参数」构造配置。
 *
 * 单独抽出是为了让 SillyTavern 服务端插件模式能按用户目录
 * （`req.user.directories.root`）各建一份配置，而不触碰默认数据目录。
 *
 * @param {{ dataDir?: string, args?: object, env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveConfig({ dataDir, args = {}, env = process.env } = {}) {
    const dir = path.resolve(
        dataDir
        ?? args.dataDir
        ?? env.DCM_DATA_DIR
        ?? path.join(SERVER_ROOT, 'data'),
    );
    ensureDir(dir);

    const settingsFile = path.join(dir, 'settings.json');
    const stored = readJsonFile(settingsFile, {}) ?? {};

    const config = {
        ...DEFAULTS,
        ...stored,
        ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)),
        dataDir: dir,
        settingsFile,
        dbFile: path.join(dir, 'memory.sqlite'),
        journalDir: path.join(dir, 'journal'),
        runtimeFile: path.join(dir, 'runtime.json'),
        credentialFile: path.join(dir, 'credential.json'),
        backupDir: path.join(dir, 'backups'),
        exportDir: path.join(dir, 'exports'),
        // 该数据目录是否已有持久化设置：客户端据此决定「采用服务端配置」还是「推送本地配置」。
        // 首次建库（如插件模式播种）后即为 true。
        settingsPersisted: Object.keys(stored).length > 0,
    };

    if (env.DCM_PORT) config.port = Number(env.DCM_PORT);
    if (env.DCM_HOST) config.host = env.DCM_HOST;
    if (env.DCM_LAN === '1') config.lanMode = true;

    if (config.lanMode && config.host === '127.0.0.1') {
        // LAN 模式必须显式确认；仅当用户传 --lan 时才生效，且默认仍绑定具体地址由用户决定
        config.host = '0.0.0.0';
    }

    ensureDir(config.backupDir);
    ensureDir(config.exportDir);
    return config;
}

export function loadConfig(argv = process.argv.slice(2)) {
    return resolveConfig({ args: parseArgs(argv) });
}

/** 可持久化的设置子集（其余为运行时参数）。 */
export const PERSISTED_SETTING_KEYS = [
    'tier', 'customTier', 'privacy', 'autoManage', 'shadowMode', 'shadowTurns',
    'allowRemoteEmbedding', 'allowJev', 'allowCloudSync', 'allowTelemetry',
    // TypeSafe Jev 门控配置（含 apiKey：settings.json 位于本机 data 目录，本就是凭证存放处）
    'jevEndpoint', 'jevApiKey', 'jevModel', 'jevTimeoutMs', 'jevMinConfidence', 'jevInstructions',
    'logLevel', 'lanMode', 'diagnosticsRetentionDays', 'backupKeep',
    'safetyMarginRatio', 'compressionTriggerRatio', 'taskConcurrency', 'taskMaxAttempts',
];

export function persistSettings(config) {
    const out = {};
    for (const key of PERSISTED_SETTING_KEYS) out[key] = config[key];
    writeJsonAtomic(config.settingsFile, out);
    // 写盘后即为「已有用户配置」，客户端据此不再用本地默认覆盖服务端
    config.settingsPersisted = true;
    return out;
}
