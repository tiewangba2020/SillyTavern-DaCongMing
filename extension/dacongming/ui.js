/**
 * 大聪明 UI：主面板（单个折叠块）+ 记忆中心。
 * 纯 DOM 构建，不依赖模板文件，兼容不同 SillyTavern 版本。
 *
 * 设计约定：
 *   - 主面板只占「一行」，展开后是分区清楚的一屏设置（不搞多层嵌套抽屉）；
 *   - 标签在上、控件在下（窄面板里中文标签不会被挤成竖排）；
 *   - 所有按钮/标签页强制不换行（ST 主题里 flex 容器会把中文压成竖排）。
 */

export const TIER_LABELS = {
    fidelity: '保真优先',
    balanced: '均衡（默认）',
    saving: '节省用量',
    custom: '自定义…',
};

export const PRIVACY_LABELS = {
    'local-only': '仅本地处理（规则/SQLite/关键词，不发送内容到外部）',
    'reuse-st': '复用当前 SillyTavern 连接（通过 ST 请求通道发送摘要任务）',
    dedicated: '独立服务连接（需另行提供端点与凭据）',
};

export const STATUS_STYLES = {
    正常: { color: '#2e7d32', icon: '●' },
    后台处理中: { color: '#1565c0', icon: '◐' },
    已降级: { color: '#ef6c00', icon: '▲' },
    需要处理: { color: '#c62828', icon: '■' },
};

export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

/**
 * SillyTavern 原生折叠抽屉（开合由 ST 的事件委托处理，无需自写逻辑）。
 * @param {{ title: string, hintNode?: Node, hint?: string, note?: string }} options
 */
export function drawer({ title, hintNode = null, hint = '', note = '' }) {
    const hintSpan = el('span', { class: 'dcm-hint', text: hint });
    if (hintNode) {
        hintSpan.append(hintNode);
        hintSpan.style.display = '';
    } else {
        hintSpan.style.display = hint ? '' : 'none';
    }
    const icon = el('div', { class: 'fa-solid fa-circle-chevron-down inline-drawer-icon down' });
    const titleBox = el('span', { class: 'dcm-drawer-titlebox' }, [
        el('span', { class: 'dcm-drawer-title', text: title }),
        note ? el('span', { class: 'dcm-drawer-note', text: note }) : null,
    ]);
    const header = el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [titleBox, hintSpan, icon]);
    // 注意：display 必须留给 ST 控制（.inline-drawer-content{display:none} 是收起态），
    // 内部再包一层做 flex 布局，避免把收起态覆盖掉。
    const body = el('div', { class: 'dcm-drawer-body' });
    const content = el('div', { class: 'inline-drawer-content' }, [body]);
    const root = el('div', { class: 'inline-drawer' }, [header, content]);

    const setHint = (text) => {
        if (hintNode) return;
        hintSpan.textContent = text ?? '';
        hintSpan.style.display = text ? '' : 'none';
    };

    return { root, content: body, setHint };
}

/** 一行设置项：标签在上、控件在下。 */
function field(label, control, hint) {
    return el('div', { class: 'dcm-field' }, [
        el('div', { class: 'dcm-field-label', text: label }),
        control,
        hint ? el('div', { class: 'dcm-field-hint', text: hint }) : null,
    ]);
}

/** 内容分区：小标题 + 若干行。 */
function block(title, children) {
    return el('div', { class: 'dcm-block' }, [
        el('div', { class: 'dcm-block-title', text: title }),
        ...[].concat(children).filter(Boolean),
    ]);
}

/** 主面板：单个折叠块（收起时只占一行）。 */
export function buildMainPanel(handlers) {
    const root = el('div', { class: 'dcm-panel' });

    // 收起时也能看到状态：放在抽屉标题右侧
    const statusDot = el('span', { class: 'dcm-status-dot' });
    const statusText = el('span', { class: 'dcm-status-text', id: 'dcm-status-text', text: '未连接' });
    const headerStatus = el('span', { class: 'dcm-status-inline' }, [statusDot, statusText]);

    const main = drawer({
        title: '大聪明 · 记忆与上下文压缩',
        hintNode: headerStatus,
    });
    const ui = main.content;

    // ── 顶部：总开关 + 状态详情 ──
    const autoToggle = el('input', { type: 'checkbox', id: 'dcm-auto-manage' });
    autoToggle.addEventListener('change', () => handlers.onAutoManage(autoToggle.checked));
    const statusReason = el('div', { class: 'dcm-status-reason', id: 'dcm-status-reason', text: '尚未连接服务' });
    const fixBox = el('div', { class: 'dcm-fix-box', id: 'dcm-fix-box' });

    ui.append(el('div', { class: 'dcm-switchcard' }, [
        el('label', { class: 'dcm-auto' }, [
            el('span', { class: 'dcm-switch' }, [autoToggle, el('span', { class: 'dcm-slider' })]),
            el('span', { class: 'dcm-auto-text' }, [
                el('span', { class: 'dcm-auto-label', text: '自动管理' }),
                el('span', { class: 'dcm-auto-hint', text: '开启后自动记录、压缩、召回和维护记忆' }),
            ]),
        ]),
        statusReason,
        fixBox,
    ]));

    // ── 分区 1：记忆与压缩 ──
    const inlineCenterBody = el('div', { id: 'dcm-inline-center-body' });
    const tierSelect = el('select', { id: 'dcm-tier' },
        Object.entries(TIER_LABELS).map(([value, label]) => el('option', { value }, [label])));
    tierSelect.addEventListener('change', () => handlers.onTier(tierSelect.value));

    // 自定义档位参数表单（tier=custom 时显示）
    const ctField = (label, id, attrs, hint) => el('div', { class: 'dcm-field' }, [
        el('div', { class: 'dcm-field-label', text: label }),
        el('input', { type: 'number', id, class: 'text_input', ...attrs }),
        hint ? el('div', { class: 'dcm-field-hint', text: hint }) : null,
    ].filter(Boolean));
    const ctTrigger = ctField('触发比例（占可用窗口）', 'dcm-ct-trigger', { min: '0.3', max: '0.95', step: '0.05' },
        '上下文总量超过「可用窗口 × 此比例」即开始压缩。0.4 ≈ 保守早压，0.85 ≈ 拖到快满才压。');
    const ctRecallTopK = ctField('召回条数上限', 'dcm-ct-recalltopk', { min: '0', max: '32', step: '1' },
        '每轮最多注入几条定向召回。');
    const ctRecallFloor = ctField('召回保底（占可用窗口）', 'dcm-ct-recallfloor', { min: '0', max: '0.2', step: '0.01' },
        '预算再紧张也保留的最高分召回配额。0 = 允许全部丢弃。');
    const ctSummary = ctField('摘要预算（占可用窗口）', 'dcm-ct-summary', { min: '0.02', max: '0.5', step: '0.02' },
        '章节摘要允许占用的 token 上限。');
    const ctRecentMin = ctField('最近窗口保底（楼）', 'dcm-ct-recentmin', { min: '0', max: '50', step: '1' },
        '无论如何压缩，最近原文至少保留几楼。');
    const ctSaveBtn = el('button', { class: 'menu_button', text: '保存自定义参数' });
    ctSaveBtn.addEventListener('click', () => handlers.onSaveCustomTier({
        triggerRatio: Number(ctTrigger.value) || 0.75,
        recallTopK: Number(ctRecallTopK.value) || 0,
        recallFloorRatio: Number(ctRecallFloor.value) || 0,
        summaryTargetRatio: Number(ctSummary.value) || 0.18,
        recentFloorMin: Number(ctRecentMin.value) || 0,
    }));
    const customTierBox = el('div', { class: 'dcm-custom-tier', id: 'dcm-custom-tier' }, [
        ctTrigger, ctRecallTopK, ctRecallFloor, ctSummary, ctRecentMin,
        el('div', { class: 'dcm-btn-row' }, [ctSaveBtn]),
        el('div', { class: 'dcm-field-hint', text: '保存后自动切换到「自定义」档并立即生效（参数有安全夹取：比例 0.3~0.95 等）。' }),
    ]);
    customTierBox.style.display = 'none';
    const summaryBox = el('div', { class: 'dcm-summary', id: 'dcm-summary' });
    const centerBtn = el('button', { class: 'menu_button dcm-center-btn', text: '打开记忆中心' });
    centerBtn.addEventListener('click', () => handlers.onOpenCenter());
    ui.append(block('记忆与压缩', [
        field('目标档位', tierSelect, '档位只改变触发时机与注入量，不改变隐私许可、原始聊天留存或作用域边界。'),
        customTierBox,
        summaryBox,
        el('div', { class: 'dcm-btn-row' }, [centerBtn]),
        // 内嵌记忆中心：折叠面板，展开即加载（与模态共用同一套渲染逻辑）
        el('details', { class: 'dcm-inline-center', id: 'dcm-inline-center' }, [
            el('summary', { text: '记忆中心（内嵌）' }),
            inlineCenterBody,
        ]),
    ]));

    // ── 分区 2：隐私与授权 ──
    const privacySelect = el('select', { id: 'dcm-privacy' },
        Object.entries(PRIVACY_LABELS).map(([value, label]) => el('option', { value }, [label])));
    privacySelect.addEventListener('change', () => handlers.onPrivacy(privacySelect.value));
    const toggles = {};
    // [字段, 名称, 生效条件说明]；有说明的表示当前版本无法直接生效，需要如实标注
    const toggleDefs = [
        ['allowJev', 'TypeSafe Jev 门控', '在下方「高级设置 · TypeSafe Jev」里配置端点后才会生效'],
        ['allowRemoteEmbedding', '远程 Embedding', '本版本未实现，打开不会有任何效果'],
        ['allowCloudSync', '云同步', '本版本未实现，打开不会有任何效果'],
        ['allowTelemetry', '遥测', '本版本无任何遥测代码，恒为关闭'],
    ];
    const toggleGrid = el('div', { class: 'dcm-toggle-grid' });
    for (const [key, label, note] of toggleDefs) {
        const input = el('input', { type: 'checkbox', id: `dcm-toggle-${key}` });
        // 未实现的能力不允许在界面上打开，避免「开了没反应」被当成故障
        if (note && key !== 'allowJev') input.disabled = true;
        input.addEventListener('change', () => handlers.onToggle(key, input.checked));
        toggles[key] = input;
        toggleGrid.append(el('label', { class: 'dcm-checkbox-row', title: note ?? '' }, [
            input,
            el('span', {}, [
                el('span', { class: 'dcm-toggle-name', text: label }),
                note ? el('span', { class: 'dcm-toggle-note', text: ` — ${note}` }) : null,
            ].filter(Boolean)),
        ]));
    }
    ui.append(block('隐私与授权', [
        field('隐私许可', privacySelect, '仅本地处理时，不会向外部摘要、Jev、Embedding 或遥测服务发送任何内容。'),
        el('div', { class: 'dcm-field-label dcm-mt8', text: '可选的独立开关' }),
        toggleGrid,
        el('div', { class: 'dcm-field-hint', text: '灰显的开关表示该能力尚未实现，标注在名称后；这样界面不会承诺做不到的事。' }),
    ]));

    // ── 分区 3：高级设置 · TypeSafe Jev ──
    const jevEndpoint = el('input', { type: 'text', id: 'dcm-jev-endpoint', class: 'text_input',
        placeholder: 'https://…（留空 = 不启用 Jev）', autocomplete: 'off' });
    const jevApiKey = el('input', { type: 'password', id: 'dcm-jev-apikey', class: 'text_input',
        placeholder: '端点需要鉴权时填写', autocomplete: 'new-password' });
    const jevModel = el('input', { type: 'text', id: 'dcm-jev-model', class: 'text_input', autocomplete: 'off' });
    const jevTimeoutMs = el('input', { type: 'number', id: 'dcm-jev-timeout', class: 'text_input',
        min: '1000', max: '30000', step: '500' });
    const jevMinConfidence = el('input', { type: 'number', id: 'dcm-jev-minconf', class: 'text_input',
        min: '0', max: '1', step: '0.05' });
    const jevSaveBtn = el('button', { class: 'menu_button', text: '保存 Jev 设置' });
    jevSaveBtn.addEventListener('click', () => handlers.onSaveJev({
        jevEndpoint: jevEndpoint.value.trim(),
        jevApiKey: jevApiKey.value,
        jevModel: jevModel.value.trim() || 'system-one',
        jevTimeoutMs: Math.min(30000, Math.max(1000, Number(jevTimeoutMs.value) || 8000)),
        jevMinConfidence: Math.min(1, Math.max(0, Number(jevMinConfidence.value) || 0.4)),
    }));
    ui.append(block('高级设置 · TypeSafe Jev', [
        field('决策端点 URL', jevEndpoint, '端点需接受 POST {model, state, questions} 并返回 {answers:{…}}；' +
            '为空时即使打开「Jev 门控」也只走本地规则计划。'),
        field('API Key（可选）', jevApiKey, '仅保存在本机（浏览器扩展设置与服务端 data/settings.json），不会出现在日志里。'),
        field('模型名', jevModel, '随请求体中的 model 字段发送，默认 system-one。'),
        field('超时（毫秒）', jevTimeoutMs, '超时、429、低置信度或结构错误都会自动回退规则计划；连续失败 3 次自动停用 5 分钟。'),
        field('置信度阈值', jevMinConfidence, '低于该值的 Jev 决策被拒绝并回退规则计划。'),
        el('div', { class: 'dcm-btn-row' }, [jevSaveBtn]),
        el('div', { class: 'dcm-field-hint', text: '注意：启用后每轮发送计划前，会把当前消息片段、最近窗口与候选记忆的元数据发往该端点（不发送完整历史）。' +
            '隐私许可为「仅本地处理」时请在知情前提下开启。Jev 只做判断，不生成摘要、不改事实。' }),
    ]));

    // ── 分区 4：连接与诊断 ──
    const connectBtn = el('button', { class: 'menu_button', text: '连接服务' });
    connectBtn.addEventListener('click', () => handlers.onConnect());
    const reconnectBtn = el('button', { class: 'menu_button', text: '重新连接' });
    reconnectBtn.addEventListener('click', () => handlers.onReconnect());
    const pairRow = el('div', { class: 'dcm-pair-row', id: 'dcm-pair-row' });
    ui.append(block('连接与诊断', [
        el('div', { class: 'dcm-btn-row' }, [connectBtn, reconnectBtn]),
        pairRow,
        el('div', { class: 'dcm-field-hint', text: '已安装 SillyTavern 内嵌插件时无需操作，面板会自动连接；仅在使用独立服务时才需要配对。' }),
    ]));

    root.append(main.root);

    return {
        root,
        refs: {
            autoToggle, tierSelect, privacySelect, statusDot, statusText, statusReason,
            fixBox, summaryBox, toggles, pairRow, main,
            inlineCenterBody, customTierBox, ctTrigger, ctRecallTopK, ctRecallFloor, ctSummary, ctRecentMin,
            jevEndpoint, jevApiKey, jevModel, jevTimeoutMs, jevMinConfidence,
        },
    };
}

/** 记忆中心的标签页主体（模态与内嵌抽屉共用）。 */
export function buildMemoryCenterBody(handlers) {
    const tabs = ['记忆列表', '记忆库', '本轮计划', '快照与恢复', '记忆体检', '迁移导入', '诊断'];
    const tabBar = el('div', { class: 'dcm-tabs' });
    const body = el('div', { class: 'dcm-center-body' });
    const tabNodes = {};
    const panes = {};
    let activeTab = tabs[0];

    for (const name of tabs) {
        const node = el('div', { class: 'dcm-tab', text: name });
        tabNodes[name] = node;
        tabBar.append(node);

        const pane = el('div', { class: 'dcm-pane' });
        pane.style.display = 'none';
        panes[name] = pane;
        body.append(pane);
    }

    const activate = (name) => {
        const target = tabs.includes(name) ? name : tabs[0];
        activeTab = target;
        for (const [tabName, node] of Object.entries(tabNodes)) {
            node.classList.toggle('active', tabName === target);
        }
        // 注意：隐藏的是内容面板，不是标签按钮
        for (const [paneName, pane] of Object.entries(panes)) {
            pane.style.display = paneName === target ? '' : 'none';
        }
        handlers.onTab(target);
    };
    for (const name of tabs) {
        tabNodes[name].addEventListener('click', () => activate(name));
    }
    // 只设置初始可见性，不触发 onTab（此时宿主还没拿到 refs）
    tabNodes[tabs[0]].classList.add('active');
    panes[tabs[0]].style.display = '';

    const root = el('div', { class: 'dcm-center-inline-body' }, [tabBar, body]);
    return {
        root,
        refs: { content: panes, activate, tabNodes, activeTab: () => activeTab, tabBar, body },
    };
}

/** 记忆中心：模态面板。 */
export function buildMemoryCenter(handlers) {
    const overlay = el('div', { class: 'dcm-overlay', id: 'dcm-overlay' });
    const panel = el('div', { class: 'dcm-center' });

    const closeBtn = el('button', { class: 'menu_button dcm-close', text: '关闭' });
    closeBtn.addEventListener('click', () => handlers.onClose());
    const header = el('div', { class: 'dcm-center-header' }, [
        el('div', { class: 'dcm-center-titles' }, [
            el('div', { class: 'dcm-center-title', text: '记忆中心' }),
            el('div', { class: 'dcm-center-sub', text: '查看、纠正、固定、遗忘、恢复、导入和导出' }),
        ]),
        closeBtn,
    ]);

    const bodyInstance = buildMemoryCenterBody(handlers);
    panel.append(header, bodyInstance.root);
    overlay.append(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) handlers.onClose(); });

    return { overlay, refs: bodyInstance.refs };
}

export function renderStatus(refs, status) {
    const style = STATUS_STYLES[status.label] ?? STATUS_STYLES['需要处理'];
    refs.statusDot.style.color = style.color;
    refs.statusDot.textContent = style.icon;
    refs.statusText.textContent = status.label;
    refs.statusReason.textContent = status.reason ?? '';
    refs.fixBox.innerHTML = '';
    for (const action of status.fixActions ?? []) {
        const btn = el('button', { class: 'menu_button dcm-fix-btn', text: action.label ?? action });
        btn.addEventListener('click', () => action.onClick?.());
        refs.fixBox.append(btn);
    }
}

export function renderRoundSummary(refs, summary) {
    refs.summaryBox.innerHTML = '';
    if (!summary) {
        refs.summaryBox.append(el('div', { class: 'dcm-field-hint', text: '本轮上下文：暂无计划（发送一条消息后显示）' }));
        return;
    }
    const rows = [
        ['本轮注入', `${summary.injectionTokens ?? 0} tokens（记忆 ${summary.recallCount ?? 0} 条 / 摘要 ${summary.summaryCount ?? 0} 条）`],
        ['压缩比例', `${Math.round((summary.savedRatio ?? 0) * 100)}%（节省 ${summary.savedTokens ?? 0} tokens）`],
        ['计划结果', summary.result === 'blocked' ? '已阻止发送' : (summary.result === 'degraded' ? '已降级（可查看原因）' : '正常')],
        ['决策来源', summary.decisionProvider ?? '-'],
    ];
    for (const [label, value] of rows) {
        refs.summaryBox.append(el('div', { class: 'dcm-summary-row' }, [
            el('span', { class: 'dcm-summary-label', text: label }),
            el('span', { class: 'dcm-summary-value', text: value }),
        ]));
    }
    const detailBtn = el('button', { class: 'menu_button', text: '查看本轮细节' });
    detailBtn.addEventListener('click', () => refs.summaryBox.dispatchEvent(new CustomEvent('dcm-open-plan', { bubbles: true })));
    const centerBtn = el('button', { class: 'menu_button', text: '记忆中心' });
    centerBtn.addEventListener('click', () => refs.summaryBox.dispatchEvent(new CustomEvent('dcm-open-center', { bubbles: true })));
    refs.summaryBox.append(el('div', { class: 'dcm-btn-row' }, [detailBtn, centerBtn]));
}

/** 记忆中心里统一的空状态。 */
export function emptyState(text, actionLabel, onAction) {
    const box = el('div', { class: 'dcm-empty' }, [el('div', { class: 'dcm-empty-text', text })]);
    if (actionLabel) {
        const btn = el('button', { class: 'menu_button', text: actionLabel });
        btn.addEventListener('click', () => onAction?.());
        box.append(btn);
    }
    return box;
}

/** 区块标题（记忆中心内部复用）。 */
export function sectionTitle(text) {
    return el('div', { class: 'dcm-block-title', text });
}

/** 一行「标签 : 值」，用于结构化展示。 */
export function kvRow(label, value) {
    return el('div', { class: 'dcm-kv-row' }, [
        el('span', { class: 'dcm-kv-label', text: label }),
        el('span', { class: 'dcm-kv-value', text: String(value ?? '-') }),
    ]);
}

/** 默认折叠的原始 JSON（排查用，不作为主展示）。 */
export function rawJson(obj, summary = '原始数据（排查用）') {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return el('details', { class: 'dcm-raw' }, [
        el('summary', { text: summary }),
        el('pre', { class: 'dcm-json', text }),
    ]);
}

export function memoryCard(record, handlers) {
    const statusColors = {
        active: '#2e7d32', confirmed: '#1565c0', observed: '#7b1fa2', candidate: '#9e9e9e',
        conflict: '#c62828', superseded: '#757575', expired: '#ef6c00', archived: '#616161',
    };
    const card = el('div', { class: 'dcm-memory-card' });
    const head = el('div', { class: 'dcm-memory-head' }, [
        el('span', { class: 'dcm-badge', text: record.kind }),
        el('span', { class: 'dcm-badge', style: `background:${statusColors[record.status] ?? '#666'}`, text: record.status }),
        record.userLocked ? el('span', { class: 'dcm-badge dcm-locked', text: '已固定' }) : null,
        record.userEdited ? el('span', { class: 'dcm-badge', text: '用户编辑' }) : null,
        record.invalidated ? el('span', { class: 'dcm-badge dcm-invalid', text: '已失效' }) : null,
    ]);
    const content = el('div', { class: 'dcm-memory-content', text: record.content });
    const floorText = Number.isFinite(record.floorStart)
        ? (record.floorEnd && record.floorEnd !== record.floorStart
            ? `第 ${record.floorStart}–${record.floorEnd} 楼`
            : `第 ${record.floorStart} 楼`)
        : '';
    const speakerText = (record.speakers ?? []).length ? ` · ${record.speakers.join('、')}` : '';
    const meta = el('div', { class: 'dcm-memory-meta' }, [
        `${floorText ? `${floorText} · ` : ''}来源 ${record.sourceMessageIds?.length ?? 0} 条 · 置信度 ${(record.confidence ?? 0).toFixed(2)} · 重要度 ${(record.importance ?? 0).toFixed(2)}${speakerText}`,
        record.structured?.chapterKey ? ` · 章节 ${record.structured.chapterKey.split('|').pop()}` : '',
        record.derivation?.sourcePlugin ? ` · 导入自 ${record.derivation.sourcePlugin}` : '',
    ]);

    const actions = el('div', { class: 'dcm-memory-actions' });
    const btn = (label, onClick, cls = '') => {
        const b = el('button', { class: `menu_button dcm-mini ${cls}`, text: label });
        b.addEventListener('click', onClick);
        return b;
    };
    actions.append(
        btn(record.userLocked ? '取消固定' : '固定', () => handlers.onLock(record, !record.userLocked)),
        btn('纠正', () => handlers.onCorrect(record, card)),
        btn('不再记忆', () => handlers.onForget(record), 'dcm-danger'),
        btn('来源', () => handlers.onSources(record, card)),
        btn('恢复', () => handlers.onRestore(record)),
    );
    card.append(head, content, meta, actions);
    return card;
}

export function toast(message, type = 'info') {
    const node = el('div', { class: `dcm-toast dcm-toast-${type}`, text: message });
    document.body.append(node);
    setTimeout(() => node.classList.add('show'), 10);
    setTimeout(() => {
        node.classList.remove('show');
        setTimeout(() => node.remove(), 300);
    }, 4200);
}
