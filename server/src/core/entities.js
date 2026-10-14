/**
 * 实体词典：人名、别名、物品、地点。
 *
 * 需求 4.3：服务端维护人名/别名/物品/地点词典，用于精确实体匹配。
 * 词典来源：角色卡名、世界书条目键、对话中抽取的候选词、用户手动添加。
 * 词典只影响切词检索与实体打分，不改变记忆内容。
 */

import { uuid, contentFingerprint } from '../util/ids.js';
import { extractDictionaryTerms } from './extractor.js';

export class EntityService {
    /** @param {{ data: any, logger?: object }} opts */
    constructor({ data, logger }) {
        this.data = data;
        this.logger = logger ?? null;
        this._dictionary = null;
    }

    #id(name, scope) {
        return contentFingerprint(`${scope ?? 'global'}|${name}`).slice(0, 24);
    }

    /**
     * 添加词典词（幂等）。
     */
    add(name, { type = 'unknown', aliases = [], scope = null, source = 'auto' } = {}) {
        const clean = String(name ?? '').trim();
        if (!clean || clean.length > 30) return null;
        const id = this.#id(clean, scope);
        const existing = this.data.get('entities', id);
        if (existing) {
            const merged = [...new Set([...(existing.aliases ?? []), ...aliases])];
            if (merged.length !== (existing.aliases ?? []).length) {
                this.data.update('entities', id, { aliases: merged, updatedAt: new Date().toISOString() });
                this.invalidate();
            }
            return existing;
        }
        const record = {
            id,
            name: clean,
            type,
            aliases: [...new Set(aliases)],
            scope,
            source,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.data.insert('entities', record);
        this.invalidate();
        return record;
    }

    addMany(names, opts = {}) {
        let count = 0;
        this.data.txn(() => {
            for (const name of names ?? []) {
                if (this.add(name, opts)) count += 1;
            }
        });
        return count;
    }

    /** 从探针数据播种：角色卡名 + 世界书键。 */
    seedFromProbe(probe) {
        const seeded = [];
        if (probe?.characterName) seeded.push({ name: probe.characterName, type: 'person' });
        for (const key of probe?.worldbookKeys ?? []) {
            for (const part of String(key).split(/[,，、]/)) {
                const term = part.trim();
                if (term && term.length <= 20) seeded.push({ name: term, type: 'worldbook' });
            }
        }
        for (const entity of probe?.cardEntities ?? []) {
            seeded.push({ name: entity.name ?? entity, type: entity.type ?? 'person', aliases: entity.aliases ?? [] });
        }
        let count = 0;
        this.data.txn(() => {
            for (const item of seeded) {
                if (this.add(item.name, { type: item.type, aliases: item.aliases ?? [], source: 'probe' })) count += 1;
            }
        });
        if (count) this.logger?.info?.('entities.seeded', { count });
        return count;
    }

    /** 从文本识别候选词并入库（自动增补）。 */
    learnFromText(text, { scope = null } = {}) {
        const terms = extractDictionaryTerms(text ?? '');
        let count = 0;
        for (const term of terms) {
            const rec = this.add(term, { type: 'auto', scope, source: 'dialogue' });
            if (rec) count += 1;
        }
        return count;
    }

    remove(id) {
        const ok = this.data.remove('entities', id);
        if (ok) this.invalidate();
        return ok;
    }

    list() {
        return this.data.all('entities');
    }

    /** 检索/抽取共用的词典数组（缓存）。 */
    dictionary() {
        if (this._dictionary) return this._dictionary;
        const set = new Set();
        for (const entity of this.data.all('entities')) {
            if (entity.name) set.add(entity.name);
            for (const alias of entity.aliases ?? []) if (alias) set.add(alias);
        }
        this._dictionary = [...set];
        return this._dictionary;
    }

    invalidate() {
        this._dictionary = null;
    }

    /** 供“记忆体检”检查孤儿实体（没有任何记忆引用） */
    orphans() {
        return this.list();
    }

    static newId() {
        return uuid();
    }
}
