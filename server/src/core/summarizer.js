/**
 * 抽取式摘要器（无模型、确定性、可回滚）。
 *
 * 需求 3.1：抽取式摘要必须可用，且不得编造事实。
 * 需求 5.1：同一聊天重复压缩不产生摘要漂移。
 *
 * 关键性质：
 *   - 输出只包含原文句子（逐字摘录），因此不可能编造事实；
 *   - 相同输入 → 相同输出 → 相同 hash（幂等，重复压缩无漂移）；
 *   - 合并摘要只做句子级并集与去重，同样不改写；
 *   - 保留硬事实信号（日期/数字）与词典实体句子的加权。
 */

import { segment } from '../util/segment.js';
import { splitSentences, hasHardFactSignal, normalizeText } from '../util/text.js';
import { contentFingerprint } from '../util/ids.js';
import { estimateTokensConservative as countTokens } from '../util/tokenizer.js';
import { SUMMARIZER_VERSION } from '../config.js';

export class Summarizer {
    constructor({ logger } = {}) {
        this.logger = logger ?? null;
    }

    /**
     * 对一段消息做抽取式摘要。
     * @param {Array<{messageId: string, content: string, floorIndex?: number}>} messages
     * @param {{ targetTokens?: number, dictionary?: string[] }} [opts]
     */
    summarizeMessages(messages, opts = {}) {
        const targetTokens = opts.targetTokens ?? 400;
        const dictionary = opts.dictionary ?? [];
        const sentences = [];

        messages.forEach((msg, msgIndex) => {
            const parts = splitSentences(msg.content ?? '');
            parts.forEach((part, sIndex) => {
                sentences.push({
                    text: part.text,
                    messageId: msg.messageId,
                    floorIndex: msg.floorIndex ?? msgIndex,
                    msgIndex,
                    sIndex,
                    sentenceCount: parts.length,
                });
            });
        });

        if (!sentences.length) {
            return { text: '', sourceMessageIds: [], hash: contentFingerprint(''), tokens: 0, kept: 0, total: 0, entities: { kept: [], missed: [] } };
        }

        // 预计算：切词、字符二元组、文档频率（df）。
        // 三样都只算一次，避免打分阶段重复计算（3000 楼会调用 75 次章节摘要）。
        const sentenceTerms = sentences.map((s) => segment(s.text));
        const docFreq = new Map();
        for (const terms of sentenceTerms) {
            for (const term of new Set(terms)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
        }
        const gramsList = sentences.map((s) => bigramSet(normalizeText(s.text).replace(/\s+/g, '')));

        // 词典实体命中：每句只算一次（首字索引剪枝，语义与逐词 includes 完全等价），
        // 粗排、终评、entities 元数据三处共用。
        // 旧实现是「每句 × 每词」双重 includes，真实章节（11,674 句 × 词典 400 词）
        // 单章约 80ms 且要跑两遍；这里一遍完成。
        const entityIndex = buildEntityIndex(dictionary);
        const entityHits = new Array(sentences.length);
        const entitiesInSource = new Set();
        for (let i = 0; i < sentences.length; i += 1) {
            const hits = findEntityHits(entityIndex, sentences[i].text);
            entityHits[i] = hits;
            for (const name of hits) entitiesInSource.add(name);
        }

        // 多样性只在「粗排池」内计算（见 #poolDiversity / DIVERSITY_POOL）。
        //
        // 为什么不能对全章每句都算：真实长篇章节（40 楼 / 32 万字符）切出 11,674 句，
        // 旧实现对每句与全章采样 600 个参照句比较，实测单章 2.3~3.7 秒、**同步阻塞
        // 事件循环 4.4~5.0 秒**（酒馆整段时间无响应，手机上更久）。
        // 而多样性的两个量（dupCount / maxSim）只对「有机会入选的句子」有意义——
        // 一句排在 5000 名之后的模板句，无论惩罚多重都不会被选中。
        // 所以先用不含多样性项的便宜信号选出候选池，只对池内句子、对照整章均匀
        // 参照集计算多样性；选择也只在池内进行（池外句子的 diversity 是中性值，
        // 若让它们参与竞争会反过来压过被模板惩罚的池内句子，打分倒挂）。
        // 句子数 ≤ 池上限时池 = 全章、参照集 = 全章，与旧实现逐位一致。
        const baseScores = sentences.map((s, i) => this.#baseScore(s, {
            terms: sentenceTerms[i],
            docFreq,
            docCount: sentences.length,
            entityHits: entityHits[i].length,
        }));
        const poolOrder = baseScores
            .map((score, i) => ({ score, i }))
            .sort((a, b) => (b.score - a.score) || (a.i - b.i))
            .slice(0, Math.min(DIVERSITY_POOL, sentences.length))
            .map((x) => x.i);
        const poolSet = new Set(poolOrder);
        const { diversity, comparisons } = this.#poolDiversity({
            n: sentences.length,
            gramsList,
            poolOrder,
            poolSet,
        });

        const scored = sentences.map((s, i) => ({
            ...s,
            gramIndex: i,
            score: this.#score(s, {
                terms: sentenceTerms[i],
                docFreq,
                docCount: sentences.length,
                diversity: diversity[i],
                entityHits: entityHits[i].length,
            }),
        }));

        // 稳定排序：分数降序，位置升序（保证确定性）。
        // 只在池内选择：池外句子的 diversity 是中性值（无惩罚、满新颖度加成），
        // 若让它们参与竞争，会反过来压过被模板惩罚的池内句子（打分倒挂），
        // 摘要会被池外的同句式填充句重新占满。池 = 全章时（句子数 ≤ 上限）无任何影响。
        const byScore = scored
            .filter((s) => poolSet.has(s.gramIndex))
            .sort((a, b) => (b.score - a.score) || (a.msgIndex - b.msgIndex) || (a.sIndex - b.sIndex));

        const chosen = [];
        /** 已选句子的字符二元组集合，用于冗余抑制 */
        const chosenGrams = [];
        /** 被冗余抑制跳过的句子，第二遍按分数回填用 */
        const skipped = [];
        let used = 0;

        // 第一遍：优先选「多样化」的句子。
        //
        // 为什么必须有这一步：打分天然偏向「含词典实体 + 带引号对话 + 说话动词」
        // 的句子，而长篇角色扮演里大量楼层都是同一句式（「XX 沉默了一下，缓缓道：…」）。
        // 没有冗余抑制时，这些近乎重复的句子会靠高分把预算占满，
        // 真正有信息量的叙述句（伏笔埋设、情感转折、异常细节）反而被挤掉。
        for (const s of byScore) {
            const t = countTokens(s.text);
            if (used + t > targetTokens) continue;
            const grams = gramsList[s.gramIndex];
            if (chosenGrams.some((g) => jaccard(g, grams) >= REDUNDANCY_THRESHOLD)) {
                skipped.push({ s, t });
                continue;
            }
            chosen.push(s);
            chosenGrams.push(grams);
            used += t;
            if (used >= targetTokens * 0.98) break;
        }

        // 第二遍：预算仍有余量时，把被抑制的句子按分数回填。
        // 这样既保证多样化的信息句优先入选，又不浪费预算（内容多比少好）。
        if (used < targetTokens * 0.98) {
            for (const { s, t } of skipped) {
                if (used + t > targetTokens) continue;
                chosen.push(s);
                used += t;
                if (used >= targetTokens * 0.98) break;
            }
        }

        // 按原始顺序重组（保持叙事顺序）
        chosen.sort((a, b) => (a.msgIndex - b.msgIndex) || (a.sIndex - b.sIndex));
        const text = chosen.map((s) => s.text).join(' ');
        const sourceMessageIds = [...new Set(chosen.map((s) => s.messageId))];

        const entitiesKept = new Set();
        for (const s of chosen) {
            for (const name of findEntityHits(entityIndex, s.text)) entitiesKept.add(name);
        }

        return {
            text,
            sourceMessageIds,
            hash: contentFingerprint(text),
            tokens: countTokens(text),
            kept: chosen.length,
            total: sentences.length,
            entities: {
                kept: [...entitiesKept],
                missed: [...entitiesInSource].filter((e) => !entitiesKept.has(e)),
            },
            // 性能可观测性：两两比较次数。粗排池 × 整章参照集保证它 ≤ 240×600，
            // 与章节数量无关（旧实现对全章比较，11,674 句时 ≈ 700 万次）。
            stats: { sentences: sentences.length, poolSize: poolOrder.length, pairComparisons: comparisons },
            version: SUMMARIZER_VERSION,
        };
    }

    /**
     * 合并多个摘要：句子级并集 + 归一化去重，保持传入顺序（时间序）。
     * 不改写任何句子，因此合并不会引入漂移。
     */
    merge(summaries, opts = {}) {
        const targetTokens = opts.targetTokens ?? 600;
        const seen = new Set();
        const out = [];
        const sourceMessageIds = new Set();
        let used = 0;

        for (const summary of summaries) {
            for (const part of splitSentences(summary.text ?? '')) {
                const key = normalizeText(part.text).replace(/\s+/g, '');
                if (!key || seen.has(key)) continue;
                const t = countTokens(part.text);
                if (used + t > targetTokens) continue;
                seen.add(key);
                out.push(part.text);
                used += t;
            }
            for (const id of summary.sourceMessageIds ?? []) sourceMessageIds.add(id);
        }

        const text = out.join(' ');
        return {
            text,
            sourceMessageIds: [...sourceMessageIds],
            hash: contentFingerprint(text),
            tokens: countTokens(text),
            mergedFrom: summaries.map((s) => s.id).filter(Boolean),
            version: SUMMARIZER_VERSION,
        };
    }

    /**
     * 计算每个句子的「多样性」画像：
     *   - dupCount：与它相似度 ≥ 冗余阈值（同模板）的句子数量；
     *   - maxSim  ：与它最相似的那句的相似度。
     *
     * 这两个量是「模板句惩罚」与「新颖度加成」的依据。它们把打分从
     * 「谁命中更多关键词」拉回到「谁承载了别处没有的信息」——长篇角色扮演里
     * 模板句（「XX 沉默了一下，缓缓道：…」）会因为反复出现而被压分，
     * 而伏笔埋设、情感转折、异常细节这类只出现一次的叙述句会被抬上来。
     *
     * 复杂度 O(pool × refs)，两边都有界（240 × 600 = 144,000 次），与章节句数无关。
     */
    #poolDiversity({ n, gramsList, poolOrder, poolSet }) {
        // 参照集 = 整章均匀采样（与旧实现「每句 × 600 采样参照句」同一口径）。
        // 关键：不能只拿池内句子当参照 —— 大模板簇往往只有一两句挤进池，
        // 只对池内比较会把簇惩罚算成 0，HTML/评论这类整段复制的模板句反而翻身。
        const refStep = Math.max(1, Math.ceil(n / MAX_PAIRWISE_SENTENCES));
        const refIdx = [];
        for (let j = 0; j < n; j += refStep) refIdx.push(j);
        const refGrams = refIdx.map((i) => gramsList[i]);

        const diversity = new Array(n);
        let comparisons = 0;
        for (const i of poolOrder) {
            let dup = 0;
            let maxSim = 0;
            for (let k = 0; k < refIdx.length; k += 1) {
                if (refIdx[k] === i) continue;
                comparisons += 1;
                const sim = jaccard(gramsList[i], refGrams[k]);
                if (sim > maxSim) maxSim = sim;
                if (sim >= REDUNDANCY_THRESHOLD) dup += 1;
            }
            diversity[i] = { dupCount: dup, maxSim };
        }
        // 池外句子不参与选择，diversity 给中性值即可
        for (let i = 0; i < n; i += 1) {
            if (!poolSet.has(i)) diversity[i] = { dupCount: 0, maxSim: 0 };
        }
        return { diversity, comparisons };
    }

    #score(sentence, ctx) {
        const { terms, docFreq, docCount, diversity, entityHits } = ctx;
        const text = sentence.text;
        let score = this.#baseScore(sentence, { terms, docFreq, docCount, entityHits });

        // 模板簇惩罚：同一句式在本章反复出现 → 是叙事填充而非信息点。
        // 用 log 而非线性，避免「出现 20 次的句式和出现 3 次的句式」被拉开过大差距。
        if (diversity?.dupCount) score -= Math.log2(1 + diversity.dupCount) * TEMPLATE_PENALTY;

        // 新颖度加成：与全章其余句子都不相似的句子，最可能承载独有信息。
        score += (1 - (diversity?.maxSim ?? 0)) * NOVELTY_BONUS;

        return score;
    }

    /** 便宜信号（不依赖两两比较），同时用于粗排池选择与最终打分。 */
    #baseScore(sentence, ctx) {
        const { terms, docFreq, docCount, entityHits } = ctx;
        const text = sentence.text;
        let score = 0;

        // 词频信号
        const tf = new Map();
        for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
        let tfScore = 0;
        for (const [, count] of tf) tfScore += Math.log(1 + count);
        score += tfScore / Math.max(4, terms.length) * 3;

        // 稀有词（IDF）信号：这是区分「信息句」与「模板句」最有效的单一信号。
        //
        // 长篇角色扮演的模板句是「固定骨架 + 可替换槽位」（人名、地名、口头禅），
        // 槽位词在全章反复出现 → df 高 → IDF 低；而伏笔线索词（玉佩、断口、信物、
        // 旧伤）通常只在个别句子出现 → df=1 → IDF 最高。
        // 注意：字符级相似度做不到这件事——换掉槽位的模板句两两相似度只有 0.30~0.44，
        // 远低于任何可用的冗余阈值，所以必须靠词汇稀有度来识别。
        let rare = 0;
        const rareCut = Math.max(2, Math.floor(docCount * RARE_DF_RATIO));
        for (const term of new Set(terms)) {
            if ((docFreq.get(term) ?? 1) <= rareCut) rare += 1;
        }
        // 用 log 压缩并封顶，避免长句靠「词多」无限刷分（也防啰嗦的环境描写霸榜）。
        score += Math.log2(1 + Math.min(rare, RARE_TERM_CAP)) * RARE_TERM_WEIGHT;
        // 词典实体：每个命中的词典词各 +1.2（与旧实现逐词 includes 的口径一致）
        score += entityHits * 1.2;

        // 硬事实（日期/数字）
        if (hasHardFactSignal(text)) score += 1.0;

        // 对话与动作
        if (/[「『“"].*[」』”"]/.test(text)) score += 0.4;
        if (/(说|问|答|喊|叫|走|跑|看|拿|打|笑|哭)/.test(text)) score += 0.2;

        // 位置信号：段首/段尾更常含主题句
        if (sentence.sIndex === 0) score += 0.5;
        if (sentence.sIndex === sentence.sentenceCount - 1 && sentence.sentenceCount > 1) score += 0.25;

        // 长度惩罚：过短信息量低
        if (text.length < 8) score -= 0.5;

        // 叙事线索词：揭示/反转、情感转折、心理状态的通用标记。
        // 与抽取器的 reversal 规则保持同一口径，让「能被抽成记忆的句子」
        // 也更容易进摘要，两条通道的保真度一致。
        if (NARRATIVE_CUE.test(text)) score += NARRATIVE_CUE_BONUS;

        return score;
    }
}

/**
 * 句子「冗余度」判定阈值：字符二元组 Jaccard 相似度 ≥ 该值视为同一模板句。
 *
 * 0.55 是实测调参结果。依据（同模板换词句的实测相似度）：
 *   - 同一句式只换人名/地点：「（第 10 楼）我问他：“沈青崖到底把桂花糕来到了哪里了？”…」
 *     与「（第 12 楼）我问他：“林月到底把桂花糕得到了哪里了？”…」→ 约 0.67
 *   - 同一句式换角色：「沈青崖沉默了一下，缓缓道：…」之间 → 0.30~0.81
 *   - 有信息量的叙述句与模板句之间 → 通常 < 0.05
 * 阈值取 0.55 能稳定压住「换词不换句式」的模板句，又不会误伤正常句子
 * （曾用 0.72，结果 0.67 的模板句全部漏网、把摘要预算占满）。
 */
const REDUNDANCY_THRESHOLD = 0.55;

/**
 * 模板簇惩罚系数：同模板句每多一句，扣 log2(1+dupCount) × 该系数。
 *
 * 实测依据（`reports/回放/scratch/summarize-diag.mjs`，40 楼合成章节）：
 * 未加惩罚时，分数前 9 名全是同一句式的换词句（「我问他：XX 到底把 YY 拿哪里了？」，
 * 分数 5.38），把 400 token 预算占满，真正承载伏笔的叙述句（分数 4.76）排第 10 名被挤掉。
 * dupCount ≈ 8 时惩罚约 2.85，足以把模板句压到信息句之下。
 */
const TEMPLATE_PENALTY = 0.9;

/**
 * 新颖度加成系数：score += (1 - maxSim) × 该系数。
 *
 * maxSim 是「与全章最相似句」的相似度。模板句 maxSim 通常在 0.6~0.8，
 * 独有叙述句通常在 0.05 以下。取 1.2 时，独有句可拿到约 1.15 分加成、
 * 模板句只有约 0.24 分——足以让「不含任何关键词但信息独有」的句子翻身。
 */
const NOVELTY_BONUS = 1.2;

/**
 * 叙事线索词：揭示/反转、情感转折、心理状态的通用中文叙事标记。
 *
 * 与抽取器 `reversal` 规则（其实/原来/竟然/居然/没想到/才发现）同源，
 * 目的是让「能被抽成事实记忆的句子」也更容易进摘要，两条通道口径一致。
 * 刻意不含「沉默/笑/哭」这类过于泛化的词——它们在同模板句里也高频出现，
 * 加进来会抵消模板簇惩罚。
 */
const NARRATIVE_CUE = /其实|原来|竟然|居然|没想到|才发现|真相|秘密|终于|第一次|再也|不再|从此|渐渐|突然|忽然|心里|心头|眼眶|泪水|目光/;

/** 叙事线索词加成。 */
const NARRATIVE_CUE_BONUS = 0.6;

/** 逐对比较的句子数上限；超过则按固定步长采样参照集（保持确定性）。 */
const MAX_PAIRWISE_SENTENCES = 600;

/**
 * 参与两两比较的「粗排池」大小。
 *
 * 实测（真实 40 楼章节 / 324,593 字符 / 11,674 句，`reports/回放/scratch/real/`）：
 *   旧实现对全章每句比较 600 个采样参照句 → 单章 2.3~3.7 秒、同步阻塞事件循环
 *   4.4~5.0 秒（酒馆在这段时间完全无响应）。改为「便宜信号粗排选池 + 池内对照
 *   整章参照集比较」后，比较次数恒 ≤ 240 × 600 = 144,000，与章节数量无关，
 *   单章总耗时约 0.6~0.8 秒（主要剩切词/二元组/词典扫描）。
 *
 * 取 240 的依据：一次 400 token 的摘要至多选十几句，加上冗余回填与同簇邻居，
 * 240 已是入选需求的一到两个数量级冗余；句子数 ≤ 240 时池 = 全章、参照集 = 全章，
 * 与旧实现逐位一致。
 */
const DIVERSITY_POOL = 240;

/**
 * 稀有词加成系数与计数上限。
 *
 * 判定「稀有」的 df 门槛 = max(2, ⌊全章句子数 × RARE_DF_RATIO⌋)。
 * 实测（`reports/回放/scratch/rare-diag.mjs`，40 楼合成章节 / 98 句）：
 *   df 门槛 1 → 埋点句稀有词 36，模板句均值 1.4（max 2）
 *   df 门槛 2 → 埋点句 36，模板句 2.0（max 3）
 *   df 门槛 5 → 埋点句 36，模板句 5.5（max 11）   ← 门槛一松，模板句的槽位词也算「稀有」
 *   df 门槛 11 → 埋点句 39，模板句 13.4（max 17）  ← 区分度基本消失
 * 取 5% 落在「模板句 2~4」这一段，兼顾长短章节。
 * 加成为 log2(1 + min(rare, CAP)) × WEIGHT，CAP 防止长句靠词多刷分。
 */
const RARE_DF_RATIO = 0.05;
const RARE_TERM_WEIGHT = 1.1;
const RARE_TERM_CAP = 12;

/** 字符二元组集合（中英文都适用，不需要分词）。 */
function bigramSet(text) {
    const s = String(text);
    const out = new Set();
    if (s.length <= 1) {
        if (s) out.add(s);
        return out;
    }
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    // 尺寸短路：Jaccard ≤ min/max。当两边大小差到不可能达到阈值时直接判 0，
    // 免去遍历（对长短句混合的真实章节能省掉大部分比较）。
    if (Math.min(a.size, b.size) / Math.max(a.size, b.size) < REDUNDANCY_THRESHOLD) return 0;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter += 1;
    return inter / (a.size + b.size - inter);
}

// —— 词典实体命中的快速路径 ——
//
// 旧实现是「每句 × 每个词典词」的双重 includes 循环：真实章节 11,674 句 ×
// 词典 400 词 = 467 万次子串扫描，实测单章 80ms，而且粗排和终评各跑一遍。
// 这里按「词典词首字」建索引：某句连首字都没有的词，includes 必为假，
// 可直接跳过 —— 剪枝只跳过注定失败的比较，**语义与逐词 includes 完全等价**
// （包括「一个词命中就加一次分」「长词包含短词时两者都算」这些细节）。
function buildEntityIndex(dictionary) {
    const byFirst = new Map();
    for (const raw of dictionary ?? []) {
        const name = String(raw ?? '');
        if (!name) continue;
        const c = name[0];
        let list = byFirst.get(c);
        if (!list) { list = []; byFirst.set(c, list); }
        list.push(name);
    }
    return byFirst.size ? { byFirst } : null;
}

/** 返回文本命中的词典词数组（去重保持词典顺序）。 */
function findEntityHits(index, text) {
    if (!index) return [];
    const out = [];
    const chars = new Set(text);
    for (const [c, list] of index.byFirst) {
        if (!chars.has(c)) continue;
        for (const name of list) if (text.includes(name)) out.push(name);
    }
    return out;
}

/** 便捷函数：把消息数组摘要为记忆记录输入。 */
export function buildSummaryRecord(summary, { scope, chatId, branchId, kind = 'summary_chapter', sourceRevision = null }) {
    return {
        kind,
        scope,
        chatId,
        branchId,
        content: summary.text,
        sourceMessageIds: summary.sourceMessageIds,
        sourceRevision,
        confidence: 0.85,
        importance: 0.7,
        status: 'confirmed',
        derivation: { method: 'extractive', version: SUMMARIZER_VERSION },
        hash: summary.hash,
    };
}
