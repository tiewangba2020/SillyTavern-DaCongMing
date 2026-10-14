/**
 * 内存投影层：把适配器加载的记录组织为按集合的 Map，并维护可重建的倒排索引。
 *
 * 需求 4.2：摘要、事实、时间线、向量和统计都是可重建 projection；
 * 本层的倒排索引即是 projection 之一，可随时 rebuildIndex() 从记录重建。
 * 需求 4.3：索引与查询使用同一 segment() 规则与同一版本。
 */

import { segment } from '../util/segment.js';
import { segmentQuery } from '../util/segment.js';

const K1 = 1.2;
const B = 0.75;

// 参与全文索引的集合与文本提取规则
const INDEXED = {
    memory_records: (rec) => [rec.content, rec.structured ? JSON.stringify(rec.structured) : ''].join('\n'),
    message_events: (rec) => rec.text ?? '',
};

export const INDEXED_COLLECTIONS = Object.keys(INDEXED);

export class Data {
    /** @param {{ adapter: any, logger?: object }} opts */
    constructor({ adapter, logger }) {
        this.adapter = adapter;
        this.logger = logger ?? null;
        /** @type {Map<string, Map<string, object>>} */
        this.collections = new Map();
        this.meta = new Map();
        this.index = {
            postings: new Map(), // term -> Map<docId, tf>
            docTerms: new Map(), // docId -> Map<term, tf>
            docLen: new Map(), // docId -> term count
            totalLen: 0,
            docCount: 0,
            builtAt: null,
        };
        this._txDepth = 0;
    }

    async init() {
        const { collections, meta } = this.adapter.loadAll();
        this.collections = collections;
        this.meta = meta;
        this.rebuildIndex();
        return this;
    }

    #ensure(collection) {
        if (!this.collections.has(collection)) this.collections.set(collection, new Map());
        return this.collections.get(collection);
    }

    insert(collection, record) {
        if (!record || typeof record.id !== 'string') {
            throw new Error(`记录缺少 id：collection=${collection}`);
        }
        this.#ensure(collection).set(record.id, record);
        this.adapter.put(collection, record.id, record);
        this.indexRecord(collection, record);
        return record;
    }

    update(collection, id, patch) {
        const existing = this.get(collection, id);
        if (!existing) throw new Error(`记录不存在：${collection}/${id}`);
        const next = { ...existing, ...patch };
        this.#ensure(collection).set(id, next);
        this.adapter.put(collection, id, next);
        if (INDEXED[collection]) {
            this.deindexRecord(collection, existing);
            this.indexRecord(collection, next);
        }
        return next;
    }

    get(collection, id) {
        return this.collections.get(collection)?.get(id) ?? null;
    }

    all(collection) {
        return [...(this.collections.get(collection)?.values() ?? [])];
    }

    query(collection, predicate) {
        const out = [];
        for (const rec of this.collections.get(collection)?.values() ?? []) {
            if (predicate(rec)) out.push(rec);
        }
        return out;
    }

    count(collection) {
        return this.collections.get(collection)?.size ?? 0;
    }

    remove(collection, id) {
        const existing = this.get(collection, id);
        if (!existing) return false;
        this.collections.get(collection).delete(id);
        this.adapter.remove(collection, id);
        if (INDEXED[collection]) this.deindexRecord(collection, existing);
        return true;
    }

    /** 批量删除（用于隐私清理），走同一事务。 */
    removeWhere(collection, predicate) {
        const ids = this.query(collection, predicate).map((r) => r.id);
        this.txn(() => {
            for (const id of ids) this.remove(collection, id);
        });
        return ids.length;
    }

    metaGet(key, fallback = null) {
        return this.meta.has(key) ? this.meta.get(key) : fallback;
    }

    metaSet(key, value) {
        this.meta.set(key, value);
        this.adapter.metaSet(key, value);
    }

    txn(fn) {
        this._txDepth += 1;
        try {
            return this.adapter.txn(() => fn());
        } finally {
            this._txDepth -= 1;
        }
    }

    // ---------------- 倒排索引 ----------------

    docId(collection, id) {
        return `${collection === 'memory_records' ? 'm' : 'e'}:${id}`;
    }

    #termsFor(collection, record) {
        const textFn = INDEXED[collection];
        if (!textFn) return null;
        return segment(textFn(record));
    }

    indexRecord(collection, record) {
        if (!INDEXED[collection]) return;
        const docId = this.docId(collection, record.id);
        if (this.index.docTerms.has(docId)) this.deindexRecord(collection, record);
        const terms = this.#termsFor(collection, record);
        if (!terms) return;
        const tf = new Map();
        for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
        for (const [term, count] of tf) {
            if (!this.index.postings.has(term)) this.index.postings.set(term, new Map());
            this.index.postings.get(term).set(docId, count);
        }
        // 即使没有词（纯标点/停用词），也登记文档，便于体检区分“未索引”与“无词”
        this.index.docTerms.set(docId, tf);
        this.index.docLen.set(docId, terms.length);
        this.index.totalLen += terms.length;
        this.index.docCount += 1;
    }

    deindexRecord(collection, record) {
        if (!INDEXED[collection]) return;
        const docId = this.docId(collection, record.id);
        const tf = this.index.docTerms.get(docId);
        if (!tf) return;
        for (const term of tf.keys()) {
            const postings = this.index.postings.get(term);
            if (!postings) continue;
            postings.delete(docId);
            if (postings.size === 0) this.index.postings.delete(term);
        }
        this.index.totalLen -= this.index.docLen.get(docId) ?? 0;
        this.index.docCount -= 1;
        this.index.docTerms.delete(docId);
        this.index.docLen.delete(docId);
    }

    rebuildIndex() {
        this.index = {
            postings: new Map(),
            docTerms: new Map(),
            docLen: new Map(),
            totalLen: 0,
            docCount: 0,
            builtAt: new Date().toISOString(),
        };
        for (const collection of INDEXED_COLLECTIONS) {
            for (const record of this.collections.get(collection)?.values() ?? []) {
                this.indexRecord(collection, record);
            }
        }
        this.logger?.debug?.('store.index_rebuilt', { docs: this.index.docCount, terms: this.index.postings.size });
        return this.indexStats();
    }

    indexStats() {
        return {
            documents: this.index.docCount,
            terms: this.index.postings.size,
            totalTerms: this.index.totalLen,
            builtAt: this.index.builtAt,
        };
    }

    /**
     * BM25 检索。返回按分数降序的 [{ id, docId, score }]。
     * @param {string[]} terms 已切词的查询词
     * @param {{ limit?: number, collection?: string }} [opts]
     */
    search(terms, opts = {}) {
        const limit = opts.limit ?? 200;
        const prefix = opts.collection === 'memory_records' ? 'm:'
            : opts.collection === 'message_events' ? 'e:'
                : null;
        const N = Math.max(1, this.index.docCount);
        const avgdl = this.index.totalLen / N || 1;
        const scores = new Map();
        for (const term of terms) {
            const postings = this.index.postings.get(term);
            if (!postings) continue;
            const df = postings.size;
            const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
            for (const [docId, tf] of postings) {
                if (prefix && !docId.startsWith(prefix)) continue;
                const dl = this.index.docLen.get(docId) ?? 1;
                const denom = tf + K1 * (1 - B + (B * dl) / avgdl);
                const score = (idf * (tf * (K1 + 1))) / denom;
                scores.set(docId, (scores.get(docId) ?? 0) + score);
            }
        }
        const arr = [...scores.entries()].map(([docId, score]) => ({
            docId,
            id: docId.slice(2),
            collection: docId.startsWith('m:') ? 'memory_records' : 'message_events',
            score,
        }));
        arr.sort((a, b) => b.score - a.score);
        return arr.slice(0, limit);
    }

    searchText(query, opts = {}) {
        return this.search(segmentQuery(query), opts);
    }
}
