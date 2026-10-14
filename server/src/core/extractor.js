/**
 * 规则抽取器：从消息中抽取候选记忆（无模型、确定性、可解释）。
 *
 * 需求 2.5：后台抽取不可变锚点、偏好、人物/地点/物品/关系/状态、章节摘要、
 * 未完成目标、时间线事件、工具结论等候选记忆。
 *
 * 本实现是规则模式（默认、零外部 API）：
 *   - 只摘录原文句子（抽取式），不改写、不编造；
 *   - 每条候选带来源消息、置信度、重要度和生成方式；
 *   - 低置信度停留 candidate，冲突由 MemoryService.registerConflict 处理。
 */

import { extractTimeSignals } from '../util/text.js';
import { EXTRACTOR_VERSION } from '../config.js';

const MAX_CONTENT = 240;

/** 规则表：模式 → 候选类型与置信度 */
const RULES = [
    {
        name: 'explicit-remember',
        kind: 'anchor',
        confidence: 0.95,
        importance: 0.95,
        userOnly: true,
        test: (t) => /(记住|请记住|记下|别忘了|不要忘记|别忘记|永远记住|务必记住)/.test(t),
    },
    {
        name: 'user-preference',
        kind: 'preference',
        confidence: 0.85,
        importance: 0.8,
        userOnly: true,
        test: (t) => /(我喜欢|我不喜欢|我讨厌|我偏好|我更愿意|我习惯|我从不|我一向|我希望你)/.test(t),
    },
    {
        name: 'identity',
        kind: 'entity',
        confidence: 0.8,
        importance: 0.75,
        test: (t) => /(我叫|我的名字是|我的名字叫|我是|他叫|她叫|他名叫|她名叫|名叫|叫做|被称为)/.test(t),
    },
    {
        name: 'location',
        kind: 'fact',
        confidence: 0.7,
        importance: 0.65,
        test: (t) => /(住在|居住在|位于|坐落于|来自|出生于|前往|来到|抵达)/.test(t),
    },
    {
        name: 'possession',
        kind: 'fact',
        confidence: 0.7,
        importance: 0.65,
        test: (t) => /(拥有|获得了|得到了|拿到|持有|随身带着|失去了|丢掉了|被夺走|被偷走|交给)/.test(t),
    },
    {
        name: 'relation',
        kind: 'relation',
        confidence: 0.72,
        importance: 0.7,
        test: (t) => /(的朋友|的敌人|的师父|的徒弟|的师父|的妻子|的丈夫|的妹妹|的哥哥|的姐姐|的弟弟|的上司|的下属|的未婚妻|的未婚夫|的同伴|的搭档|的儿子|的女儿|的父亲|的母亲|是兄妹|是姐弟)/.test(t),
    },
    {
        name: 'state-change',
        kind: 'fact',
        confidence: 0.62,
        importance: 0.6,
        test: (t) => /(现在|已经|从此|再也不|恢复|变成了|成为了|受了伤|痊愈|中毒|解除了)/.test(t),
    },
    {
        // 情感 / 关系转折。
        //
        // 为什么单列一条：长篇角色扮演里「关系变化」大多靠**神态与动作暗示**
        // （「冷冷地别过脸去」「第一次对他笑了」），而不是「变成了」这类显式措辞。
        // 实测 3000 楼语料里 8 个情感/伏笔埋点，state-change 只捞到 1 个，
        // 「别过脸」这类典型转折句完全漏掉——而它们恰恰是用户最在意的那类记忆。
        // 词表刻意只收「关系信号」而非泛化情绪词（如「开心/难过」），避免噪音。
        name: 'emotion-shift',
        kind: 'fact',
        confidence: 0.62,
        importance: 0.75,
        test: (t) => /(第一次对他|第一次对她|第一次对我|对他笑了|对她笑了|别过脸|冷冷地|不再设防|不再处处设防|放下了戒心|态度|信任|戒备|敌意|心软|动摇|愧疚|心疼|松了一口气)/.test(t),
    },
    {
        name: 'goal',
        kind: 'goal',
        confidence: 0.6,
        importance: 0.7,
        test: (t) => /(打算|计划|准备|必须|需要|发誓|决心|目标是|任务是把|一定要|想要去|还得去|还没|尚未|没有完成|未完成)/.test(t),
    },
    {
        name: 'reversal',
        kind: 'timeline',
        confidence: 0.65,
        importance: 0.8,
        test: (t) => /(其实|原来|真相是|竟然是|没想到|居然是|事实上|实际上|伪装|真实身份)/.test(t),
    },
];

const ATTACHMENT_RE = /\[(img|image|file|attachment|附件|图片)[^\]]*\]/i;

/**
 * @param {{ messages: Array<{messageId, content, isUser, isSystem, role, speakerName, floorIndex}>,
 *           scope: string, chatId?: string, branchId?: string,
 *           dictionary?: string[], existingFacts?: object[], now?: Date }} input
 * @returns {Array<object>} 候选记忆（未落库）
 */
export function extractCandidates(input) {
    const messages = input.messages ?? [];
    const out = [];
    const seen = new Set();

    // 模板文本检测：状态栏 / 世界书注入 / 开场标签等「结构化模板」不是剧情事实。
    // 只认结构性标记（包裹符号、模板前缀、HTML 标签密度），不做语义判断——
    // 句子级「同句式换词」的模板识别已被证明不可行（见 D33 实测）。
    const TEMPLATE_PATTERNS = [
        /^\s*:::/,                       // :::newspaper 等模板头
        /^\s*\[[^\]\n]{2,40}\]\s*$/,     // 整行方括号标签（[Start a new chat] 等）
        /^\s*</,                         // <div>/<疏珩修正> 等尖括号开头
        /<(div|span|table|details|summary|br|p)\b/i, // HTML 标签密度
    ];
    const isTemplateSentence = (s) => {
        const t = s.trim();
        if (!t) return false;
        // 整句被【】包裹（状态栏/系统提示的典型形态）
        if (t.startsWith('【') && t.endsWith('】')) return true;
        return TEMPLATE_PATTERNS.some((re) => re.test(t));
    };
    const isTemplateMessage = (t) => {
        const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
        if (!lines.length) return true;
        // 超过一半的行是模板结构 → 整条消息（多为注入的模板/状态栏）不作为记忆来源
        const hit = lines.filter((l) => isTemplateSentence(l) || TEMPLATE_PATTERNS.some((re) => re.test(l))).length;
        return hit / lines.length >= 0.5;
    };

    for (const msg of messages) {
        let text = String(msg.content ?? '');
        if (!text.trim()) continue;
        if (msg.isSystem) continue; // 系统消息不作为记忆来源

        // 推理标签剥离：<think>/<thinking>/<thought>/<reasoning> 的内容是模型的思考过程，
        // 不是剧情事实——剥掉后正文照常抽取（很多 AI 回复是「think + 正文」混合）；
        // 整条都是 think 的消息剥离后为空，自然被跳过
        text = text.replace(/<(think|thinking|thought|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').trim();
        if (!text.trim()) continue;
        if (isTemplateMessage(text)) continue; // 状态栏/世界书注入模板不是剧情事实

        // 工具结果：结构化结论候选
        if (msg.role === 'tool') {
            pushCandidate(out, seen, {
                kind: 'tool_result',
                content: clip(text),
                confidence: 0.8,
                importance: 0.6,
                sourceMessageIds: [msg.messageId],
                derivation: { method: 'rule', rule: 'tool-result', version: EXTRACTOR_VERSION },
            });
            continue;
        }

        // 附件占位：只保存引用，不把无法验证的内容当成文字事实
        const attach = text.match(ATTACHMENT_RE);
        if (attach) {
            pushCandidate(out, seen, {
                kind: 'attachment',
                content: clip(attach[0]),
                confidence: 0.9,
                importance: 0.3,
                sourceMessageIds: [msg.messageId],
                derivation: { method: 'rule', rule: 'attachment-placeholder', version: EXTRACTOR_VERSION },
            });
        }

        const sentences = splitSentencesLite(text);
        for (const sentence of sentences) {
            if (sentence.length < 4) continue;

            // 时间线信号
            const timeSignals = extractTimeSignals(sentence);
            if (timeSignals.length) {
                pushCandidate(out, seen, {
                    kind: 'timeline',
                    content: clip(sentence),
                    confidence: 0.68,
                    importance: 0.65,
                    sourceMessageIds: [msg.messageId],
                    structured: { timeSignals },
                    derivation: { method: 'rule', rule: 'time-signal', version: EXTRACTOR_VERSION },
                });
            }

            for (const rule of RULES) {
                if (rule.userOnly && !msg.isUser) continue;
                if (!rule.test(sentence)) continue;
                pushCandidate(out, seen, {
                    kind: rule.kind,
                    content: clip(sentence),
                    confidence: msg.isUser ? rule.confidence : Math.max(0.5, rule.confidence - 0.1),
                    importance: rule.importance,
                    sourceMessageIds: [msg.messageId],
                    structured: buildSlot(sentence, rule, input.dictionary ?? []),
                    derivation: { method: 'rule', rule: rule.name, version: EXTRACTOR_VERSION },
                });
            }
        }
    }

    return out;
}

function pushCandidate(out, seen, candidate) {
    const key = `${candidate.kind}|${candidate.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
        validFrom: null,
        validTo: null,
        status: 'candidate',
        sensitivity: 'normal',
        ...candidate,
    });
}

function clip(text) {
    const s = String(text).trim();
    return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s;
}

function splitSentencesLite(text) {
    return String(text)
        .split(/(?<=[。！？!?…\n])/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 抽取 (subject, attribute, value) 槽位，用于冲突检测。
 * 只有当主语能确定为词典实体时才产出槽位（避免错误归并）。
 */
function buildSlot(sentence, rule, dictionary) {
    const subject = findSubject(sentence, dictionary);
    if (!subject) return null;
    const attributeMap = {
        location: 'location',
        possession: 'possession',
        identity: 'identity',
        relation: 'relation',
        'state-change': 'state',
    };
    const attribute = attributeMap[rule.name];
    if (!attribute) return null;
    const value = sentence
        .replace(new RegExp(`^.*?${escapeRegExp(subject)}`), '')
        .replace(/[。！？!?…]$/, '')
        .trim()
        .slice(0, 120);
    if (!value) return null;
    return { subject, attribute, value };
}

function findSubject(sentence, dictionary) {
    for (const name of dictionary) {
        if (name && name.length >= 1 && sentence.includes(name)) return name;
    }
    return null;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 冲突检测：同一 (subject, attribute) 已有不同 value 的活跃记录。
 * @returns {Array<{existingId: string, detail: string}>}
 */
export function detectConflicts(candidate, existingRecords) {
    if (!candidate.structured?.subject || !candidate.structured?.attribute) return [];
    const hits = [];
    for (const rec of existingRecords) {
        if (!rec.structured?.subject) continue;
        if (rec.structured.subject !== candidate.structured.subject) continue;
        if (rec.structured.attribute !== candidate.structured.attribute) continue;
        if (rec.structured.value === candidate.structured.value) continue;
        if (['archived', 'superseded', 'expired'].includes(rec.status)) continue;
        hits.push({
            existingId: rec.id,
            detail: `${rec.structured.subject}.${rec.structured.attribute}: "${rec.structured.value}" ↔ "${candidate.structured.value}"`,
        });
    }
    return hits;
}

/** 词典词抽取：从文本中识别人名/物品/地点的候选词（供实体词典增补）。 */
export function extractDictionaryTerms(text) {
    const terms = new Set();
    const patterns = [
        /(?:名叫|叫做|称为|被称为)([^\s，。！？、]{1,12})/g,
        /(?:^|[，。！？\s])([一-鿿]{2,4})(?:说|道|问|答|笑|喊|叫)/g,
        /「([^」]{1,12})」/g,
        /《([^》]{1,20})》/g,
    ];
    for (const re of patterns) {
        for (const m of String(text).matchAll(re)) {
            const term = m[1]?.trim();
            if (term && term.length >= 1 && term.length <= 20) terms.add(term);
        }
    }
    return [...terms];
}
