/**
 * 大聪明 · SillyTavern 扩展入口。
 *
 * 职责：
 *   1. 主面板与记忆中心 UI；
 *   2. ST 事件适配器（摄取消息/编辑/删除/swipe/分支）；
 *   3. 发送前拦截器（generate_interceptor）：请求计划 → 应用压缩与注入 → 最终校验；
 *   4. 自动探针上报。
 *
 * 可靠性原则（需求 4.8）：拦截器任何异常都原样放行；无法满足硬预算时明确阻止并给修复动作。
 */

// 用绝对路径引用 ST 核心：这样无论扩展被放在 third-party/<name>/ 还是
// third-party/<repo>/extension/dacongming/（酒馆「安装扩展」会克隆整个仓库），
// 解析出的 URL 都是 /scripts/extensions.js，指向同一个模块实例。
import { extension_settings, getContext } from '/scripts/extensions.js';
import { BridgeClient, BridgeError, DEFAULT_DIRECT_BASE, BRIDGE_PROXY_BASE, PLUGIN_PREFIX } from './bridge.js';
import {
    buildMainPanel, buildMemoryCenter, buildMemoryCenterBody, renderStatus, renderRoundSummary,
    memoryCard, toast, el, emptyState, drawer, sectionTitle, kvRow, rawJson,
} from './ui.js';

const EXT_NAME = 'dacongming';
const EXT_VERSION = '0.3.7';
const HEURISTIC_NOTE = 'token 为本地估算，发送前由 SillyTavern tokenizer 最终校验';

const DEFAULTS = {
    enabled: false,
    tier: 'balanced',
    customTier: null,
    privacy: 'local-only',
    allowJev: false,
    // TypeSafe Jev 门控配置（在面板「高级设置」里维护，随设置一并推送服务端）
    jevEndpoint: '',
    jevApiKey: '',
    jevModel: 'system-one',
    jevTimeoutMs: 8000,
    jevMinConfidence: 0.4,
    allowRemoteEmbedding: false,
    allowCloudSync: false,
    allowTelemetry: false,
    mode: 'auto', // auto | plugin | bridge | direct
    directBase: DEFAULT_DIRECT_BASE,
    token: null,
    scopeMode: 'chat',
    blockedOnOverflow: true,
    showStatusToasts: true,
    // 用户是否在界面上显式改过设置：改过之后以本地为准，不再被服务端值覆盖
    userTouched: false,
};

/** 与服务端设置对应的独立开关字段。 */
const TOGGLE_KEYS = ['allowJev', 'allowRemoteEmbedding', 'allowCloudSync', 'allowTelemetry'];

const state = {
    mode: 'unpaired',
    base: null,
    token: null,
    connected: false,
    serviceVersion: null,
    lastPlan: null,
    lastStatus: { label: '未连接', reason: '尚未连接本地服务' },
    ingestTimer: null,
    pollTimer: null,
    sseClose: null,
    ui: null,
    center: null,
    centerInline: null,
    busy: false,
};

const settings = (() => {
    extension_settings[EXT_NAME] = { ...DEFAULTS, ...(extension_settings[EXT_NAME] ?? {}) };
    return extension_settings[EXT_NAME];
})();

const bridge = new BridgeClient({
    getMode: () => ({ mode: state.mode, base: state.base, token: state.token }),
});

// ============================================================
// 连接管理
// ============================================================

async function connect({ silent = false } = {}) {
    const preferred = settings.mode ?? 'auto';

    // 0) 内嵌服务端插件（首选）：随 ST 启停、无端口、无配对
    if (preferred === 'auto' || preferred === 'plugin') {
        const pluginInfo = await BridgeClient.detectPlugin();
        if (pluginInfo) {
            state.mode = 'plugin';
            state.base = PLUGIN_PREFIX;
            state.token = null;
            state.connected = true;
            state.serviceVersion = pluginInfo.version;
            setStatus('正常', `已连接 SillyTavern 内嵌服务（v${pluginInfo.version ?? '?'}，无需独立窗口）`);
            await syncSettingsWithServer();
            return true;
        }
    }

    // 1) 同源桥接：已装代理插件且独立服务在运行
    if (preferred === 'auto' || preferred === 'bridge') {
        const bridgeInfo = await BridgeClient.detectBridge();
        if (bridgeInfo) {
            state.mode = 'bridge';
            state.base = BRIDGE_PROXY_BASE;
            state.token = null;
            state.connected = true;
            state.serviceVersion = bridgeInfo.version;
            setStatus('正常', `已通过 SillyTavern 同源桥接连接（v${bridgeInfo.version ?? '?'}）`);
            await syncSettingsWithServer();
            return true;
        }
    }
    if (settings.token) {
        state.mode = 'direct';
        state.base = settings.directBase;
        state.token = settings.token;
        try {
            const health = await bridge.health();
            state.connected = true;
            state.serviceVersion = health.version;
            setStatus('正常', `已直连本地服务（v${health.version ?? '?'}）`);
            await syncSettingsWithServer();
            return true;
        } catch (err) {
            state.connected = false;
            setStatus('需要处理', `本地服务未响应：${err.message}`, [
                { label: '重试连接', onClick: () => connect() },
            ]);
            if (!silent) toast(`连接失败：${err.message}`, 'error');
            return false;
        }
    }
    // 未连接：先探测独立服务是否在跑，再给出可操作入口（优先推荐内嵌插件）
    let directRunning = false;
    try {
        const res = await fetch(`${settings.directBase}/api/health`);
        directRunning = res.ok;
    } catch { /* 独立服务未运行 */ }
    if (directRunning) {
        state.mode = 'unpaired';
        state.base = settings.directBase;
        state.connected = false;
        setStatus('需要处理', '检测到本地服务正在运行，但尚未配对', [
            { label: '开始配对', onClick: () => startPairing() },
        ]);
        return false;
    }
    setStatus('需要处理', '未检测到服务：可安装 SillyTavern 服务端插件（无需窗口），或启动本地服务后配对', [
        { label: '安装说明', onClick: () => showStartHint() },
        { label: '重新检测', onClick: () => connect() },
    ]);
    return false;
}

async function startPairing() {
    try {
        state.base = settings.directBase;
        state.mode = 'direct';
        await bridge.pairRequest(`SillyTavern(${location.host || 'local'})`);
        renderPairInput();
        toast('配对码已显示在本地服务窗口，请输入 6 位数字', 'info');
    } catch (err) {
        toast(`配对请求失败：${err.message}`, 'error');
    }
}

function renderPairInput() {
    const row = state.ui?.refs.pairRow;
    if (!row) return;
    row.innerHTML = '';
    const input = el('input', { class: 'text_pole dcm-pair-input', placeholder: '6 位配对码', maxlength: '6' });
    const btn = el('button', { class: 'menu_button', text: '确认配对' });
    btn.addEventListener('click', async () => {
        try {
            const result = await bridge.pairConfirm(input.value.trim());
            settings.token = result.token;
            saveSettings();
            toast('配对成功', 'success');
            row.innerHTML = '';
            await connect();
        } catch (err) {
            toast(`配对失败：${err.message}`, 'error');
        }
    });
    row.append(input, btn);
}

function showStartHint() {
    toast('两种用法：① 推荐安装 SillyTavern 服务端插件（plugins/dacongming，随 ST 启停、无需窗口与配对）；② 或运行“启动大聪明.cmd”启动独立服务后在面板配对。', 'info');
}

function setStatus(label, reason, fixActions = []) {
    state.lastStatus = { label, reason, fixActions };
    if (state.ui) renderStatus(state.ui.refs, state.lastStatus);
}

function saveSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

/**
 * 用户显式改过设置：此后以本地为准，连接时不再被服务端值覆盖。
 */
function markSettingsTouched() {
    settings.userTouched = true;
    saveSettings();
}

/**
 * 连接成功后的设置同步（双向）：
 *   - 服务端已有持久化设置、且用户没在界面上改过 → 采用服务端值（界面反映真实状态；
 *     插件模式首次建库的播种 autoManage/shadowMode 也因此生效）；
 *   - 否则把本地设置推给服务端。
 *
 * 修复点：此前只做 pushSettings()，会把插件模式的首播种（autoManage=true）
 * 直接覆盖回 false，导致「装了插件打开仍是关」。
 */
async function syncSettingsWithServer() {
    let server = null;
    try {
        server = await bridge.getSettings();
    } catch (err) {
        console.warn('[大聪明] 读取服务端设置失败，改为按本地推送', err);
    }
    const s = server?.settings ?? null;
    if (s?.settingsPersisted && !settings.userTouched) {
        settings.enabled = Boolean(s.autoManage);
        if (s.tier) settings.tier = s.tier;
        if ('customTier' in s) settings.customTier = s.customTier ?? null;
        if (s.privacy) settings.privacy = s.privacy;
        for (const key of TOGGLE_KEYS) {
            if (key in s) settings[key] = Boolean(s[key]);
        }
        // Jev 配置以服务端为准（API Key 服务端不回传，保留本地值）
        if (typeof s.jevEndpoint === 'string') settings.jevEndpoint = s.jevEndpoint;
        if (typeof s.jevModel === 'string' && s.jevModel) settings.jevModel = s.jevModel;
        if (Number.isFinite(s.jevTimeoutMs) && s.jevTimeoutMs >= 1000) settings.jevTimeoutMs = s.jevTimeoutMs;
        if (Number.isFinite(s.jevMinConfidence)) settings.jevMinConfidence = s.jevMinConfidence;
        saveSettings();
        syncUiFromSettings();
        return;
    }
    await pushSettings();
}

/**
 * 统一的「自动管理」开关逻辑（面板开关与记忆中心空状态按钮共用）。
 *
 * 注意：只改 settings 并保存是不够的——服务端的 autoManage 需要靠
 * connect()/pushSettings() 同步过去，否则抽取任务永远不会跑。
 */
async function setAutoManage(value, { silent = false } = {}) {
    settings.enabled = Boolean(value);
    markSettingsTouched();
    syncUiFromSettings();

    if (settings.enabled) {
        setStatus('后台处理中', '自动管理已开启，正在连接与探测……');
        const ok = await connect({ silent: true });
        if (ok) await reportProbe(true);
    } else {
        await pushSettings();
        setStatus('正常', '自动管理已关闭（插件不再修改发送内容）');
    }

    if (!silent) toast(settings.enabled ? '已开启自动管理' : '已关闭自动管理', 'success');
    return Boolean(settings.enabled);
}

// ============================================================
// 探针
// ============================================================

function currentCharacter(ctx) {
    const idx = ctx.characterId ?? ctx.this_chid;
    if (idx === undefined || idx === null) return null;
    return ctx.characters?.[idx] ?? null;
}

function resolveChatId(ctx) {
    const explicit = ctx.chatId ?? ctx.chatMetadata?.chat_id ?? ctx.chatMetadata?.file_name;
    if (typeof explicit === 'string' && explicit) return explicit;
    const avatar = currentCharacter(ctx)?.avatar ?? ctx.name2 ?? 'unknown';
    const first = ctx.chat?.[0]?.send_date ?? 'nofirst';
    return `${avatar}::${first}`;
}

function resolveBranchId(ctx) {
    return ctx.chatMetadata?.branch_id ?? ctx.chatMetadata?.branchId ?? 'main';
}

function scopeFor(chatId, branchId) {
    return settings.scopeMode === 'branch' ? `branch:${chatId}:${branchId}` : `chat:${chatId}`;
}

function getMaxContext(ctx) {
    const candidates = [
        ctx.maxContext,
        ctx.chatCompletionSettings?.openai_max_context,
        globalThis.oai_settings?.openai_max_context,
        ctx.textCompletionSettings?.max_context_length,
        globalThis.textgenerationwebui_settings?.max_context_length,
        globalThis.SillyTavern?.getContext?.()?.maxContext,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function getMaxTokens(ctx) {
    const candidates = [
        ctx.chatCompletionSettings?.openai_max_tokens,
        globalThis.oai_settings?.openai_max_tokens,
        ctx.textCompletionSettings?.max_tokens,
        globalThis.textgenerationwebui_settings?.max_tokens,
    ];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function getModelName(ctx) {
    const candidates = [
        ctx.chatCompletionSettings?.openai_model,
        globalThis.oai_settings?.openai_model,
        ctx.textCompletionSettings?.api_server_model,
        globalThis.textgenerationwebui_settings?.api_server_model,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value) return value;
    }
    return null;
}

function getPresetName(ctx) {
    return ctx.chatCompletionSettings?.preset_settings_openai
        ?? globalThis.oai_settings?.preset_settings_openai
        ?? ctx.textCompletionSettings?.preset_settings
        ?? null;
}

function getWorldbookKeys(ctx) {
    const keys = [];
    const book = currentCharacter(ctx)?.data?.character_book?.entries ?? [];
    for (const entry of book) {
        for (const key of entry?.keys ?? []) {
            if (typeof key === 'string' && key.length <= 20) keys.push(key);
        }
    }
    return [...new Set(keys)].slice(0, 200);
}

function detectPlugins(ctx) {
    const names = new Set();
    for (const key of Object.keys(ctx.extensionSettings ?? {})) names.add(key);
    if (Array.isArray(ctx.extensionNames)) for (const n of ctx.extensionNames) names.add(n);
    return [...names];
}

function collectProtectedBlocks(ctx) {
    const blocks = [];
    const push = (kind, text) => {
        const s = text === undefined || text === null ? '' : String(text);
        if (s.trim()) blocks.push({ id: `fixed:${kind}`, kind, text: s });
    };
    const ch = currentCharacter(ctx);
    if (ch) {
        push('card-description', ch.description);
        push('card-personality', ch.personality);
        push('card-scenario', ch.scenario);
        push('card-system', ch.system_prompt);
        push('card-post-history', ch.post_history_instructions);
    }
    push('preset-system', ctx.systemPrompt ?? ctx.system_prompt ?? globalThis.oai_settings?.sysprompt?.content);
    return blocks;
}

function collectProbe(ctx) {
    const ch = currentCharacter(ctx);
    return {
        chatId: resolveChatId(ctx),
        branchId: resolveBranchId(ctx),
        stVersion: ctx.version ?? globalThis.SillyTavern?.version ?? null,
        connectionType: ctx.chatCompletionSettings ? 'chat-completion' : (ctx.textCompletionSettings ? 'text-completion' : 'unknown'),
        model: getModelName(ctx),
        modelId: getModelName(ctx),
        contextLimit: getMaxContext(ctx),
        outputReserve: getMaxTokens(ctx),
        characterId: ch?.avatar ?? null,
        characterName: ch?.name ?? ctx.name2 ?? null,
        presetName: getPresetName(ctx),
        worldbookNames: ctx.chatMetadata?.world_info ? [ctx.chatMetadata.world_info] : [],
        worldbookKeys: getWorldbookKeys(ctx),
        groupParticipants: ctx.groupId ? (ctx.groups?.find((g) => g.id === ctx.groupId)?.members ?? []) : [],
        swipeSelection: (ctx.chat ?? []).slice(-10).map((m) => m.swipe_id ?? null).join(','),
        installedPlugins: detectPlugins(ctx),
        tokenizerAvailable: typeof ctx.getTokenCountAsync === 'function',
        extensionVersion: EXT_VERSION,
        source: 'extension-probe',
    };
}

let lastProbeAt = 0;
async function reportProbe(force = false) {
    if (!state.connected) return;
    if (!force && Date.now() - lastProbeAt < 60_000) return;
    try {
        const ctx = getContext();
        if (!ctx.chat?.length) return;
        lastProbeAt = Date.now();
        await bridge.probe(collectProbe(ctx));
    } catch (err) {
        console.warn('[大聪明] 探针上报失败', err);
    }
}

// ============================================================
// 消息摄取
// ============================================================

function mapMessages(chat) {
    return (chat ?? []).map((m, i) => ({
        floorIndex: i,
        name: m.name ?? '',
        isUser: Boolean(m.is_user),
        isSystem: Boolean(m.is_system),
        content: String(m.mes ?? ''),
        sendDate: m.send_date ?? null,
        swipeId: m.swipe_id ?? null,
    }));
}

async function ingestNow({ full = false, deleted = null, silent = true } = {}) {
    if (!state.connected) return null;
    const ctx = getContext();
    if (!ctx.chat?.length && !deleted) return null;
    const chatId = resolveChatId(ctx);
    const branchId = resolveBranchId(ctx);
    const chat = ctx.chat ?? [];
    const tail = full ? chat : chat.slice(-12);
    const baseIndex = full ? 0 : Math.max(0, chat.length - 12);
    const messages = mapMessages(tail).map((m, i) => ({ ...m, floorIndex: baseIndex + i }));
    try {
        return await bridge.ingest({
            chatId,
            branchId,
            scope: scopeFor(chatId, branchId),
            messages,
            fullSync: full,
            deleted: deleted ?? undefined,
        });
    } catch (err) {
        if (!silent) toast(`记忆同步失败：${err.message}`, 'warn');
        console.warn('[大聪明] ingest 失败', err);
        return null;
    }
}

function scheduleIngest(opts = {}) {
    if (state.ingestTimer) clearTimeout(state.ingestTimer);
    state.ingestTimer = setTimeout(() => {
        state.ingestTimer = null;
        ingestNow(opts).catch(() => {});
    }, 600);
}

// ============================================================
// 发送前拦截器
// ============================================================

function installInterceptor() {
    // ST ≥ 1.19：runGenerationInterceptors 只调用 manifest.generate_interceptor 声明的全局函数
    // （旧版 ST < 1.19 仍直接调用 globalThis.generate_interceptor），两套契约都注册。
    const KEY = 'dacongming_generateInterceptor';
    if (globalThis.generate_interceptor?.__dcm && globalThis[KEY]?.__dcm) return;
    const previous = globalThis.generate_interceptor;
    const wrapper = async function (chat, contextSize, abort, type) {
        if (typeof previous === 'function') {
            try { await previous(chat, contextSize, abort, type); } catch (err) { console.warn('[大聪明] 前序拦截器异常', err); }
        }
        try {
            await onIntercept(chat, contextSize, abort, type);
        } catch (err) {
            console.error('[大聪明] 拦截器异常（已原样放行）', err);
        }
    };
    wrapper.__dcm = true;
    globalThis.generate_interceptor = wrapper;
    globalThis[KEY] = wrapper;
}

/**
 * 构造 /api/plan 请求体。
 * 拦截器与记忆中心的「仅预览」共用，保证两边口径一致。
 */
function buildPlanRequest(ctx, { contextSize = 0, preview = false, pressure = 'soft' } = {}) {
    const chat = ctx.chat ?? [];
    const chatId = resolveChatId(ctx);
    const branchId = resolveBranchId(ctx);
    const messages = mapMessages(chat);
    const contextLimit = Number(contextSize) > 0 ? Number(contextSize) : (getMaxContext(ctx) ?? 4096);
    const outputReserve = getMaxTokens(ctx) ?? Math.max(256, Math.round(contextLimit * 0.12));
    return {
        chatId,
        branchId,
        variantSelection: chat.slice(-10).map((m) => m.swipe_id ?? null).join(','),
        scope: scopeFor(chatId, branchId),
        userInput: lastUserText(messages),
        messages,
        blocks: collectProtectedBlocks(ctx),
        budget: { contextLimit, outputReserve },
        tier: settings.tier,
        options: { preview, pressure },
    };
}

async function onIntercept(chat, contextSize, abort, type) {
    if (!settings.enabled) return;
    if (!Array.isArray(chat) || chat.length === 0) return;
    if (type === 'quiet') return;

    if (!state.connected) {
        await connect({ silent: true });
        if (!state.connected) {
            setStatus('需要处理', '本地服务未连接：本轮已原样发送', [
                { label: '重新连接', onClick: () => connect() },
            ]);
            return;
        }
    }

    const ctx = getContext();

    // 1. 先同步最新消息（本地调用，很快；失败不影响计划，继续用原文规划）
    await ingestNow({ full: false, silent: true });

    const request = buildPlanRequest(ctx, { contextSize });
    const blocks = request.blocks;

    setStatus('后台处理中', '正在规划本轮上下文……');
    let plan;
    try {
        plan = await bridge.plan(request);
    } catch (err) {
        setStatus('已降级', `计划失败，已原样发送：${err.message}`, err.fixActions?.map((f) => ({ label: f })) ?? []);
        if (settings.showStatusToasts) toast(`规划失败，原样发送：${err.message}`, 'warn');
        return;
    }

    // 2. 应用计划
    const original = chat.slice();
    applyPlan(chat, plan);

    // 3. 最终校验（ST tokenizer 精确计数）
    const available = plan.budget?.availableInput
        ?? (request.budget.contextLimit - request.budget.outputReserve);
    let measured = await measureChat(chat, blocks, ctx);
    let finalPlan = plan;

    if (measured > available) {
        try {
            finalPlan = await bridge.plan({
                ...request,
                options: { preview: false, pressure: 'hard', measuredTokens: measured },
            });
            chat.length = 0;
            chat.push(...original);
            applyPlan(chat, finalPlan);
            measured = await measureChat(chat, blocks, ctx);
        } catch (err) {
            console.warn('[大聪明] 硬压缩二次规划失败', err);
        }
    }

    if (measured > available && finalPlan.result !== 'ok') {
        if (settings.blockedOnOverflow) {
            chat.length = 0;
            chat.push(...original);
            try { abort(); } catch { /* 部分版本 abort 无参 */ }
            setStatus('需要处理', `已阻止发送：压缩后仍超出硬预算（${measured} > ${available} tokens）`, [
                { label: '查看细节', onClick: () => openCenter('本轮计划') },
                { label: '临时关闭自动管理', onClick: () => setAutoManage(false, { silent: true }) },
            ]);
            toast('已阻止发送：上下文仍超出硬预算。可在记忆中心查看原因，或临时关闭自动管理。', 'error');
            return;
        }
        toast('仍超出预算，已按设置原样发送（风险：可能触发模型截断）', 'warn');
    }

    state.lastPlan = finalPlan;
    renderRoundSummary(state.ui.refs, {
        injectionTokens: finalPlan.estimate?.injectionTokens,
        recallCount: finalPlan.recall?.length,
        summaryCount: finalPlan.chapters?.kept,
        savedRatio: finalPlan.estimate?.savedRatio,
        savedTokens: finalPlan.estimate?.savedTokens,
        result: finalPlan.result,
        decisionProvider: finalPlan.decisionProvider,
    });
    const label = finalPlan.result === 'degraded' ? '已降级' : '正常';
    setStatus(label, finalPlan.degraded
        ? `本轮已降级：${(finalPlan.degradeReasons ?? []).join('；') || '预算裁剪'}（节省 ${finalPlan.estimate?.savedTokens ?? 0} tokens）`
        : `本轮正常（注入 ${finalPlan.estimate?.injectionTokens ?? 0} tokens，节省 ${finalPlan.estimate?.savedTokens ?? 0}）`);
}

function applyPlan(chat, plan) {
    let lastUserIndex = -1;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (chat[i]?.is_user) { lastUserIndex = i; break; }
    }

    // 0) 截断替换：只替换发送副本（浅拷贝），绝不修改 SillyTavern 原始消息对象
    for (const rep of plan.replacements ?? []) {
        const i = rep.floorIndex;
        if (!Number.isInteger(i) || !chat[i] || i === lastUserIndex || chat[i].is_system) continue;
        chat[i] = { ...chat[i], mes: rep.text, extra: { ...(chat[i].extra ?? {}), dacongmingTruncated: true } };
    }

    // 1) 移除被压缩/丢弃的消息（保护最后一条用户消息与系统消息）
    const dropFloors = new Set((plan.drop ?? []).map((d) => d.floorIndex));
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        if (i === lastUserIndex) continue;
        if (chat[i]?.is_system) continue;
        if (dropFloors.has(i)) chat.splice(i, 1);
    }

    // 2) 注入记忆块（作为系统消息，放在最后一条用户消息之前）
    const injectionText = (plan.injections ?? []).map((b) => b.text).filter(Boolean).join('\n\n');
    if (injectionText) {
        let insertAt = chat.length;
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            if (chat[i]?.is_user) { insertAt = i; break; }
        }
        chat.splice(insertAt, 0, {
            name: '大聪明',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: injectionText,
            extra: { dacongming: true, planId: plan.planId },
        });
    }
}

async function measureChat(chat, blocks, ctx) {
    const parts = [];
    for (const m of chat) parts.push(String(m?.mes ?? ''));
    for (const b of blocks ?? []) parts.push(b.text);
    const text = parts.join('\n');
    let tokens = null;
    try {
        if (typeof ctx.getTokenCountAsync === 'function') tokens = await ctx.getTokenCountAsync(text);
    } catch { /* fallthrough */ }
    if (!Number.isFinite(tokens)) tokens = heuristicTokens(text);
    return Math.round(tokens + chat.length * 4);
}

function heuristicTokens(text) {
    let cjk = 0;
    let other = 0;
    for (const ch of String(text ?? '')) {
        if (/[㐀-䶿一-鿿豈-﫿]/.test(ch)) cjk += 1;
        else other += 1;
    }
    return Math.ceil(cjk * 1.5 + other / 4);
}

function lastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].isUser) return messages[i].content;
    }
    return messages.length ? messages[messages.length - 1].content : '';
}

// ============================================================
// ST 事件
// ============================================================

function wireEvents() {
    const ctx = getContext();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types ?? {};
    if (!eventSource?.on) {
        console.warn('[大聪明] 无法访问事件系统，仅手动模式可用');
        return;
    }
    const on = (name, fallback, handler) => {
        const type = eventTypes[name] ?? fallback;
        if (type) eventSource.on(type, handler);
    };

    on('CHAT_CHANGED', 'chat_changed', async () => {
        state.lastPlan = null;
        renderRoundSummary(state.ui?.refs, null);
        await reportProbe(true);
        scheduleIngest({ full: true });
    });
    on('MESSAGE_SENT', 'message_sent', () => scheduleIngest({ full: false }));
    on('MESSAGE_RECEIVED', 'message_received', () => scheduleIngest({ full: false }));
    on('MESSAGE_EDITED', 'message_edited', () => scheduleIngest({ full: false }));
    on('MESSAGE_SWIPED', 'message_swiped', () => scheduleIngest({ full: false }));
    on('MESSAGE_DELETED', 'message_deleted', () => scheduleIngest({ full: true }));

    // 聊天被删除 → 自动清理该聊天的记忆副本（事实/摘要/计划/快照/事件）。
    // ST 的 CHAT_DELETED 回调参数是被删聊天的文件名；存储的 chatId 可能带/不带 .jsonl
    // 后缀（取决于建库时的元数据），两种形式各清理一次，未命中的形式清理 0 条、无副作用。
    on('CHAT_DELETED', 'chat_deleted', async (chatFile) => {
        if (!state.connected || typeof chatFile !== 'string' || !chatFile) return;
        const base = chatFile.replace(/\.jsonl$/i, '');
        const targets = [...new Set([chatFile, base])].filter(Boolean);
        let cleaned = 0;
        for (const chatId of targets) {
            try {
                const r = await bridge.purge({ chatId, confirm: 'DELETE' });
                cleaned += (r?.memories ?? 0) + (r?.events ?? 0);
            } catch { /* 该形式无匹配数据时忽略 */ }
        }
        if (cleaned > 0) toast(`已同步清理已删除聊天的记忆（${cleaned} 条记录）`, 'info');
    });
    on('GENERATION_ENDED', 'generation_ended', async () => {
        if (state.lastPlan && state.connected) {
            bridge.feedback(state.lastPlan.planId, { accepted: true }).catch(() => {});
        }
    });
}

// ============================================================
// 记忆中心
// ============================================================

function openCenter(tab) {
    if (!state.center) return;
    state.center.overlay.style.display = 'flex';
    const target = tab ?? state.center.refs.activeTab();
    state.center.refs.activate(target);
}

function closeCenter() {
    if (state.center) state.center.overlay.style.display = 'none';
}

async function loadTab(name) {
    // 模态与内嵌抽屉是同一组件的两个实例：切换标签时两份内容都刷新，保持一致
    const centers = [state.center, state.centerInline].filter((c) => c?.refs);
    if (!centers.length) return;
    await Promise.all(centers.map((c) => loadCenterTab(name, c)));
}

async function loadCenterTab(name, center) {
    const pane = center.refs.content[name];
    if (!pane) return;
    pane.innerHTML = '';
    pane.append(el('div', { class: 'dcm-entry-sub', text: '加载中……' }));
    try {
        if (name === '记忆列表') return await renderMemoryList(pane);
        if (name === '本轮计划') return await renderPlanPane(pane);
        if (name === '快照与恢复') return await renderSnapshots(pane);
        if (name === '记忆体检') return await renderHealth(pane);
        if (name === '迁移导入') return await renderMigrate(pane);
        if (name === '诊断') return await renderDiagnostics(pane);
        if (name === '记忆库') return await renderScopeLibrary(pane);
    } catch (err) {
        pane.innerHTML = '';
        pane.append(el('div', { class: 'dcm-entry-sub dcm-danger-text', text: `加载失败：${err.message}` }));
    }
}

async function renderMemoryList(pane) {
    const ctx = getContext();
    const chatId = resolveChatId(ctx);
    const scope = scopeFor(chatId, resolveBranchId(ctx));
    pane.innerHTML = '';
    const filterRow = el('div', { class: 'dcm-filter-row' });
    const search = el('input', { class: 'text_pole', placeholder: '搜索记忆内容…' });
    const statusSel = el('select', {}, [
        el('option', { value: '' }, ['全部状态']),
        ...['candidate', 'observed', 'confirmed', 'active', 'conflict', 'superseded', 'expired', 'archived']
            .map((s) => el('option', { value: s }, [s])),
    ]);
    const scopeSel = el('select', {}, [
        el('option', { value: scope }, ['本聊天']),
        el('option', { value: '' }, ['全部作用域']),
    ]);
    const kindSel = el('select', {}, [
        el('option', { value: '' }, ['全部类型']),
        ...KIND_FILTERS.map(([value, label]) => el('option', { value }, [label])),
    ]);
    const timeSel = el('select', {}, [
        el('option', { value: '' }, ['全部时间']),
        el('option', { value: '1' }, ['近 24 小时']),
        el('option', { value: '7' }, ['近 7 天']),
        el('option', { value: '30' }, ['近 30 天']),
    ]);
    // 楼层范围与角色（D12）：记忆记录带来源楼层与说话人
    const floorFrom = el('input', { type: 'number', min: '0', class: 'text_pole dcm-num', placeholder: '楼层 ≥' });
    const floorTo = el('input', { type: 'number', min: '0', class: 'text_pole dcm-num', placeholder: '楼层 ≤' });
    const speakerInput = el('input', { class: 'text_pole', placeholder: '角色/说话人' });
    const reload = async () => {
        const listBox = pane.querySelector('.dcm-memory-list');
        listBox.innerHTML = '';
        listBox.append(el('div', { class: 'dcm-entry-sub', text: '加载中……' }));
        try {
            const days = Number(timeSel.value || 0);
            const result = await bridge.memories({
                scope: scopeSel.value || undefined,
                status: statusSel.value || undefined,
                kind: kindSel.value || undefined,
                createdAfter: days ? new Date(Date.now() - days * 86400000).toISOString() : undefined,
                floorFrom: floorFrom.value === '' ? undefined : Number(floorFrom.value),
                floorTo: floorTo.value === '' ? undefined : Number(floorTo.value),
                speaker: speakerInput.value.trim() || undefined,
                search: search.value || undefined,
                includeInvalidated: '1',
                limit: 300,
            });
            listBox.innerHTML = '';
            if (!result.items?.length) {
                if (result.total > 0) {
                    // 库里其实有记忆，只是被筛选条件挡掉了
                    listBox.append(emptyState(
                        '没有符合当前筛选条件的记忆。',
                        '清除筛选',
                        () => {
                            search.value = '';
                            scopeSel.value = scope;
                            kindSel.value = '';
                            statusSel.value = '';
                            timeSel.value = '';
                            floorFrom.value = '';
                            floorTo.value = '';
                            speakerInput.value = '';
                            reload();
                        },
                    ));
                } else if (settings.enabled) {
                    // 已开启：不再重复显示「打开自动管理」，避免看起来像没生效
                    listBox.append(emptyState(
                        '已开启「自动管理」，这个聊天还没有产生记忆。继续对话几轮，系统会自动抽取事实与章节摘要；也可以手动新增一条。',
                        '手动添加记忆',
                        () => openAddDialog(reload),
                    ));
                } else {
                    listBox.append(emptyState(
                        '这个聊天还没有记忆。开启「自动管理」后聊几轮，系统会自动抽取事实与章节摘要；也可以在下方手动新增一条。',
                        '打开自动管理',
                        async () => {
                            const on = await setAutoManage(true);
                            if (on) reload();
                        },
                    ));
                }
                return;
            }
            listBox.append(el('div', { class: 'dcm-entry-sub', text: `共 ${result.total} 条` }));
            for (const record of result.items) {
                listBox.append(memoryCard(record, memoryHandlers(reload)));
            }
        } catch (err) {
            listBox.innerHTML = '';
            listBox.append(el('div', { class: 'dcm-entry-sub dcm-danger-text', text: `加载失败：${err.message}` }));
        }
    };
    search.addEventListener('input', debounce(reload, 400));
    statusSel.addEventListener('change', reload);
    scopeSel.addEventListener('change', reload);
    kindSel.addEventListener('change', reload);
    timeSel.addEventListener('change', reload);
    floorFrom.addEventListener('input', debounce(reload, 400));
    floorTo.addEventListener('input', debounce(reload, 400));
    speakerInput.addEventListener('input', debounce(reload, 400));
    filterRow.append(search, scopeSel, kindSel, statusSel, timeSel, floorFrom, floorTo, speakerInput);
    const addBtn = el('button', { class: 'menu_button', text: '手动添加记忆' });
    addBtn.addEventListener('click', () => openAddDialog(reload, filterRow));
    filterRow.append(addBtn);
    pane.append(filterRow, el('div', { class: 'dcm-memory-list' }));
    await reload();
}

/** 手动新增一条长期记忆（行内表单，替代原生 prompt）。 */
async function openAddDialog(reload, anchorEl) {
    if (!anchorEl || anchorEl.querySelector('.dcm-inline-editor')) return;
    const editor = el('div', { class: 'dcm-inline-editor' }, [
        el('div', { class: 'dcm-entry-sub', text: '输入要长期记住的内容（将以最高优先级保存并固定）：' }),
        el('textarea', { class: 'text_pole', rows: '3' }),
        el('div', { class: 'dcm-btn-row' }, [
            el('button', { class: 'menu_button', text: '保存' }),
            el('button', { class: 'menu_button', text: '取消' }),
        ]),
    ]);
    const [saveBtn, cancelBtn] = editor.querySelectorAll('button');
    const ta = editor.querySelector('textarea');
    anchorEl.after(editor);
    cancelBtn.addEventListener('click', () => editor.remove());
    saveBtn.addEventListener('click', async () => {
        const content = ta.value.trim();
        if (!content) { editor.remove(); return; }
        const ctx = getContext();
        const chatId = resolveChatId(ctx);
        const scope = scopeFor(chatId, resolveBranchId(ctx));
        try {
            await bridge.createMemory({ scope, chatId, content, kind: 'anchor' });
            toast('已保存', 'success');
            editor.remove();
            reload?.();
        } catch (err) { toast(`保存失败：${err.message}`, 'error'); }
    });
    ta.focus();
}

function memoryHandlers(reload) {
    return {
        onLock: async (record, locked) => {
            try { await bridge.memoryAction(record.id, { action: 'lock', locked }); reload(); } catch (err) { toast(err.message, 'error'); }
        },
        onCorrect: async (record, card) => {
            // 行内编辑器（替代原生 prompt）：展开在卡片操作按钮上方
            if (card.querySelector('.dcm-inline-editor')) return;
            const editor = el('div', { class: 'dcm-inline-editor' }, [
                el('div', { class: 'dcm-entry-sub', text: '纠正为正确内容（保存后旧版本立即失效）：' }),
                el('textarea', { class: 'text_pole', rows: '4' }, [record.content]),
                el('div', { class: 'dcm-btn-row' }, [
                    el('button', { class: 'menu_button', text: '保存纠正' }),
                    el('button', { class: 'menu_button', text: '取消' }),
                ]),
            ]);
            const [saveBtn, cancelBtn] = editor.querySelectorAll('button');
            const ta = editor.querySelector('textarea');
            card.querySelector('.dcm-memory-actions').before(editor);
            cancelBtn.addEventListener('click', () => editor.remove());
            saveBtn.addEventListener('click', async () => {
                const content = ta.value.trim();
                if (!content || content === record.content) { editor.remove(); return; }
                try {
                    await bridge.memoryAction(record.id, { action: 'correct', content });
                    toast('已纠正，旧版本已失效', 'success');
                    editor.remove();
                    reload();
                } catch (err) { toast(err.message, 'error'); }
            });
            ta.focus();
        },
        onForget: async (record) => {
            if (!confirm('“不再记忆”会建立持久阻断标记，重扫历史也不会复活。继续？')) return;
            try { await bridge.forgetMemory(record.id); toast('已遗忘并建立阻断标记', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
        },
        onSources: (record, card) => {
            // 行内展开来源信息（替代原生 alert）
            if (card.querySelector('.dcm-sources-box')) { card.querySelector('.dcm-sources-box').remove(); return; }
            const ids = record.sourceMessageIds ?? [];
            const box = el('details', { class: 'dcm-sources-box' }, [
                el('summary', { text: `来源消息 ${ids.length} 条 · 生成方式 ${record.derivation?.method ?? '-'}（v${record.derivation?.version ?? '-'}） · 创建于 ${record.createdAt}` }),
                el('div', { class: 'dcm-raw' }, [el('pre', { class: 'dcm-json', text: ids.slice(0, 20).join('\n') || '（无来源消息）' })]),
            ]);
            card.querySelector('.dcm-memory-actions').before(box);
        },
        onRestore: async (record) => {
            try { await bridge.restoreMemory(record.id); toast('已恢复', 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
        },
    };
}

const KIND_NAMES = {
    anchors: '核心设定（固定锚点）',
    recall: '相关记忆（本轮召回）',
    summaries: '章节摘要',
};
const RESULT_NAMES = { ok: '正常', degraded: '已降级（做了压缩）', blocked: '已阻止发送' };
const INTENT_NAMES = {
    roleplay: '角色扮演', question: '提问', summary: '总结', combat: '战斗',
    status: '状态查询', travel: '移动', smalltalk: '闲聊',
};
const KIND_FILTERS = [
    ['fact', '事实'], ['entity', '实体'], ['relation', '关系'], ['anchor', '锚点'],
    ['preference', '偏好'], ['summary_chapter', '章节摘要'], ['summary_rolling', '滚动摘要'],
    ['goal', '目标'], ['timeline', '时间线'], ['scene', '场景'],
    ['tool_result', '工具结论'], ['attachment', '附件'],
];

/** 结构化展示一份计划（真实计划与「仅预览」共用）。 */
function renderPlanDetail(container, plan) {
    const est = plan.estimate ?? {};
    const budget = plan.budget ?? {};
    const decision = plan.decision ?? {};

    // 1) 概览
    container.append(sectionTitle('本轮概览'));
    container.append(el('div', { class: 'dcm-summary' }, [
        kvRow('计划结果', RESULT_NAMES[plan.result] ?? plan.result ?? '-'),
        kvRow('压缩比例', `${Math.round((est.savedRatio ?? 0) * 100)}%（节省 ${est.savedTokens ?? 0} tokens）`),
        kvRow('注入内容', `${est.injectionTokens ?? 0} tokens`),
        kvRow('token', `${est.baselineTokens ?? 0} → ${est.finalTokens ?? 0}（可用 ${budget.availableInput ?? '-'}，档位 ${budget.tierName ?? '-'}）`),
        kvRow('决策', `${INTENT_NAMES[decision.intent] ?? decision.intent ?? '-'} · 压缩强度 ${decision.compressionLevel ?? '-'} · 来源 ${plan.decisionProvider ?? '-'}`),
        kvRow('token 口径', plan.tokenAccuracy === 'measured-by-st' ? 'SillyTavern 实测' : '保守估算'),
        // 旧版本持久化的计划没有这两个标志，宁可不显示也不要给出错误结论
        (typeof plan.triggered === 'boolean' || typeof plan.hardExceeded === 'boolean') ? kvRow('触发原因', plan.hardExceeded
            ? `越过硬预算上限（${budget.availableInput ?? '-'} tokens），已尽力降级`
            : (plan.triggered
                ? `达到${budget.tierName ?? '目标'}档位触发线（${budget.triggerAt ?? '-'} tokens），开始轻量压缩`
                : `未达触发线（${budget.triggerAt ?? '-'} tokens），无需压缩`)) : null,
        kvRow('耗时', `${plan.elapsedMs ?? '-'} ms`),
    ]));

    // 2) 为什么这样做
    const reasons = [
        decision.reason ? ['决策原因', decision.reason] : null,
        ...(plan.degradeReasons ?? []).map((r) => ['降级动作', r]),
        plan.blockReason ? ['阻止原因', plan.blockReason] : null,
        plan.fixActions?.length ? ['建议', plan.fixActions.join('；')] : null,
    ].filter(Boolean);
    if (reasons.length) {
        container.append(sectionTitle('为什么这样做'));
        container.append(el('div', { class: 'dcm-summary' }, reasons.map(([k, v]) => kvRow(k, v))));
    }

    // 3) 注入内容（原文/摘要/事实/召回的最终形态）
    const injections = plan.injections ?? [];
    if (injections.length) {
        container.append(sectionTitle(`注入内容（${injections.length} 块 · ${est.injectionTokens ?? 0} tokens）`));
        for (const block of injections) {
            const d = drawer({ title: KIND_NAMES[block.kind] ?? block.kind, hint: `${block.tokens ?? 0} tokens` });
            if (block.reason) d.content.append(el('div', { class: 'dcm-field-hint', text: block.reason }));
            d.content.append(el('pre', { class: 'dcm-json dcm-json-sm', text: block.text ?? '' }));
            container.append(d.root);
        }
    } else {
        container.append(sectionTitle('注入内容'));
        container.append(el('div', { class: 'dcm-field-hint', text: '本轮没有注入任何记忆或摘要（上下文还很短，或没有命中召回）。' }));
    }

    // 4) 消息处理清单
    const retained = plan.retain?.floors ?? [];
    const drop = plan.drop ?? [];
    const reps = plan.replacements ?? [];
    container.append(sectionTitle('消息处理'));
    container.append(el('div', { class: 'dcm-summary' }, [
        kvRow('保留原文', retained.length ? `${retained.length} 条（楼层 ${retained.slice(0, 12).join(', ')}${retained.length > 12 ? ' …' : ''}）` : '0 条'),
        kvRow('压缩为摘要', reps.length ? `${reps.length} 条` : '0 条'),
        kvRow('丢弃', drop.length ? `${drop.length} 条` : '0 条'),
    ]));
    const rows = [
        ...drop.map((d) => ({ kind: '丢弃', floor: d.floorIndex, reason: d.reason })),
        ...reps.map((r) => ({ kind: '压缩', floor: r.floorIndex, reason: r.reason })),
    ];
    if (rows.length) {
        const list = el('div', { class: 'dcm-list' });
        for (const row of rows.slice(0, 40)) {
            list.append(el('div', { class: 'dcm-list-row' }, [
                el('span', { class: `dcm-tag ${row.kind === '丢弃' ? 'dcm-tag-warn' : ''}`, text: row.kind }),
                el('span', { class: 'dcm-list-floor', text: `#${row.floor}` }),
                el('span', { class: 'dcm-list-reason', text: row.reason ?? '' }),
            ]));
        }
        if (rows.length > 40) list.append(el('div', { class: 'dcm-field-hint', text: `…另有 ${rows.length - 40} 条` }));
        container.append(list);
    }

    // 5) 召回来源
    const recall = plan.recall ?? [];
    if (recall.length) {
        container.append(sectionTitle(`召回来源（${recall.length} 条）`));
        const list = el('div', { class: 'dcm-list' });
        for (const item of recall) {
            list.append(el('div', { class: 'dcm-list-row' }, [
                el('span', { class: 'dcm-tag', text: item.kind ?? '记忆' }),
                el('span', { class: 'dcm-list-floor', text: `分数 ${Number(item.score ?? 0).toFixed(2)}` }),
                el('span', { class: 'dcm-list-reason', text: [item.status, item.reason].filter(Boolean).join(' · ') }),
            ]));
        }
        container.append(list);
    }

    // 6) 原始 JSON（排查用，默认收起）
    const raw = drawer({ title: '原始 JSON（排查用）' });
    raw.content.append(el('pre', { class: 'dcm-json', text: JSON.stringify(plan, null, 2).slice(0, 20000) }));
    container.append(raw.root);
}

/** 仅预览：只读，不发送、不改聊天、不写记忆。 */
async function previewPlan(pane) {
    const ctx = getContext();
    const body = pane.querySelector('.dcm-plan-body');
    body.innerHTML = '';
    body.append(el('div', { class: 'dcm-entry-sub', text: '正在规划（只读预览）……' }));
    try {
        await ingestNow({ full: false, silent: true });
        const plan = await bridge.preview(buildPlanRequest(ctx, { preview: true }));
        body.innerHTML = '';
        body.append(el('div', { class: 'dcm-field-hint', text: '这是「如果现在发送一条消息」的只读预演：不会修改聊天，也不会写入记忆。' }));
        renderPlanDetail(body, plan);
    } catch (err) {
        body.innerHTML = '';
        body.append(el('div', { class: 'dcm-entry-sub dcm-danger-text', text: `预览失败：${err.message}` }));
    }
}

async function renderPlanPane(pane) {
    pane.innerHTML = '';
    const ctx = getContext();

    const previewBtn = el('button', { class: 'menu_button', text: '仅预览（只读）' });
    previewBtn.addEventListener('click', () => previewPlan(pane));
    const undoBtn = el('button', { class: 'menu_button dcm-danger', text: '撤销本次压缩（恢复上一快照）' });
    undoBtn.addEventListener('click', async () => {
        const plan = state.lastPlan;
        if (!plan?.snapshotId) return toast('该计划没有快照可恢复', 'warn');
        if (!confirm('恢复上一快照将回滚这次压缩产生的记忆状态。继续？')) return;
        try {
            await bridge.restoreSnapshot(plan.snapshotId);
            toast('已恢复上一快照', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    pane.append(el('div', { class: 'dcm-btn-row' }, [previewBtn, undoBtn]));

    const body = el('div', { class: 'dcm-plan-body' });
    pane.append(body);

    let plan = state.lastPlan;
    if (!plan) {
        try {
            const latest = await bridge.latestPlan(resolveChatId(ctx));
            plan = latest?.plan ?? null;
        } catch { /* 历史计划取不到就用空态 */ }
    }
    if (!plan) {
        body.append(emptyState(
            '还没有本轮计划。发送一条消息后这里会显示本轮为什么保留/压缩/召回了什么；也可以点上方「仅预览（只读）」看现在会怎么处理。',
        ));
        return;
    }
    renderPlanDetail(body, plan);
}

async function renderSnapshots(pane) {
    pane.innerHTML = '';
    const ctx = getContext();
    const chatId = resolveChatId(ctx);
    const branchId = resolveBranchId(ctx);
    const scope = scopeFor(chatId, branchId);

    const createBtn = el('button', { class: 'menu_button dcm-primary', text: '立即创建快照' });
    createBtn.addEventListener('click', async () => {
        createBtn.disabled = true;
        try {
            await bridge.createSnapshot({ scope, chatId, branchId, label: '手动快照' });
            toast('已创建快照', 'success');
            loadTab('快照与恢复');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            createBtn.disabled = false;
        }
    });
    const rebuildBtn = el('button', { class: 'menu_button', text: '重建索引' });
    rebuildBtn.addEventListener('click', async () => {
        try { await bridge.rebuildIndex(); toast('索引已重建', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    pane.append(el('div', { class: 'dcm-btn-row' }, [createBtn, rebuildBtn]));
    pane.append(el('div', { class: 'dcm-field-hint', text: '快照记录的是「记忆状态」，可随时回滚；压缩发生时也会自动创建快照。' }));

    const result = await bridge.snapshots(scope);
    if (!result.items?.length) {
        pane.append(emptyState('暂无快照。点上方「立即创建快照」手动固化当前记忆状态，或在发生压缩后自动生成。'));
        return;
    }
    pane.append(sectionTitle(`共 ${result.items.length} 个快照`));
    for (const snap of result.items) {
        const row = el('div', { class: 'dcm-memory-card' }, [
            el('div', { class: 'dcm-memory-head' }, [
                el('span', { class: 'dcm-badge', text: snap.label }),
                el('span', { class: 'dcm-badge', text: snap.auto ? '自动' : '手动' }),
            ]),
            el('div', { class: 'dcm-memory-meta', text: `${snap.createdAt} · ${snap.memoryState?.length ?? 0} 条记忆状态 · ${snap.reason ?? ''}` }),
        ]);
        const btn = el('button', { class: 'menu_button', text: '恢复此快照' });
        btn.addEventListener('click', async () => {
            if (!confirm(`恢复到 ${snap.createdAt} 的状态？`)) return;
            try {
                const r = await bridge.restoreSnapshot(snap.id);
                toast(`已恢复：回滚 ${r.restored} 条，归档 ${r.archived} 条`, 'success');
                loadTab('快照与恢复');
            } catch (err) {
                toast(err.message, 'error');
            }
        });
        row.append(btn);
        pane.append(row);
    }
}

async function renderHealth(pane) {
    pane.innerHTML = '';
    const ctx = getContext();
    const scope = scopeFor(resolveChatId(ctx), resolveBranchId(ctx));
    const report = await bridge.healthCheck(scope);
    pane.append(el('div', { class: 'dcm-entry-sub', text: `记忆 ${report.summary.totalMemories} 条，问题 ${report.summary.issues} 个（高 ${report.summary.bySeverity.high} / 中 ${report.summary.bySeverity.medium} / 低 ${report.summary.bySeverity.low}）` }));
    for (const issue of report.issues) {
        const row = el('div', { class: 'dcm-memory-card' }, [
            el('div', { class: 'dcm-memory-head' }, [
                el('span', { class: 'dcm-badge', text: issue.type }),
                el('span', { class: 'dcm-badge', text: issue.severity }),
            ]),
            el('div', { class: 'dcm-memory-content', text: issue.detail }),
            el('div', { class: 'dcm-memory-meta', text: issue.fixHint ?? '' }),
        ]);
        if (issue.fix && issue.fix !== 'manual-review') {
            const btn = el('button', { class: 'menu_button dcm-mini', text: '一键修复' });
            btn.addEventListener('click', async () => {
                try {
                    await bridge.healthFix(issue.fix, issue.ids);
                    toast('已修复', 'success');
                    loadTab('记忆体检');
                } catch (err) {
                    toast(err.message, 'error');
                }
            });
            row.append(btn);
        }
        pane.append(row);
    }
    const rebuild = el('button', { class: 'menu_button', text: '重建索引' });
    rebuild.addEventListener('click', async () => {
        try { await bridge.rebuildIndex(); toast('索引已重建', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
    pane.append(rebuild);
}

async function renderMigrate(pane) {
    pane.innerHTML = '';
    const ctx = getContext();
    const scope = scopeFor(resolveChatId(ctx), resolveBranchId(ctx));
    pane.append(el('div', { class: 'dcm-entry-sub', text: '支持 Horae / 柏宝书 / shujuku / Anima RAG / 手写总结 / 通用 JSON。流程：只读扫描 → 预览 → 试运行 → 导入 → 可回滚。' }));
    const fileInput = el('input', { type: 'file', accept: '.json,.txt', class: 'dcm-file' });
    const sourceSel = el('select', {}, [
        el('option', { value: '' }, ['自动识别']),
        el('option', { value: 'horae' }, ['Horae']),
        el('option', { value: 'baibaibook' }, ['柏宝书']),
        el('option', { value: 'shujuku' }, ['shujuku']),
        el('option', { value: 'anima' }, ['Anima RAG']),
        el('option', { value: 'manual' }, ['手写总结']),
        el('option', { value: 'generic' }, ['通用 JSON']),
    ]);
    const resultBox = el('div', { class: 'dcm-migrate-result' });
    const scanBtn = el('button', { class: 'menu_button', text: '扫描并预览' });
    let scanned = null;
    scanBtn.addEventListener('click', async () => {
        const file = fileInput.files?.[0];
        if (!file) return toast('请选择文件', 'warn');
        const text = await file.text();
        try {
            scanned = JSON.parse(text);
        } catch (err) {
            return toast(`JSON 解析失败：${err.message}`, 'error');
        }
        try {
            const result = await bridge.migrateScan(scanned, sourceSel.value || undefined, scope);
            resultBox.innerHTML = '';
            resultBox.append(el('div', { class: 'dcm-summary' }, [
                kvRow('识别格式', result.formatInfo?.label ?? result.format ?? '未识别'),
                kvRow('扫描到', `${result.dedupe?.total ?? result.stats?.total ?? 0} 条`),
                kvRow('可新增', `${result.dedupe?.newCount ?? 0} 条`),
                kvRow('内容重复', `${result.dedupe?.duplicateCount ?? 0} 条`),
                kvRow('已导入过', `${result.dedupe?.alreadyImportedCount ?? 0} 条`),
                kvRow('忽略条目', `${result.skipped?.length ?? 0} 条`),
            ]));
            resultBox.append(rawJson({ format: result.format, stats: result.stats, dedupe: result.dedupe, skipped: result.skipped }, '扫描原始数据'));
            const dryBtn = el('button', { class: 'menu_button', text: '试运行' });
            dryBtn.addEventListener('click', async () => {
                const r = await bridge.migrateApply(scanned, { source: sourceSel.value || undefined, scope, chatId: resolveChatId(ctx), dryRun: true });
                resultBox.append(el('div', { class: 'dcm-field-hint', text: `试运行：将导入 ${r.result.preview?.length ?? 0} 条（示例）` }));
            });
            const applyBtn = el('button', { class: 'menu_button dcm-primary', text: '正式导入' });
            applyBtn.addEventListener('click', async () => {
                applyBtn.disabled = true;
                try {
                    const r = await bridge.migrateApply(scanned, { source: sourceSel.value || undefined, scope, chatId: resolveChatId(ctx) });
                    const batchId = r.result?.batchId ?? null;
                    toast(`导入完成：新增 ${r.result.imported}，跳过重复 ${r.result.skippedDuplicate}`, 'success');
                    resultBox.append(el('div', { class: 'dcm-summary' }, [
                        kvRow('导入批次', batchId ?? '—'),
                        kvRow('新增', `${r.result.imported} 条`),
                        kvRow('跳过重复', `${r.result.skippedDuplicate} 条`),
                    ]));
                    if (batchId) {
                        const undo = el('button', { class: 'menu_button dcm-danger', text: '回滚本次导入' });
                        undo.addEventListener('click', async () => {
                            if (!confirm(`回滚本次导入（批次 ${batchId}）？将移除本次导入产生的记忆，原有记忆不受影响。`)) return;
                            try {
                                const rb = await bridge.migrateRollback(batchId);
                                toast(`已回滚：移除 ${rb.removed} 条`, 'success');
                                undo.disabled = true;
                                undo.textContent = `已回滚（移除 ${rb.removed} 条）`;
                            } catch (err) {
                                toast(err.message, 'error');
                            }
                        });
                        resultBox.append(undo);
                    }
                } catch (err) {
                    toast(`导入失败：${err.message}`, 'error');
                } finally {
                    applyBtn.disabled = false;
                }
            });
            resultBox.append(el('div', { class: 'dcm-btn-row' }, [dryBtn, applyBtn]));
        } catch (err) {
            toast(`扫描失败：${err.message}`, 'error');
        }
    });
    pane.append(el('div', { class: 'dcm-btn-row' }, [fileInput, sourceSel, scanBtn]), resultBox);

    const exportBtn = el('button', { class: 'menu_button', text: '导出本聊天记忆（JSON）' });
    exportBtn.addEventListener('click', async () => {
        try {
            const data = await bridge.exportData(scope);
            const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `dacongming-export-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            toast('已导出', 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    const importBtn = el('button', { class: 'menu_button', text: '导入大聪明导出文件' });
    const importInput = el('input', { type: 'file', accept: '.json' });
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        if (!file) return;
        try {
            const payload = JSON.parse(await file.text());
            const preview = await bridge.importPreview(payload);
            if (!confirm(`导入预览：新增 ${preview.preview.counts.fresh} 条，重复跳过 ${preview.preview.counts.duplicate} 条。继续？`)) return;
            const r = await bridge.importApply(payload);
            toast(`导入完成：新增 ${r.result.memories}，跳过 ${r.result.skipped}`, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    const purgeBtn = el('button', { class: 'menu_button dcm-danger', text: '彻底删除插件副本（本聊天）' });
    purgeBtn.addEventListener('click', async () => {
        if (!confirm('彻底删除会清理插件保存的原文副本、摘要、事实、索引、缓存和任务结果（不影响 SillyTavern 原始聊天）。继续？')) return;
        if (!confirm('再次确认：此操作不可恢复（除备份外）。')) return;
        try {
            const r = await bridge.purge({ scope, confirm: 'DELETE' });
            toast(`已彻底删除：记忆 ${r.memories}，事件 ${r.events}（epoch ${r.epoch}）`, 'success');
        } catch (err) {
            toast(err.message, 'error');
        }
    });
    pane.append(el('div', { class: 'dcm-btn-row' }, [exportBtn, importBtn, purgeBtn]), importInput);
}

const CONNECT_MODE_NAMES = {
    plugin: '内嵌服务端插件（无窗口）',
    bridge: '同源桥接',
    direct: '直连 loopback',
    unpaired: '独立服务（未配对）',
    offline: '未连接',
};
const TASK_STATUS_NAMES = {
    queued: '排队中', running: '执行中', done: '已完成',
    failed: '失败', cancelled: '已取消',
};

function formatBytes(n) {
    if (!Number.isFinite(n)) return '-';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

/** 记忆库：按聊天作用域列出全部记忆库，支持重命名 / 删除 / 查看占用。 */
async function renderScopeLibrary(pane) {
    pane.innerHTML = '';
    pane.append(el('div', { class: 'dcm-entry-sub', text: '加载中……' }));
    const res = await bridge.listScopes();
    const scopes = res?.scopes ?? [];
    const current = resolveChatId(getContext());
    pane.innerHTML = '';

    pane.append(el('div', { class: 'dcm-entry-sub', text:
        `共 ${scopes.length} 个记忆库。删除聊天会自动清理对应记忆库；这里可手动重命名或清理多周目残留。` }));

    if (!scopes.length) {
        pane.append(emptyState('还没有任何记忆库。开启自动管理并聊天后，这里会按聊天列出记忆。'));
        return;
    }

    const list = el('div', { class: 'dcm-memory-list' });
    for (const s of scopes) {
        const isCurrent = s.chatId === current || s.scope === `chat:${current}`;
        const card = el('div', { class: 'dcm-memory-card' });
        const title = el('div', { class: 'dcm-memory-head' }, [
            el('span', { class: 'dcm-badge', text: isCurrent ? '当前聊天' : (s.orphan ? '残留副本' : '记忆库') }),
            el('span', { class: 'dcm-memory-content', style: 'font-weight:600; flex:1;', text: s.name ?? s.chatId }),
        ]);
        const kindText = Object.entries(s.byKind ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ');
        card.append(title);
        card.append(el('div', { class: 'dcm-memory-meta', text:
            `记录 ${s.records} 条 · 占用 ${formatBytes(s.bytes)}${kindText ? ` · ${kindText}` : ''}${s.lastAt ? ` · 最后活动 ${s.lastAt.slice(0, 19).replace('T', ' ')}` : ''}` }));

        const actions = el('div', { class: 'dcm-memory-actions' });
        const renameBtn = el('button', { class: 'menu_button dcm-mini', text: s.name ? '重命名' : '命名' });
        renameBtn.addEventListener('click', () => {
            if (card.querySelector('.dcm-inline-editor')) return;
            const editor = el('div', { class: 'dcm-inline-editor' }, [
                el('div', { class: 'dcm-entry-sub', text: `为「${s.chatId}」起一个好记的名字（留空 = 恢复默认）：` }),
                el('input', { class: 'text_pole', value: s.name ?? '' }),
                el('div', { class: 'dcm-btn-row' }, [
                    el('button', { class: 'menu_button', text: '保存' }),
                    el('button', { class: 'menu_button', text: '取消' }),
                ]),
            ]);
            const [saveBtn, cancelBtn] = editor.querySelectorAll('button');
            const input = editor.querySelector('input');
            actions.before(editor);
            cancelBtn.addEventListener('click', () => editor.remove());
            saveBtn.addEventListener('click', async () => {
                try {
                    await bridge.renameScope(s.scope, input.value.trim());
                    toast('已重命名', 'success');
                    await renderScopeLibrary(pane);
                } catch (err) { toast(err.message, 'error'); }
            });
            input?.focus();
        });
        const deleteBtn = el('button', { class: 'menu_button dcm-mini dcm-danger', text: '删除此库' });
        deleteBtn.addEventListener('click', async () => {
            if (isCurrent) { toast('不能删除当前正在使用的聊天记忆库', 'warning'); return; }
            if (card.querySelector('.dcm-inline-editor')) return;
            const editor = el('div', { class: 'dcm-inline-editor' }, [
                el('div', { class: 'dcm-entry-sub dcm-danger-text', text:
                    `彻底删除「${s.name ?? s.chatId}」的全部 ${s.records} 条记录？此操作不可逆，不影响酒馆原始聊天。` }),
                el('label', { class: 'dcm-checkbox-row' }, [
                    el('input', { type: 'checkbox' }),
                    el('span', { class: 'dcm-toggle-note', text: '同时删除阻断标记（不推荐：若此聊天还在，被「不再记忆」的内容重新摄取时可能再次成为记忆）' }),
                ]),
                el('div', { class: 'dcm-btn-row' }, [
                    el('button', { class: 'menu_button dcm-danger', text: '确认删除' }),
                    el('button', { class: 'menu_button', text: '取消' }),
                ]),
            ]);
            const [delBtn, cancelBtn] = editor.querySelectorAll('button');
            const tombCheckbox = editor.querySelector('input[type=checkbox]');
            actions.before(editor);
            cancelBtn.addEventListener('click', () => editor.remove());
            delBtn.addEventListener('click', async () => {
                try {
                    const r = await bridge.deleteScope(s.scope, tombCheckbox.checked);
                    const extra = r?.tombstones ? ` / 阻断 ${r.tombstones}` : '';
                    toast(`已删除（记忆 ${r?.memories ?? 0} / 事件 ${r?.events ?? 0}${extra}）`, 'success');
                    await renderScopeLibrary(pane);
                } catch (err) { toast(err.message, 'error'); }
            });
        });
        actions.append(renameBtn, deleteBtn);
        card.append(actions);
        list.append(card);
    }
    pane.append(list);
}

async function renderDiagnostics(pane) {
    pane.innerHTML = '';
    const ctx = getContext();
    const chatId = resolveChatId(ctx);

    const [status, taskList, probe, updateInfo] = await Promise.all([
        bridge.status(),
        bridge.tasks(),
        bridge.probeInfo(chatId).catch(() => null),
        // 插件自更新状态（服务端插件 git 安装时才有意义）。
        // 放进 Promise.all 而非「发完就 append」：原来那种写法渲染位置取决于网速快慢，
        // 这一行会在面板顶部和底部之间乱跳。
        bridge.request('GET', '/api/plugin-update-info').catch(() => null),
    ]);
    const stats = status.stats ?? {};
    const byStatus = stats.memories?.byStatus ?? {};

    // 1) 服务概览
    pane.append(sectionTitle('服务'));
    const serviceRows = [
        kvRow('版本', `v${status.version ?? '?'}（schema ${stats.schemaVersion ?? '?'} / planner ${stats.plannerVersion ?? '?'}）`),
        kvRow('连接方式', CONNECT_MODE_NAMES[state.mode] ?? state.mode ?? '未连接'),
        kvRow('鉴权', status.security?.paired === false ? '未配对（内嵌模式由 SillyTavern 登录态鉴权）' : '已授权'),
        kvRow('存储', stats.store?.kind ?? '—'),
        kvRow('记忆', `${stats.memories?.total ?? 0} 条（可召回 ${(byStatus.observed ?? 0) + (byStatus.confirmed ?? 0) + (byStatus.active ?? 0)}）`),
        kvRow('观察期待晋升', `${byStatus.candidate ?? 0} 条`),
        kvRow('实体 / 快照 / 墓碑', `${stats.entities ?? 0} / ${stats.snapshots ?? 0} / ${stats.tombstones ?? 0}`),
    ];
    const update = updateInfo?.update;
    if (update) {
        serviceRows.push(kvRow('插件更新', update.available
            ? (update.updated
                ? '已自动更新到最新版 —— 重启酒馆后生效'
                : '远端有新版本，但本地历史已分叉：在 plugins/dacongming 目录执行 git fetch origin && git reset --hard origin/main 后重启酒馆')
            : '已是最新'));
    }
    pane.append(el('div', { class: 'dcm-summary' }, serviceRows));

    // 2) 压缩账本
    const plans = stats.plans ?? {};
    pane.append(sectionTitle('压缩账本（累计）'));
    pane.append(el('div', { class: 'dcm-summary' }, [
        kvRow('计划总数', `${plans.total ?? 0} 次（降级 ${plans.degraded ?? 0} · 阻止 ${plans.blocked ?? 0}）`),
        kvRow('原始 → 实际', `${plans.baselineTokens ?? 0} → ${plans.finalTokens ?? 0} tokens`),
        kvRow('累计节省', `${plans.savedTokens ?? 0} tokens（${Math.round((plans.savedRatio ?? 0) * 100)}%）`),
        kvRow('辅助开销', `Jev ${stats.auxiliary?.jev ?? 0} 次${stats.auxiliary?.jev ? '' : '（未启用）'}`),
    ]));

    // 3) 环境与兼容（探针）
    pane.append(sectionTitle('环境与兼容（自动探针）'));
    const eff = probe?.effective;
    if (!eff || !eff.at) {
        pane.append(el('div', { class: 'dcm-entry-sub', text: '尚未收到探针数据。发送一条消息后会自动采集（在收到之前，服务端按保守默认 4096 上下文 / 512 输出预留 估算）。' }));
    } else {
        const acc = eff.tokenAccuracy ?? {};
        const rate = acc.level === 'exact-available' ? '精确（SillyTavern tokenizer 实测）' : '保守估算';
        pane.append(el('div', { class: 'dcm-summary' }, [
            kvRow('模型', eff.model ?? '未识别'),
            kvRow('上下文上限', `${eff.contextLimit ?? '—'} tokens（输出预留 ${eff.outputReserve ?? 0}）`),
            kvRow('工具模式开销', `${eff.toolSchemaOverhead ?? 0} tokens`),
            kvRow('token 口径', rate),
            kvRow('探针来源', `${eff.source ?? '—'}${eff.stale ? '（已过期，建议重新探测）' : ''}`),
            kvRow('采集时间', eff.at ? String(eff.at).replace('T', ' ').slice(0, 19) : '—'),
        ]));
        const plugins = eff.installedPlugins ?? probe?.compat?.detected ?? [];
        pane.append(el('div', { class: 'dcm-field-hint', text: plugins.length
            ? `检测到兼容插件：${plugins.map((p) => (typeof p === 'string' ? p : p.name ?? p.id ?? JSON.stringify(p))).join('、')} —— 可在「迁移导入」里导入它们的记忆。`
            : '未检测到可迁移的兼容插件。' }));
    }

    // 4) 任务队列（可取消）
    const items = taskList.items ?? [];
    const active = items.filter((t) => ['queued', 'running'].includes(t.status));
    pane.append(sectionTitle(`任务队列（共 ${taskList.stats?.total ?? items.length}，进行中 ${active.length}）`));
    if (!items.length) {
        pane.append(el('div', { class: 'dcm-entry-sub', text: '暂无任务记录。' }));
    } else {
        for (const task of items.slice(0, 20)) {
            const row = el('div', { class: 'dcm-memory-card' }, [
                el('div', { class: 'dcm-memory-head' }, [
                    el('span', { class: 'dcm-badge', text: task.kind ?? task.type ?? 'task' }),
                    el('span', { class: 'dcm-badge', text: TASK_STATUS_NAMES[task.status] ?? task.status }),
                ]),
                el('div', { class: 'dcm-memory-meta', text: `${String(task.createdAt ?? '').replace('T', ' ').slice(0, 19)} · 尝试 ${task.attempts ?? 0}/${task.maxAttempts ?? '?'}${task.error ? ` · ${String(task.error).slice(0, 80)}` : ''}` }),
            ]);
            if (['queued', 'running'].includes(task.status)) {
                const btn = el('button', { class: 'menu_button dcm-mini', text: '取消' });
                btn.addEventListener('click', async () => {
                    try {
                        await bridge.cancelTask(task.id);
                        toast('已请求取消', 'success');
                        loadTab('诊断');
                    } catch (err) {
                        toast(err.message, 'error');
                    }
                });
                row.append(btn);
            }
            pane.append(row);
        }
    }

    // 5) 最近事件（原始 JSON 折叠）
    const diag = await bridge.diagnostics(120);
    pane.append(sectionTitle('最近诊断事件'));
    pane.append(el('div', { class: 'dcm-field-hint', text: '只含摘要、哈希、来源 id 与耗时，不含私密正文。' }));
    pane.append(el('pre', { class: 'dcm-json', text: (diag.entries ?? []).slice(-40).map((e) => `${String(e.ts).slice(11, 19)}  ${e.event}${e.level && e.level !== 'info' ? `  [${e.level}]` : ''}`).join('\n') || '（暂无）' }));
    pane.append(rawJson({ status, tasks: taskList.stats, probe: probe?.effective }, '原始数据（排查用）'));
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ============================================================
// UI 装配与初始化
// ============================================================

function syncUiFromSettings() {
    if (!state.ui) return;
    const refs = state.ui.refs;
    refs.autoToggle.checked = Boolean(settings.enabled);
    refs.tierSelect.value = settings.tier;
    refs.customTierBox.style.display = settings.tier === 'custom' ? '' : 'none';
    const ct = settings.customTier ?? {};
    if (refs.ctTrigger) {
        refs.ctTrigger.value = ct.triggerRatio ?? 0.75;
        refs.ctRecallTopK.value = ct.recallTopK ?? 10;
        refs.ctRecallFloor.value = ct.recallFloorRatio ?? 0.04;
        refs.ctSummary.value = ct.summaryTargetRatio ?? 0.18;
        refs.ctRecentMin.value = ct.recentFloorMin ?? 8;
    }
    refs.privacySelect.value = settings.privacy;
    for (const [key, input] of Object.entries(refs.toggles)) input.checked = Boolean(settings[key]);
    if (refs.jevEndpoint) {
        refs.jevEndpoint.value = settings.jevEndpoint ?? '';
        refs.jevModel.value = settings.jevModel ?? 'system-one';
        refs.jevTimeoutMs.value = settings.jevTimeoutMs ?? 8000;
        refs.jevMinConfidence.value = settings.jevMinConfidence ?? 0.4;
        // API Key 不回显（服务端也不回传）；本地有值时用占位符提示已设置
        refs.jevApiKey.value = settings.jevApiKey ?? '';
        refs.jevApiKey.placeholder = settings.jevApiKey ? '已设置（输入可覆盖）' : '端点需要鉴权时填写';
    }
}

/**
 * 样式缓存击穿：给本扩展的 style.css 链接追加版本参数。
 * 静态 CSS 无版本参数时浏览器会长期缓存，升级后用户看到的是旧样式（表现为修复「没生效」）。
 */
function refreshStylesheetVersion() {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const href = link.getAttribute('href') ?? '';
        if (!href.includes('dacongming') || !href.includes('style.css')) continue;
        const base = href.split('?')[0];
        const next = `${base}?v=${EXT_VERSION}`;
        if (!link.href.endsWith(next) && !link.href.includes(`v=${EXT_VERSION}`)) link.href = next;
    }
}

/**
 * 在酒馆的 Wand 菜单（输入框左上角魔法棒）里加一个「记忆中心」入口，
 * 与其他全局工具并列，任何界面状态下都能一键打开。
 */
function installWandEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('dcm-wand-entry')) return;
    const item = el('div', {
        id: 'dcm-wand-entry',
        class: 'list-group-item flex-container flexGap5 interactable',
        title: '大聪明 · 打开记忆中心',
    }, [
        el('div', { class: 'fa-solid fa-database extensionsMenuExtensionButton' }),
        el('span', { text: '大聪明 · 记忆中心' }),
    ]);
    item.addEventListener('click', () => {
        if (!state.center) { toast('记忆中心尚未就绪，请先启用大聪明扩展', 'warning'); return; }
        openCenter();
    });
    menu.prepend(item);
}

function buildUi() {
    const panel = buildMainPanel({
        onAutoManage: (value) => setAutoManage(value),
        onTier: (value) => {
            settings.tier = value;
            markSettingsTouched();
            pushSettings();
            syncUiFromSettings();
        },
        onSaveCustomTier: (patch) => {
            settings.customTier = patch;
            settings.tier = 'custom';
            markSettingsTouched();
            pushSettings();
            syncUiFromSettings();
            toast('自定义档位参数已保存并生效', 'success');
        },
        onPrivacy: (value) => { settings.privacy = value; markSettingsTouched(); pushSettings(); },
        onToggle: (key, value) => { settings[key] = value; markSettingsTouched(); pushSettings(); },
        onSaveJev: (patch) => {
            Object.assign(settings, patch);
            markSettingsTouched();
            pushSettings();
            toast(patch.jevEndpoint
                ? 'Jev 设置已保存；打开「Jev 门控」开关后生效'
                : 'Jev 设置已保存（端点为空：仅走本地规则计划）', 'success');
        },
        onConnect: () => connect(),
        onReconnect: async () => { state.connected = false; await connect(); await reportProbe(true); },
        onOpenCenter: () => openCenter(),
    });
    state.ui = panel;

    const center = buildMemoryCenter({
        onClose: () => closeCenter(),
        onTab: (name) => loadTab(name),
    });
    state.center = center;
    center.overlay.style.display = 'none';
    document.body.append(center.overlay);

    // 内嵌记忆中心（主面板抽屉内的第二实例）：展开 details 时才加载，避免连接前空跑
    if (panel.refs.inlineCenterBody) {
        const inline = buildMemoryCenterBody({
            onClose: () => {},
            onTab: (name) => loadTab(name),
        });
        panel.refs.inlineCenterBody.append(inline.root);
        state.centerInline = inline;
        const details = panel.refs.inlineCenterBody.closest('details');
        details?.addEventListener('toggle', () => {
            if (details.open) loadTab(inline.refs.activeTab());
        });
    }

    const container = document.getElementById('extensions_settings')
        ?? document.getElementById('extensions_settings2');
    if (container) container.append(panel.root);
    else document.body.append(panel.root);

    panel.root.addEventListener('dcm-open-plan', () => openCenter('本轮计划'));
    panel.root.addEventListener('dcm-open-center', () => openCenter());

    syncUiFromSettings();
    renderStatus(panel.refs, state.lastStatus);
    renderRoundSummary(panel.refs, null);
}

async function pushSettings() {
    if (!state.connected) return;
    try {
        await bridge.updateSettings({
            tier: settings.tier,
            customTier: settings.customTier,
            privacy: settings.privacy,
            autoManage: settings.enabled,
            allowJev: settings.allowJev,
            jevEndpoint: settings.jevEndpoint,
            jevApiKey: settings.jevApiKey,
            jevModel: settings.jevModel,
            jevTimeoutMs: settings.jevTimeoutMs,
            jevMinConfidence: settings.jevMinConfidence,
            allowRemoteEmbedding: settings.allowRemoteEmbedding,
            allowCloudSync: settings.allowCloudSync,
            allowTelemetry: settings.allowTelemetry,
        });
    } catch (err) {
        console.warn('[大聪明] 设置同步失败', err);
    }
}

jQuery(async () => {
    buildUi();
    installInterceptor();
    wireEvents();
    await connect({ silent: true });

    // 周期性健康检查
    state.pollTimer = setInterval(async () => {
        if (!settings.enabled && !state.connected) return;
        try {
            await bridge.health();
            if (!state.connected) {
                state.connected = true;
                await connect();
            }
        } catch {
            if (state.connected) {
                state.connected = false;
                setStatus('需要处理', '与本地服务的连接已断开', [
                    { label: '重新连接', onClick: () => connect() },
                ]);
            }
        }
    }, 30_000);

    installWandEntry();
    refreshStylesheetVersion();
    console.log(`[大聪明] v${EXT_VERSION} 已加载（${HEURISTIC_NOTE}）`);
});
