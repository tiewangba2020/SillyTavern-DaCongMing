/**
 * 存储适配器选择。
 *
 * 权威存储为 SQLite（node:sqlite，Node 22.5+ 内置，无需安装原生依赖）。
 * 当运行环境缺少 node:sqlite 时自动降级为 append-only 日志存储（journal），
 * 保证“零外部依赖也能工作”；两种适配器实现同一接口，上层逻辑无感。
 */

import { SqliteAdapter } from './sqlite-adapter.js';
import { JournalAdapter } from './journal-adapter.js';

/**
 * @param {{ dataDir: string, kind?: 'auto'|'sqlite'|'journal', dbFile?: string, journalDir?: string, logger?: object }} opts
 */
export async function openAdapter(opts) {
    const kind = opts.kind ?? 'auto';
    if (kind === 'sqlite' || kind === 'auto') {
        try {
            const adapter = new SqliteAdapter({ file: opts.dbFile, logger: opts.logger });
            await adapter.init();
            return adapter;
        } catch (err) {
            if (kind === 'sqlite') throw err;
            opts.logger?.warn?.('store.sqlite_unavailable', {
                error: err.message,
                hint: 'node:sqlite 需要 Node.js ≥ 22.13（22.5~22.12 需加 --experimental-sqlite）；已自动降级为 journal 存储',
            });
        }
    }
    const adapter = new JournalAdapter({ dir: opts.journalDir, logger: opts.logger });
    await adapter.init();
    return adapter;
}
