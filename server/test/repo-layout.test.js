import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 仓库布局守卫：保证「酒馆内置扩展安装器」可用，且两份 manifest 不漂移。
 *
 * SillyTavern 的安装器（src/endpoints/extensions.js）会把仓库克隆到
 * public/scripts/extensions/third-party/<仓库名>/，然后**只认仓库根目录的 manifest.json**
 * （找不到就删掉克隆并返回 500）。因此：
 *   1) 根目录必须有 manifest.json；
 *   2) 它的 js/css 必须指到真实存在的文件；
 *   3) 扩展入口里对 ST 核心的引用必须是绝对路径 /scripts/extensions.js ——
 *      否则从 third-party/<repo>/extension/not-forgotten/ 这种更深一层的位置加载时，
 *      '../../../extensions.js' 会解析到 third-party/extensions.js（404）。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT_DIR = path.join(ROOT, 'extension', 'not-forgotten');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('仓库根目录的 manifest.json 存在且指向真实文件（供酒馆安装器使用）', () => {
    const rootManifestPath = path.join(ROOT, 'manifest.json');
    assert.ok(fs.existsSync(rootManifestPath), '仓库根目录必须有 manifest.json，否则酒馆「安装扩展」会失败');

    const manifest = readJson(rootManifestPath);
    assert.equal(typeof manifest.display_name, 'string');
    assert.equal(typeof manifest.author, 'string');
    assert.equal(typeof manifest.version, 'string');
    assert.equal(manifest.generate_interceptor, 'notforgotten_generateInterceptor');

    // js / css 是相对「扩展目录」（= 仓库根）的路径，必须真实存在
    assert.equal(manifest.js, 'extension/not-forgotten/index.js');
    assert.equal(manifest.css, 'extension/not-forgotten/style.css');
    assert.ok(fs.existsSync(path.join(ROOT, manifest.js)), `manifest.js 指向的文件不存在：${manifest.js}`);
    assert.ok(fs.existsSync(path.join(ROOT, manifest.css)), `manifest.css 指向的文件不存在：${manifest.css}`);
});

test('根 manifest 与扩展内 manifest 字段一致（仅 js/css 因安装位置不同而不同）', () => {
    const root = readJson(path.join(ROOT, 'manifest.json'));
    const inner = readJson(path.join(EXT_DIR, 'manifest.json'));

    // 扩展内 manifest 用于「把 extension/not-forgotten 整个文件夹拷进 third-party/not-forgotten」的手动/脚本安装
    assert.equal(inner.js, 'index.js');
    assert.equal(inner.css, 'style.css');
    assert.ok(fs.existsSync(path.join(EXT_DIR, inner.js)));
    assert.ok(fs.existsSync(path.join(EXT_DIR, inner.css)));

    const keys = new Set([...Object.keys(root), ...Object.keys(inner)]);
    for (const key of keys) {
        if (key === 'js' || key === 'css' || key === 'homePage') continue;
        assert.deepEqual(root[key], inner[key], `manifest 字段 "${key}" 在两份文件里不一致（请同步）`);
    }
});

test('扩展入口用绝对路径引用 ST 核心，不依赖扩展所在目录深度', () => {
    const entry = fs.readFileSync(path.join(EXT_DIR, 'index.js'), 'utf8');
    const imports = entry.match(/^\s*import[^;]*from\s+'([^']+)';/gm) ?? [];
    const specifiers = imports.map((line) => line.match(/from\s+'([^']+)'/)[1]);
    assert.ok(
        specifiers.includes('/scripts/extensions.js'),
        `扩展入口必须以绝对路径引用 ST 核心，实际引用：${JSON.stringify(specifiers)}`,
    );
    assert.ok(
        !specifiers.some((s) => s.startsWith('..')),
        `扩展入口不应出现相对上级引用（会随安装位置变化而失效）：${JSON.stringify(specifiers)}`,
    );
});

test('仓库根的 package.json 让「git clone 到 plugins/」直接成为可用的服务端插件', async () => {
    // SillyTavern 的 plugin-loader 会遍历 plugins/ 下的目录：先看 package.json 的 main，
    // 再依次找 index.js / index.cjs / index.mjs。因此把仓库整个 clone 到 plugins/<name> 后，
    // 只要根 package.json 的 main 指向插件入口，就能被加载（且随 ST 的 enableServerPluginsAutoUpdate 自动更新）。
    const pkgPath = path.join(ROOT, 'package.json');
    assert.ok(fs.existsSync(pkgPath), '仓库根目录必须有 package.json，否则 clone 到 plugins/ 无法被识别');

    const pkg = readJson(pkgPath);
    assert.equal(pkg.main, 'st-plugin/not-forgotten/index.mjs');
    const entryPath = path.join(ROOT, pkg.main);
    assert.ok(fs.existsSync(entryPath), `package.json 的 main 指向的文件不存在：${pkg.main}`);

    // 直接按 ST 的契约加载一次：必须有 info{id,name,description} 与 init()
    const mod = await import(pathToFileURL(entryPath).href);
    const plugin = mod.default ?? mod;
    const info = plugin.info ?? plugin.default?.info;
    assert.equal(typeof info, 'object');
    for (const field of ['id', 'name', 'description']) {
        assert.equal(typeof info[field], 'string', `插件 info 缺少字段 ${field}`);
    }
    assert.ok(/^[a-z0-9_-]+$/.test(info.id), `插件 id 不合法：${info.id}`);
    assert.equal(info.id, 'not-forgotten');
    assert.equal(typeof (plugin.init ?? plugin.default?.init), 'function', '插件必须导出 init 函数');
});

test('插件在「整仓 clone 到 plugins/」布局下也能找到内核并挂载路由', async () => {
    // 仓库里 st-plugin/not-forgotten/ 只有入口文件，没有 src/（扁平安装时由安装脚本拷进去）。
    // 所以入口必须能向上找到 <仓库根>/server/src，否则 `git clone <仓库> plugins/not-forgotten` 会加载失败。
    const entryPath = path.join(ROOT, 'st-plugin', 'not-forgotten', 'index.mjs');
    const mod = await import(pathToFileURL(entryPath).href);

    const serverRoot = mod.resolveServerRoot();
    assert.ok(
        fs.existsSync(path.join(serverRoot, 'service.js')),
        `插件解析出的内核目录里没有 service.js：${serverRoot}`,
    );
    assert.equal(
        path.resolve(serverRoot),
        path.join(ROOT, 'server', 'src'),
        '在仓库布局下应回退到 <仓库根>/server/src',
    );

    // 按 ST 的契约真跑一次 init：用一个极简 router 桩，只记录注册了哪些路由
    const registered = [];
    const router = {};
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
        router[method] = (p) => { registered.push(`${method.toUpperCase()} ${p}`); };
    }
    const mounted = await mod.init(router);
    assert.ok(mounted.mounted > 30, `应挂载 30+ 条路由，实际 ${mounted.mounted}`);
    assert.deepEqual(
        [...mounted.skipped].sort(),
        ['POST /api/pair/confirm', 'POST /api/pair/request', 'POST /api/shutdown'],
        '插件模式必须屏蔽配对与关机路由',
    );
    assert.ok(registered.some((r) => r.endsWith('/events')), '应注册 SSE /events');
    await mod.exit();
});

test('一条 git clone 装全前后端：init 时自动把浏览器扩展同步进 ST 全局扩展目录', async () => {
    // 模拟一个 SillyTavern 根目录（config.yaml + src/plugin-loader.js）与用户数据目录
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-stroot-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'config.yaml'), 'enableServerPlugins: true\n');
        fs.writeFileSync(path.join(tmp, 'src', 'plugin-loader.js'), '// stub\n');

        const entryPath = path.join(ROOT, 'st-plugin', 'not-forgotten', 'index.mjs');
        const mod = await import(pathToFileURL(entryPath).href);

        // looksLikeStRoot：识别 ST 根；非 ST 目录必须返回 false
        assert.equal(mod.looksLikeStRoot(tmp), true);
        assert.equal(mod.looksLikeStRoot(os.tmpdir()), false);

        // 整仓布局：扩展同步到 <stRoot>/public/scripts/extensions/third-party/not-forgotten
        const result = mod.syncExtensionToPublic({ stRoot: tmp });
        assert.equal(result.synced, true, `扩展同步应成功：${result.reason ?? ''}`);
        const target = path.join(tmp, 'public', 'scripts', 'extensions', 'third-party', 'not-forgotten');
        assert.ok(fs.existsSync(path.join(target, 'manifest.json')), '同步后的扩展目录必须有 manifest.json');
        assert.ok(fs.existsSync(path.join(target, 'index.js')), '同步后的扩展目录必须有 index.js');

        // 幂等：重复同步不报错且仍是完整目录
        const again = mod.syncExtensionToPublic({ stRoot: tmp });
        assert.equal(again.synced, true);
        assert.ok(fs.existsSync(path.join(target, 'manifest.json')));

        // 非 ST 环境（stRoot 传不存在结构的目录）→ 跳过而非报错
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-nost-'));
        try {
            const skipped = mod.syncExtensionToPublic({ stRoot: empty });
            assert.equal(skipped.synced, false);
            assert.match(skipped.reason, /未检测到 SillyTavern/);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
