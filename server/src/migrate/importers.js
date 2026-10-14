/**
 * 迁移导入：Horae / 柏宝书 / shujuku / MessageLimit / Anima RAG / 手写总结 / 通用 JSON。
 *
 * 需求 2.7 流程：只读扫描 → 字段映射预览 → 去重/冲突报告 → 试运行 →
 * 接管 → 原子提交 → 可回滚。重复导入必须幂等。
 * 迁移来源有稳定标识（derivation.sourcePlugin + importSourceId），
 * 避免同一记忆被旧插件和本插件双重注入。
 *
 * 由于各插件导出格式可能随版本变化，本实现采用“形状容忍”策略：
 * 递归收集带有文本字段的对象，按路径推断类型；无法识别时给出明确说明，
 * 不做静默丢弃。
 */

import { contentFingerprint, idempotencyKey, uuid } from '../util/ids.js';

const TEXT_FIELDS = ['text', 'content', 'summary', 'memory', 'description', 'content_text', 'body', 'value', 'note'];
const TIME_FIELDS = ['timestamp', 'createdAt', 'created_at', 'date', 'time', 'at', 'updatedAt'];
const ID_FIELDS = ['id', 'uuid', 'key', 'uid', '_id'];
const NAME_FIELDS = ['character', 'name', 'speaker', 'role', 'entity'];

export const SUPPORTED_SOURCES = Object.freeze({
    horae: { name: 'Horae', note: '支持摘要/时间线/状态/记忆 JSON 导出' },
    baibaibook: { name: '柏宝书', note: '支持长期摘要/账本/向量记忆 JSON 导出' },
    shujuku: { name: 'shujuku', note: '支持表格数据 JSON 导出（结构化状态）' },
    messagelimit: { name: 'MessageLimit', note: '仅消息数量配置，无可迁移记忆（只读适配）' },
    anima: { name: 'Anima RAG', note: '支持知识库/向量导出 JSON' },
    manual: { name: '手写总结', note: '纯文本或 JSON 数组' },
    generic: { name: '通用 JSON', note: '形状容忍导入' },
});

/** 格式探测。 */
export function detectFormat(json) {
    const keys = collectKeys(json, 3);
    const has = (re) => keys.some((k) => re.test(k));
    if (has(/horae/i)) return { format: 'horae', confidence: 0.9 };
    if (has(/baibai|柏宝书/i)) return { format: 'baibaibook', confidence: 0.9 };
    if (has(/shujuku|table|tables/i)) return { format: 'shujuku', confidence: 0.6 };
    if (has(/message.?limit/i)) return { format: 'messagelimit', confidence: 0.8 };
    if (has(/anima|vector|embedding/i)) return { format: 'anima', confidence: 0.6 };
    if (Array.isArray(json)) return { format: 'manual', confidence: 0.5 };
    if (has(/summary|summaries|timeline|memories|ledger/i)) return { format: 'generic', confidence: 0.5 };
    return { format: 'generic', confidence: 0.3 };
}

/**
 * 只读扫描：收集可迁移记录。
 * @param {any} json 解析后的 JSON
 * @param {{ source?: string }} [opts]
 */
export function scan(json, opts = {}) {
    const detected = detectFormat(json);
    const format = opts.source && SUPPORTED_SOURCES[opts.source] ? opts.source : detected.format;
    const records = [];
    const skipped = [];

    walk(json, [], (obj, path) => {
        const textField = TEXT_FIELDS.find((f) => typeof obj[f] === 'string' && obj[f].trim());
        if (!textField) return;
        const content = String(obj[textField]).trim();
        if (content.length < 2) return;
        if (format === 'messagelimit') {
            skipped.push({ path: path.join('.'), reason: 'MessageLimit 仅保存消息数量配置，无可迁移记忆' });
            return;
        }
        const sourceId = pickField(obj, ID_FIELDS) ?? contentFingerprint(content).slice(0, 24);
        const createdAt = normalizeTime(pickField(obj, TIME_FIELDS));
        const name = pickField(obj, NAME_FIELDS);
        records.push({
            content: content.slice(0, 2000),
            kind: inferKind(path, obj),
            createdAt,
            speaker: name ?? null,
            sourceId: String(sourceId),
            importSourceId: `${format}:${sourceId}`,
            path: path.join('.'),
            raw: undefined,
        });
    });

    return {
        format,
        formatInfo: SUPPORTED_SOURCES[format] ?? SUPPORTED_SOURCES.generic,
        detected,
        records,
        skipped,
        stats: {
            total: records.length,
            skipped: skipped.length,
            byKind: countBy(records, (r) => r.kind),
        },
    };
}

/** 字段映射预览。 */
export function mapPreview(scanResult) {
    const mapping = [
        { sourceField: 'text / content / summary / memory / description', targetField: 'content', note: '逐字保留，不改写' },
        { sourceField: 'id / uuid / key / uid', targetField: 'importSourceId', note: '稳定标识，保证重复导入幂等' },
        { sourceField: 'timestamp / createdAt / date', targetField: 'createdAt / validFrom', note: '时间归一化为 ISO 8601' },
        { sourceField: 'character / name / speaker', targetField: 'structured.speaker', note: '保留说话人' },
        { sourceField: '路径含 summary/timeline/fact/table', targetField: 'kind', note: '推断记忆类型' },
    ];
    return {
        format: scanResult.format,
        formatInfo: scanResult.formatInfo,
        mapping,
        sample: scanResult.records.slice(0, 5).map((r) => ({
            content: r.content.slice(0, 80), kind: r.kind, createdAt: r.createdAt, importSourceId: r.importSourceId,
        })),
    };
}

/** 去重/冲突报告（对照现有记忆）。 */
export function dedupeReport(scanResult, { data, scope }) {
    const existing = data.query('memory_records', (r) => !scope || r.scope === scope);
    const byHash = new Map();
    const bySourceId = new Map();
    for (const rec of existing) {
        byHash.set(`${rec.scope}|${rec.hash}`, rec);
        if (rec.importSourceId) bySourceId.set(rec.importSourceId, rec);
    }
    let duplicate = 0;
    let alreadyImported = 0;
    const newRecords = [];
    const duplicateSamples = [];
    for (const rec of scanResult.records) {
        if (bySourceId.has(rec.importSourceId)) {
            alreadyImported += 1;
            continue;
        }
        const hash = contentFingerprint(rec.content);
        if (byHash.has(`${scope}|${hash}`)) {
            duplicate += 1;
            if (duplicateSamples.length < 5) duplicateSamples.push(rec.content.slice(0, 60));
            continue;
        }
        newRecords.push(rec);
    }
    return {
        total: scanResult.records.length,
        newCount: newRecords.length,
        duplicateCount: duplicate,
        alreadyImportedCount: alreadyImported,
        duplicateSamples,
        newRecords,
    };
}

/**
 * 应用导入（幂等、原子、可回滚）。
 * @param {{ data: any, memoryService: any, scope: string, chatId?: string, branchId?: string,
 *           dryRun?: boolean, batchId?: string, source?: string }} opts
 */
export function applyImport(scanResult, opts) {
    const { data, memoryService, scope } = opts;
    const dryRun = Boolean(opts.dryRun);
    const batchId = opts.batchId ?? `import-${uuid().slice(0, 8)}`;
    const report = dedupeReport(scanResult, { data, scope });
    const result = {
        batchId,
        dryRun,
        format: scanResult.format,
        imported: 0,
        skippedDuplicate: report.duplicateCount,
        skippedAlreadyImported: report.alreadyImportedCount,
        skippedBlocked: 0,
        conflicts: 0,
        ids: [],
    };
    if (dryRun) return { ...result, preview: report.newRecords.slice(0, 10).map((r) => r.content.slice(0, 60)) };

    data.txn(() => {
        for (const rec of report.newRecords) {
            const { record, blocked } = memoryService.create({
                kind: rec.kind,
                scope,
                chatId: opts.chatId ?? null,
                branchId: opts.branchId ?? null,
                content: rec.content,
                structured: rec.speaker ? { speaker: rec.speaker } : null,
                sourceMessageIds: [],
                confidence: 0.7,
                importance: 0.6,
                status: 'observed',
                validFrom: rec.createdAt,
                derivation: {
                    method: 'import',
                    sourcePlugin: scanResult.format,
                    version: 'importer-v1',
                },
                importBatch: batchId,
                importSourceId: rec.importSourceId,
            }, { origin: 'import' });
            if (blocked) {
                result.skippedBlocked += 1;
                continue;
            }
            if (record) {
                result.imported += 1;
                result.ids.push(record.id);
            }
        }
    });
    return result;
}

/** 回滚导入批次。 */
export function rollbackImport({ data, batchId }) {
    const records = data.query('memory_records', (r) => r.importBatch === batchId);
    data.txn(() => {
        for (const rec of records) data.remove('memory_records', rec.id);
    });
    return { batchId, removed: records.length };
}

export function listImportBatches({ data }) {
    const batches = new Map();
    for (const rec of data.all('memory_records')) {
        if (!rec.importBatch) continue;
        const entry = batches.get(rec.importBatch) ?? { batchId: rec.importBatch, count: 0, source: rec.derivation?.sourcePlugin };
        entry.count += 1;
        batches.set(rec.importBatch, entry);
    }
    return [...batches.values()];
}

// ---------------- 内部 ----------------

function walk(node, path, visit, depth = 0) {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, [...path, String(i)], visit, depth + 1));
        return;
    }
    visit(node, path);
    for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') walk(value, [...path, key], visit, depth + 1);
    }
}

function collectKeys(node, depth) {
    const keys = [];
    walk(node, [], (obj, path) => {
        keys.push(path.join('.').toLowerCase());
        keys.push(...Object.keys(obj).map((k) => k.toLowerCase()));
    }, 0);
    void depth;
    return keys;
}

function pickField(obj, fields) {
    for (const f of fields) {
        if (obj[f] !== undefined && obj[f] !== null && String(obj[f]).trim()) return obj[f];
    }
    return null;
}

function normalizeTime(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function inferKind(path, obj) {
    const joined = path.join('.').toLowerCase();
    const typeHint = String(obj.type ?? obj.kind ?? obj.category ?? '').toLowerCase();
    const all = `${joined} ${typeHint}`;
    if (/summar(y|ies)|摘要|总结/.test(all)) return 'summary_chapter';
    if (/timeline|时间线|event|事件/.test(all)) return 'timeline';
    if (/relation|关系/.test(all)) return 'relation';
    if (/character|人物|entity|npc|角色/.test(all)) return 'entity';
    if (/location|地点|场景|scene/.test(all)) return 'scene';
    if (/item|物品|道具|inventory/.test(all)) return 'fact';
    if (/goal|目标|任务|quest|悬念|hook/.test(all)) return 'goal';
    if (/ledger|账本|state|状态|table|row/.test(all)) return 'fact';
    if (/preference|偏好|用户/.test(all)) return 'preference';
    return 'fact';
}

function countBy(items, fn) {
    const out = {};
    for (const item of items) {
        const key = fn(item);
        out[key] = (out[key] ?? 0) + 1;
    }
    return out;
}

export { idempotencyKey };
