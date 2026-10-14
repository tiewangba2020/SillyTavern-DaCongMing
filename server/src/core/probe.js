/**
 * 自动探针：缓存上下文环境探测结果。
 *
 * 需求 2.4：首次启用和每次上下文环境发生变化时探测并缓存：
 *   连接类型、模型标识与上下文限制；预设/系统提示/角色卡/世界书；
 *   当前聊天/分支/swipe/群聊参与者；输入 token、输出预留、工具/schema 开销和安全余量；
 *   已安装的兼容插件；API 可用性与估算 token 的准确等级。
 *
 * 探针结果必须带时间、来源和版本；无法获得精确 tokenizer 时标记“估算”。
 * 探针由扩展侧采集后上报（服务不直接读取浏览器状态）。
 */

import { uuid, idempotencyKey } from '../util/ids.js';
import { tokenAccuracyInfo } from '../util/tokenizer.js';

export const KNOWN_COMPAT_PLUGINS = Object.freeze([
    { id: 'horae', match: /horae|时序记忆/i, name: 'Horae' },
    { id: 'baibaibook', match: /柏宝书|baibai.?book/i, name: '柏宝书' },
    { id: 'shujuku', match: /shujuku|龙血玄黄|数据库/i, name: 'shujuku' },
    { id: 'messagelimit', match: /message.?limit/i, name: 'MessageLimit' },
    { id: 'anima', match: /anima.?rag/i, name: 'Anima RAG' },
]);

export class ProbeService {
    /** @param {{ data: any, config?: object, logger?: object }} opts */
    constructor({ data, config, logger }) {
        this.data = data;
        this.config = config ?? {};
        this.logger = logger ?? null;
    }

    /**
     * 上报探针结果。
     * @param {object} payload
     */
    update(payload) {
        const chatId = payload.chatId ?? 'default';
        const profileHash = idempotencyKey({
            model: payload.model ?? payload.modelId ?? null,
            contextLimit: payload.contextLimit ?? null,
            outputReserve: payload.outputReserve ?? null,
            preset: payload.presetName ?? null,
            character: payload.characterId ?? null,
        }).slice(0, 16);

        const record = {
            id: uuid(),
            chatId,
            at: new Date().toISOString(),
            source: payload.source ?? 'extension-probe',
            version: payload.extensionVersion ?? 'unknown',
            stVersion: payload.stVersion ?? null,
            connectionType: payload.connectionType ?? 'unknown',
            model: payload.model ?? null,
            modelId: payload.modelId ?? null,
            contextLimit: payload.contextLimit ?? null,
            outputReserve: payload.outputReserve ?? null,
            toolSchemaOverhead: payload.toolSchemaOverhead ?? 0,
            characterId: payload.characterId ?? null,
            characterName: payload.characterName ?? null,
            presetName: payload.presetName ?? null,
            worldbookNames: payload.worldbookNames ?? [],
            worldbookKeys: payload.worldbookKeys ?? [],
            groupParticipants: payload.groupParticipants ?? [],
            branchId: payload.branchId ?? null,
            swipeSelection: payload.swipeSelection ?? null,
            installedPlugins: this.#detectPlugins(payload.installedPlugins ?? []),
            tokenizerAvailable: Boolean(payload.tokenizerAvailable),
            tokenAccuracy: payload.tokenizerAvailable ? 'exact-available' : tokenAccuracyInfo().level,
            profileHash,
        };
        this.data.insert('probes', record);

        // 保留：每聊天最近 20 条
        const history = this.data.query('probes', (p) => p.chatId === chatId);
        if (history.length > 20) {
            history.sort((a, b) => (a.at < b.at ? -1 : 1));
            const excess = history.slice(0, history.length - 20);
            this.data.txn(() => {
                for (const p of excess) this.data.remove('probes', p.id);
            });
        }
        this.logger?.info?.('probe.updated', {
            chatId, model: record.model, contextLimit: record.contextLimit,
            plugins: record.installedPlugins.map((p) => p.id),
        });
        return record;
    }

    get(chatId) {
        const items = this.data.query('probes', (p) => p.chatId === chatId);
        items.sort((a, b) => (a.at < b.at ? 1 : -1));
        return items[0] ?? null;
    }

    /** 生效配置：优先最新探针，缺失时保守默认并标记来源。 */
    effective(chatId) {
        const probe = this.get(chatId);
        if (!probe) {
            return {
                contextLimit: 4096,
                outputReserve: 512,
                tokenAccuracy: tokenAccuracyInfo(),
                source: 'default-conservative',
                stale: true,
                at: null,
                note: '尚未收到探针数据，使用保守默认（4096 上下文 / 512 输出预留）',
            };
        }
        const ageMs = Date.now() - Date.parse(probe.at);
        return {
            contextLimit: probe.contextLimit ?? 4096,
            outputReserve: probe.outputReserve ?? 512,
            toolSchemaOverhead: probe.toolSchemaOverhead ?? 0,
            model: probe.model,
            tokenAccuracy: probe.tokenizerAvailable
                ? { level: 'exact-available', method: 'st-tokenizer', note: '扩展侧可用 SillyTavern tokenizer 做最终计数' }
                : tokenAccuracyInfo(),
            source: probe.source,
            profileHash: probe.profileHash,
            installedPlugins: probe.installedPlugins,
            stale: ageMs > 30 * 60 * 1000,
            at: probe.at,
        };
    }

    compatReport(chatId) {
        const probe = this.get(chatId);
        if (!probe) return { detected: [], note: '尚无探针数据' };
        return {
            detected: probe.installedPlugins,
            note: probe.installedPlugins.length
                ? '检测到兼容插件，可在记忆中心使用“迁移导入”'
                : '未检测到兼容插件',
        };
    }

    #detectPlugins(names) {
        const out = [];
        for (const name of names) {
            const str = typeof name === 'string' ? name : (name?.name ?? '');
            const known = KNOWN_COMPAT_PLUGINS.find((k) => k.match.test(str));
            out.push(known
                ? { id: known.id, name: known.name, raw: str, supported: true }
                : { id: str.toLowerCase().replace(/\s+/g, '-').slice(0, 40), name: str, raw: str, supported: false });
        }
        return out;
    }
}
