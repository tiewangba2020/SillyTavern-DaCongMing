import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';
import {
    detectFormat, scan, mapPreview, dedupeReport, applyImport, rollbackImport, listImportBatches,
} from '../src/migrate/importers.js';

const horaeExport = {
    horae: {
        version: '2.3',
        summaries: [
            { id: 'h-1', text: '林月在云栖镇遇到了师父沈青崖。', timestamp: 1735689600000 },
            { id: 'h-2', text: '三年前的冬天，镇上起了一场大火。', timestamp: '2025-02-01T00:00:00Z' },
        ],
        timeline: [
            { id: 'h-3', text: '第 12 天：林月抵达苍梧山脚下。', date: '2025-03-05' },
        ],
        memories: [
            { id: 'h-4', content: '阿澈是林月的弟弟。', character: '阿澈' },
        ],
    },
};

test('格式探测：Horae / 柏宝书 / MessageLimit / 通用', () => {
    assert.equal(detectFormat(horaeExport).format, 'horae');
    assert.equal(detectFormat({ baibaiBook: { longSummaries: [] } }).format, 'baibaibook');
    assert.equal(detectFormat({ messageLimit: { maxMessages: 50 } }).format, 'messagelimit');
    assert.equal(detectFormat([{ text: 'a' }]).format, 'manual');
    assert.equal(detectFormat({ random: { nested: { text: 'x' } } }).format, 'generic');
});

test('只读扫描：抽取记录、推断类型、保留来源 id', () => {
    const result = scan(horaeExport);
    assert.equal(result.format, 'horae');
    assert.equal(result.records.length, 4);
    const summary = result.records.find((r) => r.sourceId === 'h-1');
    assert.equal(summary.kind, 'summary_chapter');
    assert.ok(summary.createdAt.startsWith('2025-01-01'));
    assert.equal(summary.importSourceId, 'horae:h-1');
    const timeline = result.records.find((r) => r.sourceId === 'h-3');
    assert.equal(timeline.kind, 'timeline');
    const withSpeaker = result.records.find((r) => r.sourceId === 'h-4');
    assert.equal(withSpeaker.speaker, '阿澈');
});

test('MessageLimit 明确标注为只读适配（无记忆可迁移）', () => {
    const result = scan({ messageLimit: { note: '这里只有配置', maxMessages: 50 } }, { source: 'messagelimit' });
    assert.equal(result.records.length, 0);
    assert.ok(result.skipped.length >= 1);
    assert.ok(result.skipped[0].reason.includes('无可迁移记忆'));
});

test('字段映射预览', () => {
    const preview = mapPreview(scan(horaeExport));
    assert.equal(preview.format, 'horae');
    assert.ok(preview.mapping.length >= 4);
    assert.ok(preview.sample.length >= 1);
    assert.ok(preview.sample[0].content.length > 0);
});

test('去重报告：与现有记忆重复的内容被识别', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.memories.create({
            kind: 'fact', scope: 'chat:mig', chatId: 'mig',
            content: '阿澈是林月的弟弟。', status: 'confirmed',
        }, { origin: 'auto' });
        const scanResult = scan(horaeExport);
        const report = dedupeReport(scanResult, { data: service.data, scope: 'chat:mig' });
        assert.equal(report.total, 4);
        assert.equal(report.duplicateCount, 1);
        assert.equal(report.newCount, 3);
    } finally {
        await ctx.cleanup();
    }
});

test('试运行（dryRun）不写入任何数据', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scanResult = scan(horaeExport);
        const result = applyImport(scanResult, {
            data: service.data, memoryService: service.memories, scope: 'chat:mig', dryRun: true,
        });
        assert.equal(result.dryRun, true);
        assert.equal(result.imported, 0);
        assert.ok(result.preview.length >= 1);
        assert.equal(service.memories.list({ scope: 'chat:mig' }).total, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('导入幂等：重复导入不产生重复记忆；可回滚', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const scanResult = scan(horaeExport);
        const first = applyImport(scanResult, {
            data: service.data, memoryService: service.memories, scope: 'chat:mig', chatId: 'mig',
        });
        assert.equal(first.imported, 4);
        assert.equal(service.memories.list({ scope: 'chat:mig' }).total, 4);

        const second = applyImport(scanResult, {
            data: service.data, memoryService: service.memories, scope: 'chat:mig', chatId: 'mig',
        });
        assert.equal(second.imported, 0, '重复导入必须幂等');
        assert.equal(second.skippedAlreadyImported, 4);
        assert.equal(service.memories.list({ scope: 'chat:mig' }).total, 4);

        // 稳定标识：来源插件 + importSourceId（避免双重注入）
        const imported = service.data.query('memory_records', (r) => r.importBatch === first.batchId);
        for (const rec of imported) {
            assert.equal(rec.derivation.sourcePlugin, 'horae');
            assert.ok(rec.importSourceId.startsWith('horae:'));
            assert.equal(rec.status, 'observed');
        }

        const batches = listImportBatches({ data: service.data });
        assert.ok(batches.some((b) => b.batchId === first.batchId));

        const rolledBack = rollbackImport({ data: service.data, batchId: first.batchId });
        assert.equal(rolledBack.removed, 4);
        assert.equal(service.memories.list({ scope: 'chat:mig' }).total, 0);
    } finally {
        await ctx.cleanup();
    }
});

test('遗忘阻断优先于导入：被“不再记忆”标记的内容不导入', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        service.memories.forgetText({ scope: 'chat:mig', text: '阿澈是林月的弟弟。' });
        const result = applyImport(scan(horaeExport), {
            data: service.data, memoryService: service.memories, scope: 'chat:mig',
        });
        assert.ok(result.skippedBlocked >= 1);
        assert.ok(!service.memories.list({ scope: 'chat:mig' }).items.some((r) => r.content.includes('阿澈')));
    } finally {
        await ctx.cleanup();
    }
});

test('形状容忍：柏宝书/通用 JSON 也能导入', async () => {
    const ctx = await makeService();
    try {
        const { service } = ctx;
        const baibai = {
            baibaiBook: {
                longSummaries: [{ text: '第一卷：林月拜入沈青崖门下。', createdAt: '2025-01-01' }],
                ledger: { items: [{ content: '获得物品：霜华剑鞘碎片', name: '物品账本' }] },
            },
        };
        const result = applyImport(scan(baibai), {
            data: service.data, memoryService: service.memories, scope: 'chat:mig2',
        });
        assert.equal(result.imported, 2);
        const items = service.memories.list({ scope: 'chat:mig2' }).items;
        assert.ok(items.some((r) => r.content.includes('霜华剑鞘碎片')));
    } finally {
        await ctx.cleanup();
    }
});
