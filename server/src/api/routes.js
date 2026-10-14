/**
 * HTTP 路由表。
 * 每个路由声明 auth（是否需要凭证）；写操作一律走 JSON body（CSRF 防护）。
 */

import { readFileSync } from 'node:fs';
import { detectFormat, scan, mapPreview, dedupeReport, applyImport, rollbackImport, listImportBatches } from '../migrate/importers.js';

export function createRoutes(service) {
    const { memories, data, snapshots, entities, tasks, probes, config } = service;

    const routes = [
        // ---------------- 无鉴权 ----------------
        {
            method: 'GET', path: '/api/health', auth: false,
            handler: () => ({
                ok: true,
                service: 'dacongming-memory-service',
                version: service.stats().service,
                uptimeSec: Math.round((Date.now() - Date.parse(service.startedAt)) / 1000),
                store: data.adapter.kind,
                paired: service.security?.status?.().paired ?? false,
                status: '正常',
            }),
        },
        {
            method: 'POST', path: '/api/pair/request', auth: false, bucket: 'pair',
            handler: ({ body }) => service.security.requestPairing({
                origin: body?.origin ?? null,
                clientName: body?.clientName ?? 'SillyTavern',
            }),
        },
        {
            method: 'POST', path: '/api/pair/confirm', auth: false, bucket: 'pair',
            handler: ({ body }) => service.security.confirmPairing({
                code: body?.code,
                origin: body?.origin ?? null,
            }),
        },

        // ---------------- 状态与设置 ----------------
        {
            method: 'GET', path: '/api/status', auth: true,
            handler: () => ({
                ok: true,
                service: 'dacongming-memory-service',
                version: service.stats().service,
                startedAt: service.startedAt,
                security: service.security.status(),
                settings: publicSettings(config),
                stats: service.stats(),
            }),
        },
        {
            method: 'GET', path: '/api/settings', auth: true,
            handler: () => ({ ok: true, settings: publicSettings(config) }),
        },
        {
            method: 'POST', path: '/api/settings', auth: true,
            handler: ({ body }) => service.updateSettings(body ?? {}),
        },

        // ---------------- 探针 ----------------
        {
            method: 'POST', path: '/api/probe', auth: true,
            handler: ({ body }) => {
                const record = probes.update(body ?? {});
                if (record.worldbookKeys?.length || record.characterName) {
                    entities.seedFromProbe(record);
                }
                return {
                    ok: true,
                    probe: record,
                    effective: probes.effective(record.chatId),
                    compat: probes.compatReport(record.chatId),
                };
            },
        },
        {
            method: 'GET', path: '/api/probe', auth: true,
            handler: ({ query }) => ({
                ok: true,
                probe: probes.get(query.chatId ?? 'default'),
                effective: probes.effective(query.chatId ?? 'default'),
            }),
        },

        // ---------------- 摄取与计划 ----------------
        {
            method: 'POST', path: '/api/ingest', auth: true,
            handler: ({ body }) => {
                const result = service.ingest(body ?? {});
                return { ok: true, ...result, events: undefined };
            },
        },
        {
            method: 'POST', path: '/api/plan', auth: true,
            handler: async ({ body }) => ({ ok: true, ...(await service.plan(body ?? {})) }),
        },
        {
            method: 'POST', path: '/api/preview', auth: true,
            handler: async ({ body }) => ({
                ok: true,
                ...(await service.plan({ ...(body ?? {}), options: { ...(body?.options ?? {}), preview: true } })),
            }),
        },
        {
            method: 'GET', path: '/api/plans/latest', auth: true,
            handler: ({ query }) => {
                const items = data.query('context_plans', (p) => !query.chatId || p.chatId === query.chatId);
                items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
                return { ok: true, plan: items[0] ?? null };
            },
        },
        {
            method: 'POST', path: '/api/plans/:planId/feedback', auth: true,
            handler: ({ params, body }) => ({ ok: true, plan: service.recordFeedback(params.planId, body ?? {}) }),
        },

        // ---------------- 记忆中心 ----------------
        {
            method: 'GET', path: '/api/memories', auth: true,
            handler: ({ query }) => ({
                ok: true,
                ...memories.list({
                    scope: query.scope,
                    status: query.status ? String(query.status).split(',') : undefined,
                    kind: query.kind ? String(query.kind).split(',') : undefined,
                    chatId: query.chatId,
                    branchId: query.branchId,
                    sourceMessageId: query.sourceMessageId,
                    search: query.search,
                    sourcePlugin: query.sourcePlugin || undefined,
                    createdAfter: query.createdAfter || undefined,
                    createdBefore: query.createdBefore || undefined,
                    floorFrom: query.floorFrom !== undefined && query.floorFrom !== '' ? Number(query.floorFrom) : undefined,
                    floorTo: query.floorTo !== undefined && query.floorTo !== '' ? Number(query.floorTo) : undefined,
                    speaker: query.speaker || undefined,
                    includeInvalidated: query.includeInvalidated === '1',
                    limit: Number(query.limit ?? 200),
                    offset: Number(query.offset ?? 0),
                }),
            }),
        },
        {
            method: 'POST', path: '/api/memories', auth: true,
            handler: ({ body }) => {
                const { record, blocked } = memories.create({
                    ...(body ?? {}),
                    status: body?.status ?? 'confirmed',
                    userEdited: true,
                    userLocked: body?.userLocked ?? true,
                    confidence: body?.confidence ?? 1,
                    derivation: { method: 'user', version: 'user-create' },
                }, { origin: 'user' });
                if (blocked) return { ok: false, error: '该内容已被“不再记忆”标记阻断', blockedId: blocked.id };
                return { ok: true, record };
            },
        },
        {
            method: 'PATCH', path: '/api/memories/:id', auth: true,
            handler: ({ params, body }) => {
                const action = body?.action ?? 'update';
                if (action === 'correct') {
                    return { ok: true, record: memories.correct(params.id, { content: body.content, structured: body.structured }) };
                }
                if (action === 'lock') return { ok: true, record: memories.setLocked(params.id, body.locked ?? true) };
                if (action === 'importance') return { ok: true, record: memories.setImportance(params.id, body.importance) };
                if (action === 'promote') return { ok: true, record: memories.promote(params.id, body.status, body.reason) };
                throw new Error(`未知操作：${action}`);
            },
        },
        {
            method: 'POST', path: '/api/memories/:id/forget', auth: true,
            handler: ({ params, body }) => ({ ok: true, record: memories.forget(params.id, { reason: body?.reason ?? '用户遗忘' }) }),
        },
        {
            method: 'POST', path: '/api/memories/:id/restore', auth: true,
            handler: ({ params }) => ({ ok: true, record: memories.restore(params.id) }),
        },
        {
            method: 'POST', path: '/api/forget-text', auth: true,
            handler: ({ body }) => ({
                ok: true,
                tombstone: memories.forgetText({
                    scope: body?.scope ?? `chat:${body?.chatId ?? 'default'}`,
                    text: body?.text,
                    messageIds: body?.messageIds ?? [],
                    reason: body?.reason ?? '用户标记不再记忆',
                }),
            }),
        },
        {
            method: 'POST', path: '/api/purge', auth: true,
            handler: ({ body }) => {
                if (body?.confirm !== 'DELETE') {
                    return { ok: false, error: '彻底删除需要 confirm: "DELETE" 确认', fixActions: ['在记忆中心勾选确认后再执行'] };
                }
                const result = memories.purgeScope(body?.scope ?? `chat:${body?.chatId ?? 'default'}`);
                return { ok: true, ...result, note: '已清理插件副本；SillyTavern 原始聊天未受影响' };
            },
        },

        // ---------------- 快照 ----------------
        {
            method: 'GET', path: '/api/snapshots', auth: true,
            handler: ({ query }) => ({ ok: true, items: snapshots.list({ scope: query.scope, limit: Number(query.limit ?? 20) }) }),
        },
        {
            // 手动创建快照（用户点「立即创建快照」）：不依赖某次计划，直接固化当前记忆状态
            method: 'POST', path: '/api/snapshots', auth: true,
            handler: ({ body }) => {
                const scope = body?.scope;
                if (!scope) return { ok: false, error: '缺少 scope' };
                const snapshot = snapshots.capture({
                    plan: {},
                    scope,
                    chatId: body.chatId ?? null,
                    branchId: body.branchId ?? null,
                    label: body.label ?? '手动快照',
                    auto: false,
                });
                return { ok: true, snapshot };
            },
        },
        {
            method: 'POST', path: '/api/snapshots/:id/restore', auth: true,
            handler: ({ params }) => ({ ok: true, ...snapshots.restore(params.id) }),
        },

        // ---------------- 记忆体检 ----------------
        {
            method: 'GET', path: '/api/health-check', auth: true,
            handler: ({ query }) => ({ ok: true, ...service.healthCheck(query.scope ?? null) }),
        },
        {
            method: 'POST', path: '/api/health-check/fix', auth: true,
            handler: ({ body }) => ({ ok: true, ...service.applyHealthFix(body?.fix, body?.ids ?? []) }),
        },
        {
            method: 'POST', path: '/api/index/rebuild', auth: true,
            handler: () => ({ ok: true, index: service.rebuildIndex() }),
        },

        // ---------------- 导出 / 导入 ----------------
        {
            method: 'GET', path: '/api/export', auth: true,
            handler: ({ query }) => ({
                ok: true,
                export: service.exportData({
                    scope: query.scope ?? null,
                    includeEvents: query.includeEvents === '1',
                }),
            }),
        },
        {
            method: 'POST', path: '/api/import/preview', auth: true,
            handler: ({ body }) => ({ ok: true, preview: service.importPreview(body?.payload ?? body) }),
        },
        {
            method: 'POST', path: '/api/import/apply', auth: true,
            handler: ({ body }) => ({ ok: true, result: service.importApply(body?.payload ?? body) }),
        },

        // ---------------- 迁移 ----------------
        {
            method: 'POST', path: '/api/migrate/scan', auth: true,
            handler: ({ body }) => {
                let payload = body?.payload;
                if (typeof payload === 'string') {
                    try { payload = JSON.parse(payload); } catch (err) { throw new Error(`JSON 解析失败：${err.message}`); }
                }
                if (body?.file) {
                    payload = JSON.parse(readFileSync(body.file, 'utf8'));
                }
                const detected = detectFormat(payload);
                const scanResult = scan(payload, { source: body?.source });
                const preview = mapPreview(scanResult);
                const dedupe = dedupeReport(scanResult, { data, scope: body?.scope ?? `chat:${body?.chatId ?? 'default'}` });
                return {
                    ok: true,
                    detected,
                    format: scanResult.format,
                    formatInfo: scanResult.formatInfo,
                    stats: scanResult.stats,
                    skipped: scanResult.skipped.slice(0, 20),
                    preview,
                    dedupe: { ...dedupe, newRecords: undefined },
                    batches: listImportBatches({ data }),
                };
            },
        },
        {
            method: 'POST', path: '/api/migrate/apply', auth: true,
            handler: ({ body }) => {
                let payload = body?.payload;
                if (typeof payload === 'string') payload = JSON.parse(payload);
                const scanResult = scan(payload, { source: body?.source });
                const result = applyImport(scanResult, {
                    data,
                    memoryService: memories,
                    scope: body?.scope ?? `chat:${body?.chatId ?? 'default'}`,
                    chatId: body?.chatId,
                    branchId: body?.branchId,
                    dryRun: Boolean(body?.dryRun),
                    batchId: body?.batchId,
                });
                service.bus.emit('migrate', result);
                return { ok: true, result };
            },
        },
        {
            method: 'POST', path: '/api/migrate/rollback', auth: true,
            handler: ({ body }) => ({ ok: true, ...rollbackImport({ data, batchId: body?.batchId }) }),
        },

        // ---------------- 任务与诊断 ----------------
        {
            method: 'GET', path: '/api/tasks', auth: true,
            handler: ({ query }) => ({ ok: true, items: tasks.list({ status: query.status, limit: Number(query.limit ?? 100) }), stats: tasks.stats() }),
        },
        {
            method: 'POST', path: '/api/tasks/:id/cancel', auth: true,
            handler: ({ params }) => ({ ok: true, cancelled: tasks.cancel(params.id) }),
        },
        {
            method: 'GET', path: '/api/diagnostics', auth: true,
            handler: ({ query }) => ({
                ok: true,
                entries: service.logger.recent(Number(query.limit ?? 100)),
                note: '诊断日志只包含摘要、哈希、来源 id、耗时和状态，不包含私密正文',
            }),
        },

        // ---------------- 实体词典 ----------------
        {
            method: 'GET', path: '/api/entities', auth: true,
            handler: () => ({ ok: true, items: entities.list(), dictionarySize: entities.dictionary().length }),
        },
        {
            method: 'POST', path: '/api/entities', auth: true,
            handler: ({ body }) => ({ ok: true, record: entities.add(body?.name, { type: body?.type ?? 'user', aliases: body?.aliases ?? [], source: 'user' }) }),
        },

        // ---------------- 数据与作用域 ----------------
        {
            method: 'GET', path: '/api/scope', auth: true,
            handler: ({ query }) => {
                const chatId = query.chatId ?? 'default';
                const scope = query.scope ?? `chat:${chatId}`;
                return {
                    ok: true,
                    scope,
                    chatId,
                    deletionEpoch: memories.currentEpoch(scope),
                    branchHead: service.events.headRevision(chatId, query.branchId ?? 'main'),
                    profileHash: probes.effective(chatId).profileHash ?? null,
                    indexBuiltAt: data.index.builtAt,
                };
            },
        },
        {
            method: 'POST', path: '/api/backup', auth: true,
            handler: async () => ({ ok: true, file: await service.backup('manual') }),
        },
        {
            method: 'POST', path: '/api/shutdown', auth: true,
            handler: () => {
                service.bus.emit('shutdown', {});
                setTimeout(() => process.exit(0), 200);
                return { ok: true, note: '服务即将停止；停止服务不会删除聊天或记忆数据' };
            },
        },
    ];

    return routes;
}

export function publicSettings(config) {
    return {
        tier: config.tier,
        customTier: config.customTier ?? null,
        privacy: config.privacy,
        autoManage: config.autoManage,
        shadowMode: config.shadowMode,
        shadowTurns: config.shadowTurns,
        allowJev: config.allowJev,
        // TypeSafe Jev 门控配置（apiKey 不回传，只告知是否已设置）
        jevEndpoint: config.jevEndpoint ?? '',
        jevModel: config.jevModel ?? 'system-one',
        jevTimeoutMs: config.jevTimeoutMs ?? 8000,
        jevMinConfidence: config.jevMinConfidence ?? 0.4,
        jevApiKeySet: Boolean(config.jevApiKey),
        jevActive: Boolean(config.allowJev && config.jevEndpoint),
        allowRemoteEmbedding: config.allowRemoteEmbedding,
        allowCloudSync: config.allowCloudSync,
        allowTelemetry: config.allowTelemetry,
        lanMode: config.lanMode,
        compressionTriggerRatio: config.compressionTriggerRatio,
        safetyMarginRatio: config.safetyMarginRatio,
        // 供客户端判断「服务端是否已有用户配置」（false = 仍是首次运行的默认/播种值）
        settingsPersisted: Boolean(config.settingsPersisted),
    };
}
