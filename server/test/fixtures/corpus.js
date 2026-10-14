/**
 * 长聊回放语料生成器（确定性）。
 *
 * 覆盖需求 3.4 的场景：中文长剧情、用户纠正、剧情反转、时间线、
 * 分支、工具长结果、附件、模型切换与上下文上限变化。
 * 植入的关键事实用于验证：压缩后保留/正确召回率 ≥ 90%、事实矛盾率 ≤ 5%。
 */

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ACTIONS = [
    '林月握紧剑柄，目光扫过雾气弥漫的街道。',
    '沈青崖沉默片刻，抬手拨开额前的碎发。',
    '阿澈蹲在屋檐上，嘴里叼着一根草茎。',
    '风穿过云栖镇的石巷，卷起几片枯叶。',
    '远处传来钟声，惊起一群归巢的鸦鸟。',
    '炉火噼啪作响，茶香在屋内缓缓散开。',
    '龙渊剑在鞘中轻轻震动，仿佛感应到了什么。',
    '夜色渐深，山影如墨般压在镇子北面。',
];

const DIALOGUES = [
    '「你今天的话比平时少。」林月说。',
    '「有些事，说出来就回不了头了。」沈青崖答道。',
    '「哥，你又在偷偷练剑？」阿澈笑嘻嘻地问。',
    '「镇上的米价又涨了，」掌柜叹气，「这日子难熬啊。」',
    '「别担心，我答应过的事，一定会做到。」',
    '「明天的祭典，你会来吗？」',
    '「剑不是用来出气的，」师父说，「是用来守住想守的东西。」',
    '「我总觉得，有人在盯着我们。」',
];

/**
 * 生成回放语料。
 * @param {{ floors?: number, seed?: number, chatId?: string }} opts
 */
export function generateCorpus(opts = {}) {
    const floors = opts.floors ?? 1000;
    const rand = mulberry32(opts.seed ?? 42);
    const messages = [];
    const keyFacts = [];

    const plant = (floor, text, { isUser = false } = {}) => {
        messages.push({
            floorIndex: floor,
            content: text,
            isUser,
            isSystem: false,
            name: isUser ? '你' : '叙述者',
            // 秒数带上 floor%60：否则植入消息恒为 ":00"，会与填充消息
            // （同为某楼 %24 小时 + %60 分钟）碰撞，导致身份自然键合并（回放数少 1）。
            sendDate: `2026-01-${String(1 + Math.floor(floor / 100)).padStart(2, '0')}T${String(floor % 24).padStart(2, '0')}:${String(floor % 60).padStart(2, '0')}:00.000Z`,
            swipeId: 0,
        });
    };

    // ---- 关键事实植入点（前 200 楼）----
    plant(2, '你告诉叙述者：我叫林月，是个剑客。', { isUser: true });
    plant(4, '沈青崖自称是林月的师父，他住在云栖镇东边的老宅里。');
    plant(9, '林月的佩剑名叫龙渊剑，剑身上刻着七颗星纹。');
    plant(14, '阿澈是林月的弟弟，今年十二岁，最喜欢吃桂花糕。');
    plant(20, '云栖镇位于苍梧山脚下，镇口有一棵三百年的老槐树。');
    plant(28, '记住：林月不喜欢别人碰她的剑。', { isUser: true });
    plant(35, '三年前的冬天，云栖镇被一场大火烧毁了半条街。');
    plant(48, '沈青崖的左手有一道旧伤，是当年救林月时留下的。');
    plant(66, '林月此行要找到失落的霜华剑鞘，那是她母亲的遗物。', { isUser: true });
    plant(80, '镇上的药铺掌柜叫周伯，是个话痨，消息灵通。');
    plant(120, '林月已经收集到三枚星纹石，还差最后一枚。');
    plant(160, '阿澈偷偷把龙渊剑拿去磨了，林月发现后非常生气。');
    plant(200, '师父叮嘱：星纹石藏在苍梧山的寒潭底下。');

    // ---- 剧情反转（中段）----
    plant(420, '其实沈青崖的真实身份是前任城主，他隐姓埋名已经二十年。');
    plant(430, '原来当年的大火并非意外，而是有人故意纵火，目标是城主府。');
    plant(560, '没想到周伯年轻时竟是城主府的护卫，他认出了沈青崖。');

    // ---- 用户纠正（后段）：旧事实必须立即失效 ----
    plant(700, '记住：林月的佩剑不是龙渊剑，而是霜华剑，龙渊剑是师父的。', { isUser: true });
    plant(702, '林月把龙渊剑还给了师父，换回了属于自己的霜华剑。');

    // ---- 未完成目标 / 悬念 ----
    plant(820, '林月还没找到最后一枚星纹石，寒潭的入口被冰封住了。');
    plant(900, '阿澈发誓要亲手查明纵火的真相。');

    keyFacts.push(
        { id: 'F1', question: '林月是谁？', expect: '剑客', plantedAt: 2, kind: 'entity' },
        { id: 'F2', question: '沈青崖住在哪里？', expect: '云栖镇', plantedAt: 4, kind: 'fact' },
        { id: 'F3', question: '林月的佩剑现在叫什么名字？', expect: '霜华剑', plantedAt: 700, kind: 'fact', supersedes: 'F3-old' },
        { id: 'F3-old', question: '林月最初的佩剑叫什么？', expect: '龙渊剑', plantedAt: 9, kind: 'fact' },
        { id: 'F4', question: '阿澈和林月是什么关系？', expect: '弟弟', plantedAt: 14, kind: 'relation' },
        { id: 'F5', question: '云栖镇在哪里？', expect: '苍梧山', plantedAt: 20, kind: 'fact' },
        { id: 'F6', question: '林月有什么不喜欢的事？', expect: '不喜欢别人碰她的剑', plantedAt: 28, kind: 'preference' },
        { id: 'F7', question: '三年前的冬天云栖镇发生了什么？', expect: '大火', plantedAt: 35, kind: 'timeline' },
        { id: 'F8', question: '沈青崖左手上的旧伤是怎么来的？', expect: '救林月', plantedAt: 48, kind: 'fact' },
        { id: 'F9', question: '林月此行要找到什么？', expect: '霜华剑鞘', plantedAt: 66, kind: 'goal' },
        { id: 'F10', question: '药铺掌柜叫什么？', expect: '周伯', plantedAt: 80, kind: 'entity' },
        { id: 'F11', question: '林月还差几枚星纹石？', expect: '最后一枚', plantedAt: 120, kind: 'goal' },
        { id: 'F12', question: '星纹石藏在哪里？', expect: '寒潭', plantedAt: 200, kind: 'fact' },
        { id: 'F13', question: '沈青崖的真实身份是什么？', expect: '前任城主', plantedAt: 420, kind: 'timeline' },
        { id: 'F14', question: '当年的大火是怎么发生的？', expect: '故意纵火', plantedAt: 430, kind: 'timeline' },
        { id: 'F15', question: '周伯年轻时是什么身份？', expect: '城主府的护卫', plantedAt: 560, kind: 'fact' },
        { id: 'F16', question: '阿澈发誓要做什么？', expect: '查明纵火的真相', plantedAt: 900, kind: 'goal' },
        { id: 'F17', question: '寒潭的入口怎么了？', expect: '冰封', plantedAt: 820, kind: 'fact' },
    );

    // ---- 填充对话（覆盖 0..floors-1，跳过已植入楼层）----
    const plantedFloors = new Set(messages.map((m) => m.floorIndex));
    const filled = [];
    for (let floor = 0; floor < floors; floor += 1) {
        if (plantedFloors.has(floor)) {
            filled.push(messages.find((m) => m.floorIndex === floor));
            continue;
        }
        const isUser = floor % 2 === 1;
        const r = rand();
        let content;
        if (isUser) {
            content = [
                '我环顾四周，想看看有没有人跟踪。',
                '我把剑放在桌上，问师父最近有没有什么消息。',
                '阿澈又跑去集市了，我去把他找回来。',
                '我在想，那枚星纹石到底藏在什么地方。',
                '我有点累了，今晚就在客栈休息吧。',
                '师父，你当年为什么要救我？',
                '明天我们出发去苍梧山。',
                '我总觉得周伯知道些什么。',
            ][Math.floor(r * 8)];
        } else {
            content = r < 0.5
                ? ACTIONS[Math.floor(rand() * ACTIONS.length)]
                : DIALOGUES[Math.floor(rand() * DIALOGUES.length)];
            if (rand() < 0.18) {
                content += `（第 ${floor} 楼：${ACTIONS[Math.floor(rand() * ACTIONS.length)]}）`;
            }
        }
        filled.push({
            floorIndex: floor,
            content,
            isUser,
            isSystem: false,
            name: isUser ? '你' : '叙述者',
            sendDate: `2026-01-${String(1 + Math.floor(floor / 100)).padStart(2, '0')}T${String(floor % 24).padStart(2, '0')}:${String(floor % 60).padStart(2, '0')}:00.000Z`,
            swipeId: 0,
        });
    }

    // 工具长结果与附件（覆盖工具/附件路径）
    filled.push({
        floorIndex: floors,
        content: '[attachment: 地图.png] 一张标注了苍梧山北麓水系的旧地图。',
        isUser: true, isSystem: false, name: '你',
        sendDate: '2026-02-01T00:00:00.000Z', swipeId: 0,
    });
    filled.push({
        floorIndex: floors + 1,
        content: `工具结果：地图解析完成。识别到 3 处水潭，其中寒潭位于北纬 34.2 度。${'（详细坐标数据略）'.repeat(40)}`,
        isUser: false, isSystem: false, name: '工具', role: 'tool',
        sendDate: '2026-02-01T00:01:00.000Z', swipeId: 0,
    });

    filled.sort((a, b) => a.floorIndex - b.floorIndex);
    return { messages: filled, keyFacts, floors };
}

/** 从语料中取前 n 楼作为“回放前缀”。 */
export function sliceCorpus(corpus, n) {
    return corpus.messages.filter((m) => m.floorIndex < n);
}
