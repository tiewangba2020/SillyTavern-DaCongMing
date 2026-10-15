/**
 * 大聪明 · 记忆服务 · SillyTavern 服务端插件（内嵌模式）
 *
 * 安装位置：<SillyTavern>/plugins/dacongming/
 *   index.mjs        本文件（插件入口）
 *   package.json     type=module（让 src/ 下的 .js 按 ESM 解析）
 *   src/             复制自大聪明的 server/src（零第三方依赖）
 *   config.json      可选配置
 *
 * 与「独立服务」模式的区别：
 *   - 跑在 SillyTavern 自己的 node 进程里，不需要单独开窗口、不占用端口；
 *   - 路由挂在 /api/plugins/dacongming（ST 在 requireLoginMiddleware 之后加载插件，
 *     请求已由 ST 鉴权并带上 req.user），因此不需要配对码与服务凭证；
 *   - 每个 ST 用户按 req.user.directories.root 使用独立数据目录 <用户目录>/dacongming，
 *     多用户数据天然隔离。
 *
 * 契约（SillyTavern/src/plugin-loader.js）：导出 info{id,name,description} 与
 * async init(router)，可选 exit()。id 只允许小写字母、数字、下划线与连字符。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
    id: 'dacongming',
    name: '大聪明 · 记忆服务',
    description: '在 SillyTavern 进程内提供记忆管理与上下文压缩（无需独立窗口、端口与配对）。',
};

export const PLUGIN_VERSION = '0.3.5';

/** @type {{ serverRoot: string, dataSubdir: string, storeKind: string, logLevel: string, seedSettings: object } | null} */
let settings = null;

/** @type {null | { Service: Function, host: object, resolveConfig: Function, Logger: Function, SERVICE_VERSION: string }} */
let core = null;

let logger = null;
let mounted = null;

/** dataDir -> Promise<service>（并发请求复用同一次初始化） */
const pool = new Map();

/**
 * 解析内核目录（server/src）。两种安装方式都必须能工作：
 *   1) 扁平安装：安装脚本把 server/src 拷到插件目录下 → <插件目录>/src
 *   2) 整仓 clone 到 plugins/<仓库名> → <仓库根>/server/src
 *      （仓库里 st-plugin/dacongming/ 只有入口文件，没有 src/，所以要向上找）
 * @returns {string} 含 service.js 的内核目录
 */
export function resolveServerRoot() {
    const candidates = [
        path.join(__dirname, 'src'),
        path.resolve(__dirname, '..', '..', 'server', 'src'),
    ];
    return candidates.find((dir) => fs.existsSync(path.join(dir, 'service.js'))) ?? candidates[0];
}

/** 是否看起来像 SillyTavern 根目录（同时有 config.yaml 与 src/plugin-loader.js）。 */
export function looksLikeStRoot(dir) {
    try {
        return fs.existsSync(path.join(dir, 'config.yaml'))
            && fs.existsSync(path.join(dir, 'src', 'plugin-loader.js'));
    } catch {
        return false;
    }
}

/** 递归复制目录（不用 fs.cpSync：部分受限环境会终止进程，手写拷贝在所有环境一致）。 */
function copyTree(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyTree(s, d);
        else fs.copyFileSync(s, d);
    }
}

/**
 * 把浏览器扩展同步到 SillyTavern 的全局扩展目录（public/scripts/extensions/third-party/）。
 *
 * 动机：整仓 `git clone <仓库> plugins/dacongming` 一条命令装好「前端 + 后端」——
 * 服务端插件天然生效，而浏览器扩展历史上需要另跑安装脚本或 ST 内置安装器。
 * 本函数在插件加载时把 <仓库根>/extension/dacongming 整目录同步过去（先删后拷，幂等），
 * 因此 `git pull` 更新仓库并重启酒馆后，扩展与内核保持同版本。
 *
 * 仅在整仓布局（仓库根有 extension/dacongming）且位于 SillyTavern 根下时执行；
 * 扁平安装（扩展由安装脚本另行部署）或非 ST 环境直接跳过。失败只警告，不阻断插件加载。
 * @param {{ pluginDir?: string, serverRoot?: string, stRoot?: string, log?: (msg: string) => void }} [opts]
 * @returns {{ synced: boolean, target: string | null, reason?: string }}
 */
export function syncExtensionToPublic(opts = {}) {
    const pluginDir = opts.pluginDir ?? __dirname;
    const serverRoot = opts.serverRoot ?? resolveServerRoot();
    const repoRoot = path.resolve(serverRoot, '..', '..');
    const extSource = path.join(repoRoot, 'extension', 'dacongming');
    const log = opts.log ?? ((msg) => console.log(`[大聪明] ${msg}`));

    if (!fs.existsSync(path.join(extSource, 'manifest.json'))) {
        return { synced: false, target: null, reason: '扁平安装布局（无仓库根 extension/），扩展由安装脚本部署，跳过同步' };
    }
    const stRoot = opts.stRoot ?? (
        [process.cwd(), path.resolve(pluginDir, '..', '..')].find((dir) => looksLikeStRoot(dir)) ?? null
    );
    if (!stRoot || !looksLikeStRoot(stRoot)) {
        return { synced: false, target: null, reason: '未检测到 SillyTavern 根目录，跳过扩展同步' };
    }
    const target = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'dacongming');
    try {
        fs.rmSync(target, { recursive: true, force: true });
        copyTree(extSource, target);
        log(`浏览器扩展已同步到 ${target}（随插件版本更新）`);
        return { synced: true, target };
    } catch (err) {
        log(`浏览器扩展同步失败（不影响服务端功能）：${err.message}`);
        return { synced: false, target, reason: err.message };
    }
}

function readPluginConfig() {
    const defaults = {
        serverRoot: resolveServerRoot(),
        dataSubdir: 'dacongming',
        storeKind: 'auto',
        logLevel: 'info',
        // 网络受限环境的更新镜像（GitHub 加速前缀），如
        // "https://ghfast.top/https://github.com/tiewangba2020/SillyTavern-DaCongMing"
        updateMirror: '',
        // 首次为本用户建库时写入的初始设置：
        //   autoManage   —— 打开后台事实抽取（否则记忆库永远是空的）
        //   shadowMode   —— 'first-n' 对应「前 N 轮只记不注入」的既有设计
        seedSettings: { autoManage: true, shadowMode: 'first-n', shadowTurns: 20 },
    };
    const file = path.join(__dirname, 'config.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...defaults, ...parsed, seedSettings: { ...defaults.seedSettings, ...(parsed.seedSettings ?? {}) } };
    } catch {
        return defaults;
    }
}

async function loadCore(serverRoot) {
    const base = pathToFileURL(serverRoot.endsWith(path.sep) ? serverRoot : `${serverRoot}${path.sep}`);
    const [serviceMod, hostMod, configMod, loggerMod] = await Promise.all([
        import(new URL('service.js', base)),
        import(new URL('api/host.js', base)),
        import(new URL('config.js', base)),
        import(new URL('util/logger.js', base)),
    ]);
    return {
        Service: serviceMod.Service,
        host: hostMod,
        resolveConfig: configMod.resolveConfig,
        Logger: loggerMod.Logger,
        SERVICE_VERSION: configMod.SERVICE_VERSION,
    };
}

function userDataDir(req) {
    const dirs = req?.user?.directories ?? {};
    const root = dirs.root ?? dirs.dataRoot ?? null;
    if (!root) return null;
    return path.join(root, settings.dataSubdir);
}

function unauthorizedError() {
    const err = new Error('无法确定 SillyTavern 用户数据目录（请求缺少 req.user）');
    err.status = 401;
    return err;
}

function seedSettingsFile(dataDir) {
    const file = path.join(dataDir, 'settings.json');
    if (fs.existsSync(file)) return;
    try {
        fs.writeFileSync(file, JSON.stringify(settings.seedSettings, null, 2), 'utf8');
        logger?.info?.('plugin.seed_settings', { file });
    } catch (err) {
        logger?.warn?.('plugin.seed_settings_failed', { error: err.message });
    }
}

async function buildService(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    seedSettingsFile(dataDir);

    const config = core.resolveConfig({ dataDir });
    config.storeKind = settings.storeKind;
    config.logLevel = settings.logLevel;

    const service = await core.host.createHostedService({
        Service: core.Service,
        config,
        logger,
        storeKind: settings.storeKind,
        security: core.host.createPluginSecurity({}),
    });
    logger?.info?.('plugin.user_ready', {
        dataDir, store: service.data?.adapter?.kind ?? 'unknown',
    });
    return service;
}

/** 按请求解析该 ST 用户的服务实例（惰性、带并发去重）。 */
function serviceFor(req) {
    const dataDir = userDataDir(req);
    if (!dataDir) return Promise.reject(unauthorizedError());
    let pending = pool.get(dataDir);
    if (!pending) {
        pending = buildService(dataDir).catch((err) => {
            pool.delete(dataDir);
            throw err;
        });
        pool.set(dataDir, pending);
    }
    return pending;
}

/**
 * 插件自更新检查：插件目录是 git 仓库时，fetch 远端并尝试快进更新。
 *
 * 背景：ST 的 enableServerPluginsAutoUpdate 默认关闭，且 pull 在历史分叉时静默失败——
 * 用户「重启了但没更新」。这里自己负责：fetch → 比较 → `merge --ff-only`（不需要 git 身份）；
 * 能快进则更新完成（提示重启生效）；分叉则只提醒，诊断接口给出手动修复命令。
 * 任何 git 失败都静默降级，不影响服务加载。
 *
 * 网络受限环境（直连 GitHub 超时）：在插件 config.json 配 `"updateMirror"` 指向加速镜像
 * （如 `https://ghfast.top/https://github.com/OWNER/REPO`），fetch 走镜像的 FETCH_HEAD，
 * 不修改用户 remote。镜像也失败时给出明确提示。
 * @param {{ pluginDir?: string, updateMirror?: string, log?: Function }} [opts]
 */
export async function checkPluginUpdate({ pluginDir = __dirname, updateMirror = '', log = (m) => console.log(`[大聪明] ${m}`) } = {}) {
    if (!fs.existsSync(path.join(pluginDir, '.git'))) return { available: false, reason: '非 git 安装' };
    const git = (args, opts = {}) => {
        try {
            return execFileSync('git', args, { cwd: pluginDir, timeout: 45000, encoding: 'utf8', ...opts }).trim();
        } catch (err) {
            const firstLine = String(err.message ?? 'git failed').split('\n')[0];
            const e = new Error(firstLine);
            e.gitFailed = true;
            throw e;
        }
    };
    // fetch 目标：镜像 URL 优先（FETCH_HEAD），否则 origin/main
    const fetchArgs = updateMirror ? [updateMirror, 'main'] : ['origin', 'main'];
    const remoteRef = updateMirror ? 'FETCH_HEAD' : 'origin/main';
    try {
        git(['fetch', ...fetchArgs]);
        const local = git(['rev-parse', 'HEAD']);
        const remote = git(['rev-parse', remoteRef]);
        if (local === remote) return { available: false, reason: '已是最新' };
        let updated = false;
        try {
            git(['merge', '--ff-only', remoteRef]);
            updated = true;
            const via = updateMirror ? '（镜像）' : '';
            log(`检测到新版本，已自动快进更新${via}（${local.slice(0, 7)} → ${remote.slice(0, 7)}）。重启 SillyTavern 后生效。`);
        } catch {
            log(`检测到远端有新版本，但本地历史已分叉，无法自动更新。`);
            log(`手动修复：在 ${pluginDir} 执行 git fetch ${updateMirror || 'origin'} ${updateMirror ? 'main' : 'origin/main:main'} && git reset --hard ${remoteRef}，然后重启酒馆。`);
        }
        return { available: true, updated, via: updateMirror ? 'mirror' : 'origin', local: local.slice(0, 7), remote: remote.slice(0, 7) };
    } catch (err) {
        if (!err.gitFailed) throw err;
        const hint = updateMirror ? '' : '（网络受限时可在插件 config.json 配置 "updateMirror" 指向 GitHub 加速镜像）';
        return { available: false, reason: `更新检查失败：${err.message}${hint}` };
    }
}

export async function init(router) {
    settings = readPluginConfig();
    core = await loadCore(settings.serverRoot);
    logger = new core.Logger({ level: settings.logLevel });
    syncExtensionToPublic({ log: (msg) => logger?.info?.(msg) });
    logger.setSink((entry) => {
        const level = entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info';
        const line = `[大聪明] ${entry.level} ${entry.event}`;
        const fields = Object.keys(entry).filter((k) => !['ts', 'level', 'event'].includes(k));
        const extra = fields.length ? ` ${JSON.stringify(Object.fromEntries(fields.map((k) => [k, entry[k]])))}` : '';
        if (level === 'error') console.error(`${line}${extra}`);
        else if (level === 'warn') console.warn(`${line}${extra}`);
        else console.log(`${line}${extra}`);
    });

    mounted = core.host.mountRoutesOnRouter(router, {
        resolveService: serviceFor,
        logger,
    });

    // 自更新检查（异步，不阻塞路由挂载）+ 诊断查询路由
    let updateInfo = null;
    checkPluginUpdate({ updateMirror: settings.updateMirror }).then((info) => { updateInfo = info; }).catch(() => {});
    router.get('/plugin-update-info', (req, res) => {
        res.status(200).json({ ok: true, pluginVersion: PLUGIN_VERSION, update: updateInfo });
    });

    console.log(`[大聪明] 服务端插件 v${PLUGIN_VERSION} 已加载：挂载 ${mounted.mounted} 条路由于 /api/plugins/${info.id}（内核 v${core.SERVICE_VERSION}）`);
    if (mounted.skipped.length) {
        console.log(`[大聪明] 已按插件模式跳过 ${mounted.skipped.length} 条路由：${mounted.skipped.join('、')}`);
    }
    return mounted;
}

export async function exit() {
    const pending = [...pool.values()];
    pool.clear();
    for (const item of pending) {
        try {
            const service = await item;
            await service.stop();
        } catch (err) {
            console.warn(`[大聪明] 关闭服务实例失败：${err.message}`);
        }
    }
    console.log('[大聪明] 服务端插件已卸载，数据文件保留在各自用户目录下。');
}
