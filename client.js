/**
 * dsh-harness-trace — 浏览器半（Client half）。
 *
 * 职责：把宿主半追踪到的时间线搬进 DSH 界面。
 *   - `main` 面板（键 `harness-trace`）：审阅页，按「轮次 → 步骤」逐条查看。
 *   - `sidebar.panellist`：侧边栏入口图标。
 *   - `settings.section`：设置页，所有采集项、详细程度、范围、输出与入口位置均可调。
 *   - `conversation.view`：会话内的「追踪」视图，只看当前会话。
 *   - `conversation.session.header.actions`：会话头部快捷动作。
 *
 * 依赖面：只 require('react')；数据一律经 `ctx.get('connection').rpc.call`
 * 走本包宿主半注册的 RPC 路由，不依赖任何其他插件。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-harness-trace',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    /**
     * 与宿主半约定的 RPC 目标。
     *
     * 用共享 `/api` 通道 + 本插件端点，而不是自建顶层通道：Desktop 组合里网页由
     * `dsh-desktop-next/webserver` 提供，它不组合插件自建的顶层路由（会落到静态
     * 兜底上返回 405）。`/api` 在所有部署都存在，宿主半在其上注册了精确路由。
     */
    const CHANNEL = '/api'
    const ENDPOINT = 'harness-trace'
    const NS = 'harness-trace'
    const PANEL_ID = 'harness-trace'
    const VIEW_ID = 'harness-trace-view'
    const SETTINGS_ID = 'harness-trace-settings'
    const HEADER_ACTION_ID = 'harness-trace-action'

    /**
     * 主机半读不到配置时的兜底入口表：界面照常挂载并显示错误，
     * 而不是因为一次 RPC 失败就让整个插件从界面上消失。
     */
    const LAST_RESORT = {
      entries: {
        sidebar: true,
        settings: true,
        conversationTab: true,
        headerAction: true,
        order: { sidebar: 30, settings: 22, conversationTab: 15, headerAction: 12 },
      },
    }

    // ── 本地化字典 ────────────────────────────────────────────────────────
    const DICT_ZH = {
      label: 'Harness 交互追踪',
      'tab.conversation': '追踪',
      'tab.title': 'Harness 交互追踪',
      'guide.description': '查看本会话每轮每步的提示词、工具调用、文件访问与联网活动。',
      'page.title': 'Harness 交互追踪',
      'page.subtitle': '持续追踪 Harness 与模型的交互，并按轮次与步骤汇总为 Markdown。',
      'page.empty': '还没有追踪到任何会话。发起一次对话后即可在此审阅。',
      'page.sessions': '会话',
      'page.selectSession': '从左侧选择一个会话开始审阅。',
      'page.refresh': '刷新',
      'page.write': '立即写入',
      'page.writing': '写入中…',
      'page.written': '已写入 {path}',
      'page.markdown': 'Markdown 源码',
      'page.timeline': '时间线',
      'page.configFile': '配置文件',
      'page.openSettings': '打开设置',
      'page.autoRefresh': '自动刷新',
      'stat.turns': '轮次',
      'stat.steps': '步骤',
      'stat.tools': '工具调用',
      'stat.files': '文件',
      'stat.web': '联网',
      'stat.skills': '技能',
      'stat.tokens': 'Tokens',
      'sec.reads': '文件访问汇总',
      'sec.web': '联网活动汇总',
      'sec.skills': '技能加载汇总',
      'sec.overview': '会话概览',
      'turn.n': '第 {n} 轮',
      'turn.derived': '第 {n} 轮（推断）',
      'step.n': '步骤 {turn}.{step}',
      'turn.start': '开始 {t}',
      'turn.end': '结束 {t}',
      'turn.cost': '耗时 {d}',
      'turn.steps': '步骤 {n}',
      'turn.reason': '结束原因 {r}',
      'turn.orphan': '轮次之外',
      'tool.read': '读取文件',
      'tool.write': '写入文件',
      'tool.web': '联网',
      'tool.skill': '加载技能',
      'tool.command': '执行命令',
      'tool.tool': '工具调用',
      'item.user': '用户输入',
      'item.system': '系统提示词',
      'item.inject': '注入内容',
      'item.context': '请求上下文',
      'item.request': '模型请求配置',
      'item.raw': '原始请求（发往模型）',
      'item.assembly': '提示词装配',
      'item.assistant': '模型回复',
      'item.result': '工具结果',
      'item.args': '参数',
      'item.resultOf': '结果',
      'item.resultErr': '结果（失败）',
      'item.pending': '调用已发出，结果尚未记录。',
      'item.reasoning': '推理过程',
      'item.truncated': '内容较长，此处截断显示（完整内容见 Markdown 文件）。',
      'item.unchanged': '与上一步发送的消息完全相同，此处省略。',
      'item.systemSame': '与上一条系统提示词完全相同，此处省略。',
      'item.usage': '用量：输入 {i} · 输出 {o}',
      'item.tools': '可用工具 {n} 个',
      'item.summaryTools': '工具',
      'item.summaryReads': '读取',
      'item.summaryWrites': '写入',
      'item.summaryWeb': '联网',
      'item.summarySkills': '技能',
      'item.rawMeta': '提供商 {p} · 模型 {m} · 消息 {n} 条',
      'item.sections': '提示词段落',
      'item.contexts': '上下文条目',
      'set.title': 'Harness 交互追踪',
      'set.subtitle': '选择要记录的内容与详细程度，并决定入口出现在哪里。',
      'set.enabled': '启用记录',
      'set.enabledDesc': '关闭后不再采集任何内容，也不会写入文件。',
      'set.capture': '记录什么',
      'set.captureDesc': '逐项开关，关闭的项目不会出现在记录里。',
      'set.detail': '详细程度',
      'set.detailDesc': '控制正文的呈现方式。',
      'set.detail.summary': '摘要',
      'set.detail.standard': '标准',
      'set.detail.full': '完整',
      'set.limits': '篇幅限制',
      'set.maxInlineChars': '单条正文上限（字符）',
      'set.maxInlineCharsDesc': '超过此长度的内容按详细程度截断或折叠。',
      'set.rawMode': '原始请求',
      'set.rawModeDesc': '决定发往模型的完整消息如何记录。',
      'set.rawMode.changed': '仅在变化时',
      'set.rawMode.always': '每次都写',
      'set.rawMode.off': '不记录',
      'set.maxRawMessages': '原始请求最多消息数',
      'set.rawBudget': '原始请求总预算（字符）',
      'set.rawBudgetDesc': '每次请求里完整展开的消息总长度上限，从最新一条往前分配；更早的历史折叠为一行摘要。',
      'set.dedupe': '去重',
      'set.dedupeDesc': '关闭后会把每次调用附带的同一份系统提示词与提示词装配完整写入，文件会显著变大。',
      'set.dedupeSystem': '系统提示词去重',
      'set.dedupeAssembly': '提示词装配去重',
      'set.scope': '记录范围',
      'set.scopeDesc': '选择要对哪些会话与工作区进行记录。',
      'set.scope.all': '全部',
      'set.scope.include': '仅所选',
      'set.scope.exclude': '除所选',
      'set.includeSubagents': '包含子代理会话',
      'set.sessions': '会话',
      'set.workspaces': '工作区',
      'set.scopeHint': '勾选要纳入/排除的会话与工作区目录。',
      'set.none': '（暂无可选项）',
      'set.output': '输出',
      'set.outputDir': '子目录名',
      'set.outputDirDesc': '文件落在会话对应的工作区内此子目录下。',
      'set.writeOn': '写入时机',
      'set.writeOn.turn': '每轮结束',
      'set.writeOn.step': '每步结束',
      'set.writeOn.manual': '仅手动',
      'set.debounce': '合并延迟（毫秒）',
      'set.debounceDesc': '同一会话的多次变更在该时间内合并为一次写入。',
      'set.entries': '入口位置',
      'set.entriesDesc': '逐项开关入口，并用序号调整它们的先后位置。',
      'set.entry.sidebar': '侧边栏面板入口',
      'set.entry.settings': '设置页',
      'set.entry.conversationTab': '会话内「记录」标签',
      'set.entry.headerAction': '会话头部快捷按钮',
      'set.order': '位置',
      'set.save': '保存',
      'set.saved': '已保存',
      'set.saveFail': '保存失败：{msg}',
      'set.reset': '恢复默认',
      'set.reloading': '加载中…',
      'act.write': '写入记录',
      'act.reload': '重新读取',
      'act.capture': '开始记录',
      'act.pause': '暂停记录',
      'act.openPanel': '打开审阅页',
      'act.openInSettings': '在设置中调整',
      'err.title': '读取失败',
      'err.retry': '重试',
      'err.noConnection': '连接服务不可用，无法读取记录。',
      'cap.systemPrompt': '系统提示词',
      'cap.promptAssembly': '提示词装配来源',
      'cap.rawRequest': '发往模型的完整请求',
      'cap.userMessages': '用户输入',
      'cap.assistantMessages': '模型回复',
      'cap.reasoning': '推理过程',
      'cap.toolCalls': '工具调用',
      'cap.toolResults': '工具结果',
      'cap.files': '本地文件读写',
      'cap.web': '联网搜索与抓取',
      'cap.skills': '本地技能加载',
      'cap.commands': '命令执行',
      'cap.usage': 'Token 用量',
      'note.independent': '本插件不依赖任何其他插件，数据全部来自 Harness 自身的事件。',
    }

    const DICT_EN = {
      label: 'Harness Trace',
      'tab.conversation': 'Trace',
      'tab.title': 'Harness Trace',
      'guide.description': 'Inspect every prompt, tool call, file access and web activity for this Session, per turn and step.',
      'page.title': 'Harness Trace',
      'page.subtitle': 'Continuously traces Harness/LLM interaction and summarizes it per turn and step into Markdown.',
      'page.empty': 'Nothing traced yet. Start a conversation and review it here.',
      'page.sessions': 'Sessions',
      'page.selectSession': 'Select a Session on the left to review it.',
      'page.refresh': 'Refresh',
      'page.write': 'Write now',
      'page.writing': 'Writing…',
      'page.written': 'Written to {path}',
      'page.markdown': 'Markdown source',
      'page.timeline': 'Timeline',
      'page.configFile': 'Config file',
      'page.openSettings': 'Open settings',
      'page.autoRefresh': 'Auto refresh',
      'stat.turns': 'Turns',
      'stat.steps': 'Steps',
      'stat.tools': 'Tool calls',
      'stat.files': 'Files',
      'stat.web': 'Web',
      'stat.skills': 'Skills',
      'stat.tokens': 'Tokens',
      'sec.reads': 'File access summary',
      'sec.web': 'Web activity summary',
      'sec.skills': 'Skill loads summary',
      'sec.overview': 'Session overview',
      'turn.n': 'Turn {n}',
      'turn.derived': 'Turn {n} (derived)',
      'step.n': 'Step {turn}.{step}',
      'turn.start': 'start {t}',
      'turn.end': 'end {t}',
      'turn.cost': 'took {d}',
      'turn.steps': '{n} steps',
      'turn.reason': 'reason {r}',
      'turn.orphan': 'Outside turns',
      'tool.read': 'Read file',
      'tool.write': 'Write file',
      'tool.web': 'Web',
      'tool.skill': 'Load skill',
      'tool.command': 'Run command',
      'tool.tool': 'Tool call',
      'item.user': 'User input',
      'item.system': 'System prompt',
      'item.inject': 'Injected content',
      'item.context': 'Request context',
      'item.request': 'Model request config',
      'item.raw': 'Raw request (sent to model)',
      'item.assembly': 'Prompt assembly',
      'item.assistant': 'Model reply',
      'item.result': 'Tool result',
      'item.args': 'Arguments',
      'item.resultOf': 'Result',
      'item.resultErr': 'Result (failed)',
      'item.pending': 'Call issued; result not recorded yet.',
      'item.reasoning': 'Reasoning',
      'item.truncated': 'Content is long and truncated here; the Markdown file holds the full text.',
      'item.unchanged': 'Identical to the previous step\u2019s messages; omitted.',
      'item.systemSame': 'Identical to the previous system prompt; omitted.',
      'item.usage': 'usage: {i} in · {o} out',
      'item.tools': '{n} tools available',
      'item.summaryTools': 'Tools',
      'item.summaryReads': 'Reads',
      'item.summaryWrites': 'Writes',
      'item.summaryWeb': 'Web',
      'item.summarySkills': 'Skills',
      'item.rawMeta': 'provider {p} · model {m} · {n} messages',
      'item.sections': 'Prompt sections',
      'item.contexts': 'Context entries',
      'set.title': 'Harness Trace',
      'set.subtitle': 'Choose what to record, how detailed it is, and where the entries appear.',
      'set.enabled': 'Enable recording',
      'set.enabledDesc': 'When off, nothing is collected and no file is written.',
      'set.capture': 'What to record',
      'set.captureDesc': 'Per-item switches; disabled items never appear in the record.',
      'set.detail': 'Detail level',
      'set.detailDesc': 'Controls how bodies are rendered.',
      'set.detail.summary': 'Summary',
      'set.detail.standard': 'Standard',
      'set.detail.full': 'Full',
      'set.limits': 'Size limits',
      'set.maxInlineChars': 'Inline body limit (characters)',
      'set.maxInlineCharsDesc': 'Bodies longer than this are truncated or folded per detail level.',
      'set.rawMode': 'Raw request',
      'set.rawModeDesc': 'How the exact messages sent to the model are recorded.',
      'set.rawMode.changed': 'Only when changed',
      'set.rawMode.always': 'Every time',
      'set.rawMode.off': 'Do not record',
      'set.maxRawMessages': 'Max messages per raw request',
      'set.rawBudget': 'Raw request budget (characters)',
      'set.rawBudgetDesc': 'Upper bound for fully expanded messages per request, allocated from the newest backwards; older history folds to a one-line summary.',
      'set.dedupe': 'Deduplication',
      'set.dedupeDesc': 'When off, the same system prompt and prompt assembly are written out in full on every call, making files much larger.',
      'set.dedupeSystem': 'Deduplicate system prompts',
      'set.dedupeAssembly': 'Deduplicate prompt assembly',
      'set.scope': 'Scope',
      'set.scopeDesc': 'Choose which Sessions and workspaces to record.',
      'set.scope.all': 'All',
      'set.scope.include': 'Only selected',
      'set.scope.exclude': 'Except selected',
      'set.includeSubagents': 'Include subagent Sessions',
      'set.sessions': 'Sessions',
      'set.workspaces': 'Workspaces',
      'set.scopeHint': 'Tick the Sessions and workspace directories to include or exclude.',
      'set.none': '(nothing available)',
      'set.output': 'Output',
      'set.outputDir': 'Subdirectory name',
      'set.outputDirDesc': 'Files land under this subdirectory inside the Session workspace.',
      'set.writeOn': 'Write timing',
      'set.writeOn.turn': 'At turn end',
      'set.writeOn.step': 'At step end',
      'set.writeOn.manual': 'Manual only',
      'set.debounce': 'Merge delay (ms)',
      'set.debounceDesc': 'Changes within this window merge into one write.',
      'set.entries': 'Entry placement',
      'set.entriesDesc': 'Toggle each entry and set its position with an order number.',
      'set.entry.sidebar': 'Sidebar panel entry',
      'set.entry.settings': 'Settings page',
      'set.entry.conversationTab': 'Session "Trace" tab',
      'set.entry.headerAction': 'Session header shortcut',
      'set.order': 'Position',
      'set.save': 'Save',
      'set.saved': 'Saved',
      'set.saveFail': 'Save failed: {msg}',
      'set.reset': 'Restore defaults',
      'set.reloading': 'Loading…',
      'act.write': 'Write record',
      'act.reload': 'Reload',
      'act.capture': 'Start recording',
      'act.pause': 'Pause recording',
      'act.openPanel': 'Open review page',
      'act.openInSettings': 'Adjust in settings',
      'err.title': 'Load failed',
      'err.retry': 'Retry',
      'err.noConnection': 'The connection service is unavailable; records cannot be read.',
      'cap.systemPrompt': 'System prompt',
      'cap.promptAssembly': 'Prompt assembly sources',
      'cap.rawRequest': 'Complete request sent to the model',
      'cap.userMessages': 'User input',
      'cap.assistantMessages': 'Model replies',
      'cap.reasoning': 'Reasoning',
      'cap.toolCalls': 'Tool calls',
      'cap.toolResults': 'Tool results',
      'cap.files': 'Local file reads/writes',
      'cap.web': 'Web search and fetch',
      'cap.skills': 'Local skill loading',
      'cap.commands': 'Command execution',
      'cap.usage': 'Token usage',
      'note.independent': 'This plugin depends on no other plugin; all data comes from Harness events.',
    }

    // ── 样式（只用主题令牌） ──────────────────────────────────────────────
    const CSS = `
.lt-root{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;display:flex;flex-direction:column;height:100%;min-height:0}
.lt-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.lt-title{font-size:15px;font-weight:600;margin:0}
.lt-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.lt-spacer{flex:1}
.lt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.6}
.lt-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lt-btn[disabled]{opacity:.5;cursor:default}
.lt-btn.pri{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.lt-btn.pri:hover{background:var(--dsw-alias-button-primary-hover)}
.lt-btn.sm{padding:2px 7px;font-size:11px}
.lt-body{display:flex;flex:1;min-height:0}
.lt-side{width:260px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.lt-side h3{margin:4px 6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.lt-row{padding:7px 9px;border-radius:6px;cursor:pointer;border:1px solid transparent;margin-bottom:3px}
.lt-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lt-row.on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2)}
.lt-row-t{font-weight:600;font-size:12px;word-break:break-all}
.lt-row-m{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px;word-break:break-all}
.lt-main{flex:1;overflow:auto;padding:14px 18px;min-width:0}
.lt-stats{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
.lt-stat{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 11px;min-width:74px}
.lt-stat b{display:block;font-size:16px;font-weight:600}
.lt-stat span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.lt-turn{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.lt-turn>.lt-th{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;background:var(--dsw-alias-bg-layer-2)}
.lt-th-t{font-weight:600}
.lt-th-m{color:var(--dsw-alias-label-tertiary);font-size:11px}
.lt-step{margin:8px 11px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px}
.lt-step-h{font-weight:600;font-size:12px;margin-bottom:5px;color:var(--dsw-alias-label-secondary)}
.lt-item{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:6px 0;background:var(--dsw-alias-bg-base)}
.lt-item-h{display:flex;align-items:center;gap:7px;padding:5px 9px;cursor:pointer;font-size:12px}
.lt-item-h:hover{background:var(--dsw-alias-interactive-bg-hover)}
.lt-item-b{padding:4px 10px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.lt-badge{font-size:10px;padding:1px 6px;border-radius:99px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.lt-badge.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.lt-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.lt-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.lt-time{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.lt-pre{margin:4px 0;padding:8px 10px;background:var(--dsw-alias-markdown-code-block);border-radius:6px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;max-height:420px;overflow:auto}
.lt-kv{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:3px 10px;font-size:12px}
.lt-kv div:nth-child(odd){color:var(--dsw-alias-label-tertiary)}
.lt-kv div:nth-child(even){word-break:break-all}
.lt-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:6px 0}
.lt-empty{color:var(--dsw-alias-label-tertiary);padding:26px;text-align:center}
.lt-err{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);border-radius:7px;padding:9px 11px;margin:8px 0;font-size:12px}
.lt-sw{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.lt-sw-i{width:30px;height:17px;border-radius:99px;background:var(--dsw-alias-border-l2);position:relative;flex:none;transition:background .15s}
.lt-sw-i.on{background:var(--dsw-alias-brand-primary)}
.lt-sw-i i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s}
.lt-sw-i.on i{left:15px}
.lt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:7px}
.lt-box{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1)}
.lt-box h4{margin:0 0 3px;font-size:12.5px;font-weight:600}
.lt-box p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px}
.lt-field{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.lt-field:last-child{border-bottom:none}
.lt-field>.lt-fl{min-width:210px}
.lt-field>.lt-fl b{display:block;font-weight:600;font-size:12.5px}
.lt-field>.lt-fl span{color:var(--dsw-alias-label-tertiary);font-size:11px}
.lt-in{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px}
.lt-in.num{width:82px}
.lt-in.txt{width:190px}
select.lt-in{cursor:pointer}
.lt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.lt-seg button{border:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:4px 11px;font-size:12px;cursor:pointer}
.lt-seg button.on{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.lt-grp{margin:0 0 18px}
.lt-grp>h3{margin:0 0 3px;font-size:13px;font-weight:600}
.lt-grp>p{margin:0 0 9px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.lt-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:99px;padding:2px 9px;font-size:11.5px;margin:2px 4px 2px 0;cursor:pointer;background:var(--dsw-alias-bg-layer-1)}
.lt-chip.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active)}
.lt-icons{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%}
.lt-flash{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
`
    /** 组件级样式元素：随组件卸载一起移除。 */
    const styleTag = () => h('style', { key: 'lt-style' }, CSS)

    // ── 与宿主半的通信 ────────────────────────────────────────────────────
    /**
     * 建一个绑定到本插件端点的调用器。
     * 端点名（如 `session.get`）随调用传入，宿主半据它分派；
     * 连接服务要求 method 与 URL 末段一致，因此走 `rpc.call`（它会把端点名放进 URL）。
     */
    function makeBridge(ctx) {
      let warned = false
      const call = (endpoint, payload) => {
        let rpc = null
        try {
          const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
          rpc = connection && connection.rpc ? connection.rpc : null
        } catch {
          rpc = null
        }
        if (!rpc || typeof rpc.call !== 'function') {
          warned = true
          return Promise.reject(new Error('connection unavailable'))
        }
        return Promise.resolve(
          rpc.call(CHANNEL, ENDPOINT, { method: endpoint, payload: payload === undefined ? null : payload }),
        ).then((result) => {
          if (result && result.ok === true) return result.value
          const message =
            result && result.error && result.error.message ? result.error.message : `RPC ${endpoint} failed`
          throw new Error(message)
        })
      }
      return { call, get warned() { return warned } }
    }

    /** 一个最小可用的数据钩子：拉取 + 手动刷新 + 可选轮询。 */
    function useRemote(bridge, endpoint, payload, options = {}) {
      const [state, setState] = useState({ data: null, error: null, loading: true })
      const payloadKey = useMemo(() => JSON.stringify(payload === undefined ? null : payload), [payload])
      const alive = useRef(true)
      const reload = useCallback(() => {
        setState((prev) => ({ data: prev.data, error: null, loading: true }))
        return bridge
          .call(endpoint, payloadKey === 'null' ? null : JSON.parse(payloadKey))
          .then((data) => {
            if (alive.current) setState({ data, error: null, loading: false })
            return data
          })
          .catch((error) => {
            if (alive.current) setState({ data: null, error: String(error && error.message ? error.message : error), loading: false })
            return null
          })
      }, [bridge, endpoint, payloadKey])
      useEffect(() => {
        alive.current = true
        void reload()
        return () => {
          alive.current = false
        }
      }, [reload])
      useEffect(() => {
        const ms = Number(options.pollMs) || 0
        if (ms <= 0) return undefined
        const timer = setInterval(() => void reload(), ms)
        return () => clearInterval(timer)
      }, [reload, options.pollMs])
      return { ...state, reload }
    }

    /** 本地配置缓存（跨组件共享），宿主侧是唯一真相。 */
    function createStore(bridge) {
      let snapshot = null
      const listeners = new Set()
      const publish = () => {
        for (const listener of listeners) listener(snapshot)
      }
      const store = {
        get value() {
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        async load(force) {
          if (snapshot && !force) return snapshot
          try {
            snapshot = await bridge.call('status', null)
            publish()
          } catch (error) {
            snapshot = { config: null, defaults: null, sessions: [], error: String(error && error.message ? error.message : error) }
            publish()
          }
          return snapshot
        },
        async save(patch) {
          const result = await bridge.call('config.set', { patch })
          snapshot = { ...(snapshot || {}), config: result.config }
          publish()
          return result
        },
        async reset() {
          const result = await bridge.call('config.reset', null)
          snapshot = { ...(snapshot || {}), config: result.config }
          publish()
          return result
        },
        async refreshSessions() {
          try {
            const result = await bridge.call('sessions.list', null)
            snapshot = { ...(snapshot || {}), sessions: result.sessions || [] }
            publish()
          } catch {
            /* 忽略 */
          }
        },
      }
      return store
    }

    /** React 侧读取 store 的钩子。 */
    function useStore(store) {
      const [value, setValue] = useState(store.value)
      useEffect(() => {
        let live = true
        const unsubscribe = store.subscribe((next) => {
          if (live) setValue(next)
        })
        if (!store.value) void store.load(false)
        return () => {
          live = false
          unsubscribe()
        }
      }, [store])
      return value
    }

    // ── 小部件 ────────────────────────────────────────────────────────────

    /** 开关。 */
    function Switch(props) {
      const { on, onChange, label } = props
      return h(
        'span',
        {
          className: 'lt-sw',
          role: 'switch',
          tabIndex: 0,
          'aria-checked': on ? 'true' : 'false',
          onClick: () => onChange(!on),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onChange(!on)
            }
          },
        },
        h('span', { className: `lt-sw-i${on ? ' on' : ''}` }, h('i', null)),
        label ? h('span', null, label) : null,
      )
    }

    /** 分段选择。 */
    function Segmented(props) {
      const { value, options, onChange } = props
      return h(
        'span',
        { className: 'lt-seg' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: value === option.value ? 'on' : '',
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /** 键值表。 */
    function KeyValue(props) {
      const entries = Object.entries(props.data || {})
      if (entries.length === 0) return h('div', { className: 'lt-note' }, '—')
      const children = []
      for (const [key, value] of entries) {
        children.push(h('div', { key: `k-${key}` }, key))
        children.push(h('div', { key: `v-${key}` }, typeof value === 'object' ? JSON.stringify(value) : String(value)))
      }
      return h('div', { className: 'lt-kv' }, children)
    }

    /** 统计小卡。 */
    function Stat(props) {
      return h('div', { className: 'lt-stat' }, h('b', null, String(props.value)), h('span', null, props.label))
    }

    // ── 时间线条目渲染 ────────────────────────────────────────────────────

    /** 单个条目。 */
    function Item(props) {
      const { item, t, defaultOpen } = props
      const [open, setOpen] = useState(Boolean(defaultOpen))
      const meta = itemMeta(item, t)
      const badges = []
      if (meta.badge) badges.push(h('span', { key: 'b', className: `lt-badge ${meta.tone || ''}` }, meta.badge))
      if (item.resultState) {
        badges.push(
          h(
            'span',
            { key: 'rs', className: `lt-badge ${item.resultState === 'error' ? 'err' : item.resultState === 'ok' ? 'ok' : 'warn'}` },
            item.resultState === 'error' ? '失败' : item.resultState === 'ok' ? '成功' : '进行中',
          ),
        )
      }
      if (item.changed === false) badges.push(h('span', { key: 'un', className: 'lt-badge' }, '同上一步'))
      return h(
        'div',
        { className: 'lt-item' },
        h(
          'div',
          { className: 'lt-item-h', onClick: () => setOpen((v) => !v) },
          h('span', { className: 'lt-time' }, shortClock(item.time)),
          h('span', { style: { fontWeight: 600 } }, meta.title),
          meta.subject ? h('span', { className: 'lt-row-m', style: { margin: 0 } }, meta.subject) : null,
          ...badges,
          h('span', { className: 'lt-spacer' }),
          h('span', { className: 'lt-time' }, open ? '▾' : '▸'),
        ),
        open ? h('div', { className: 'lt-item-b' }, renderItemBody(item, t)) : null,
      )
    }

    /** 条目的标题、副标题与徽标。 */
    function itemMeta(item, t) {
      switch (item.k) {
        case 'user':
          return { title: t('item.user'), tone: '' }
        case 'system':
          return { title: t('item.system'), tone: '' }
        case 'inject':
          return { title: t('item.inject'), tone: '' }
        case 'context':
          return { title: t('item.context'), tone: '' }
        case 'request':
          return {
            title: t('item.request'),
            subject: item.config ? `${item.config.provider || '?'}/${item.config.model || '?'}` : '',
            badge: t('item.tools', { n: item.toolCount || 0 }),
          }
        case 'raw':
          return {
            title: t('item.raw'),
            subject: `${item.provider || '?'}/${item.model || '?'}`,
            badge: `${item.messageCount || 0} 条消息`,
          }
        case 'assembly':
          return {
            title: t('item.assembly'),
            badge: `${(item.sections || []).length} 段`,
          }
        case 'assistant':
          return {
            title: t('item.assistant'),
            subject: item.model ? `${item.model.provider || ''}/${item.model.model || ''}` : '',
            badge: item.usage ? t('item.usage', { i: item.usage.inputTokens || 0, o: item.usage.outputTokens || 0 }) : '',
          }
        case 'tool': {
          const key = `tool.${item.category === 'file-read' ? 'read' : item.category === 'file-write' ? 'write' : item.category === 'web' ? 'web' : item.category === 'skill' ? 'skill' : item.category === 'command' ? 'command' : 'tool'}`
          return { title: t(key), subject: item.name || '', tone: '' }
        }
        case 'result':
          return { title: t('item.result'), badge: item.isError ? '失败' : '', tone: item.isError ? 'err' : 'ok' }
        default:
          return { title: String(item.k || '记录'), tone: '' }
      }
    }

    /** 条目正文。 */
    function renderItemBody(item, t) {
      const parts = []
      const textBlock = (value, key) => {
        if (!value) return null
        const text = typeof value === 'string' ? { text: value, truncated: false } : value
        return h(
          'div',
          { key },
          text.truncated ? h('div', { className: 'lt-note' }, t('item.truncated')) : null,
          h('pre', { className: 'lt-pre' }, text.text || ''),
        )
      }
      switch (item.k) {
        case 'user':
        case 'system':
        case 'inject':
        case 'result':
          if (item.unchanged) {
            parts.push(h('div', { key: 'un', className: 'lt-note' }, t('item.systemSame')))
            break
          }
          parts.push(textBlock(item.text, 'text'))
          if (item.error) parts.push(h('pre', { key: 'err', className: 'lt-pre' }, JSON.stringify(item.error, null, 2)))
          break
        case 'context':
          parts.push(h(KeyValue, { key: 'kv', data: item.context || {} }))
          break
        case 'request':
          parts.push(
            h(
              'div',
              { key: 'cfg' },
              h(KeyValue, {
                data: {
                  provider: item.config?.provider,
                  model: item.config?.model,
                  reasoningEffort: item.config?.reasoningEffort,
                  maxTokens: item.config?.maxTokens,
                  temperature: item.config?.temperature,
                  reason: item.reason,
                  startsSeries: item.startsSeries,
                },
              }),
              Array.isArray(item.tools) && item.tools.length > 0
                ? h('div', { className: 'lt-note' }, (item.tools || []).map((tool) => tool.name).filter(Boolean).join(' · '))
                : null,
            ),
          )
          break
        case 'raw': {
          parts.push(
            h('div', { key: 'meta', className: 'lt-note' }, t('item.rawMeta', { p: item.provider || '?', m: item.model || '?', n: item.messageCount || 0 })),
          )
          if (item.changed === false) parts.push(h('div', { key: 'same', className: 'lt-note' }, t('item.unchanged')))
          for (let i = 0; i < (item.messages || []).length; i++) {
            const message = item.messages[i]
            parts.push(
              h(
                'div',
                { key: `m-${i}` },
                h('div', { className: 'lt-note', style: { fontWeight: 600 } }, `${message.role}${message.model ? ` · ${message.provider || ''}/${message.model}` : ''}${message.truncated ? ' · 已截断' : ''}`),
                h('pre', { className: 'lt-pre' }, message.text || ''),
              ),
            )
          }
          if (item.outcome) {
            const usage = item.outcome.usage || {}
            parts.push(
              h(
                'div',
                { key: 'usage', className: 'lt-note' },
                `结果：${usage.inputTokens || 0}↑ ${usage.outputTokens || 0}↓ ${item.outcome.finish ? `· ${typeof item.outcome.finish === 'string' ? item.outcome.finish : item.outcome.finish.kind || ''}` : ''}`,
              ),
            )
          }
          break
        }
        case 'assembly': {
          parts.push(h('div', { key: 'sh', className: 'lt-note', style: { fontWeight: 600 } }, t('item.sections')))
          for (let i = 0; i < (item.sections || []).length; i++) {
            const section = item.sections[i]
            parts.push(
              h(
                'div',
                { key: `s-${i}` },
                h('div', { className: 'lt-note', style: { fontWeight: 600 } }, `${section.name || '(匿名)'}${section.truncated ? ' · 已截断' : ''}`),
                section.text ? h('pre', { className: 'lt-pre' }, section.text) : null,
              ),
            )
          }
          if ((item.contexts || []).length > 0) {
            parts.push(h('div', { key: 'ch', className: 'lt-note', style: { fontWeight: 600 } }, t('item.contexts')))
            for (let i = 0; i < item.contexts.length; i++) {
              const context = item.contexts[i]
              parts.push(
                h(
                  'div',
                  { key: `c-${i}` },
                  h('div', { className: 'lt-note', style: { fontWeight: 600 } }, context.name || '(匿名)'),
                  context.text ? h('pre', { className: 'lt-pre' }, context.text) : null,
                ),
              )
            }
          }
          break
        }
        case 'assistant':
          if (item.reasoning) {
            parts.push(h('div', { key: 'rh', className: 'lt-note', style: { fontWeight: 600 } }, t('item.reasoning')))
            parts.push(textBlock(item.reasoning, 'reasoning'))
          }
          parts.push(textBlock(item.text, 'text'))
          break
        case 'tool':
          if (item.subject) parts.push(h('div', { key: 'sub', className: 'lt-note' }, item.subject))
          parts.push(h('div', { key: 'ah', className: 'lt-note', style: { fontWeight: 600 } }, t('item.args')))
          parts.push(textBlock(item.args, 'args'))
          if (item.result) {
            parts.push(
              h('div', { key: 'rh', className: 'lt-note', style: { fontWeight: 600 } }, item.resultState === 'error' ? t('item.resultErr') : t('item.resultOf')),
            )
            if (item.result.error) parts.push(h('pre', { key: 're', className: 'lt-pre' }, JSON.stringify(item.result.error, null, 2)))
            parts.push(textBlock(item.result.text, 'rv'))
          } else if (item.resultState === 'pending') {
            parts.push(h('div', { key: 'pend', className: 'lt-note' }, t('item.pending')))
          }
          break
        default:
          parts.push(h('pre', { key: 'any', className: 'lt-pre' }, JSON.stringify(item, null, 2)))
      }
      return parts
    }

    /** `HH:mm:ss`。 */
    function shortClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--:--'
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** 千分位。 */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '0'
    }

    // ── 会话时间线视图 ────────────────────────────────────────────────────

    /** 轮次与步骤的时间线。 */
    function Timeline(props) {
      const { detail, t } = props
      const [openTurns, setOpenTurns] = useState({})
      const isOpen = (turn) => openTurns[turn] !== false
      const toggle = (turn) => setOpenTurns((prev) => ({ ...prev, [turn]: prev[turn] === false }))
      const blocks = []
      for (const turn of detail.turns || []) {
        const summary = summarizeTurn(turn, t)
        const steps = []
        if ((turn.preamble || []).length > 0) {
          steps.push(
            h(
              'div',
              { key: 'pre', className: 'lt-step' },
              h('div', { className: 'lt-step-h' }, '轮次开始处'),
              turn.preamble.map((item, index) => h(Item, { key: `p-${index}`, item, t })),
            ),
          )
        }
        for (const step of turn.steps || []) {
          const stepMeta = [`开始 ${shortClock(step.time0)}`]
          if (step.time1) stepMeta.push(`耗时 ${humanMs(step.time1 - step.time0)}`)
          if (step.usage) stepMeta.push(`${num(step.usage.inputTokens)}↑ ${num(step.usage.outputTokens)}↓`)
          steps.push(
            h(
              'div',
              { key: `s-${step.step}`, className: 'lt-step' },
              h('div', { className: 'lt-step-h' }, `${t('step.n', { turn: turn.turn, step: step.step })} · ${stepMeta.join(' · ')}`),
              (step.items || []).map((item, index) => h(Item, { key: `i-${index}`, item, t })),
            ),
          )
        }
        const head = [`开始 ${shortClock(turn.time0)}`]
        if (turn.time1) head.push(`耗时 ${humanMs(turn.time1 - turn.time0)}`)
        head.push(t('turn.steps', { n: (turn.steps || []).length }))
        blocks.push(
          h(
            'div',
            { key: `t-${turn.turn}`, className: 'lt-turn' },
            h(
              'div',
              { className: 'lt-th', onClick: () => toggle(turn.turn) },
              h('span', { className: 'lt-th-t' }, turn.synthetic ? t('turn.derived', { n: turn.turn }) : t('turn.n', { n: turn.turn })),
              h('span', { className: 'lt-th-m' }, head.join(' · ')),
              h('span', { className: 'lt-spacer' }),
              h('span', { className: 'lt-time' }, isOpen(turn.turn) ? '▾' : '▸'),
            ),
            isOpen(turn.turn)
              ? h(
                  'div',
                  null,
                  summary.length > 0 ? h('div', { style: { padding: '7px 11px 0' } }, summary.map((line, index) => h('div', { key: index, className: 'lt-note' }, line))) : null,
                  steps.length > 0 ? steps : h('div', { className: 'lt-note', style: { padding: '0 11px 9px' } }, '—'),
                )
              : null,
          ),
        )
      }
      if (blocks.length === 0) return h('div', { className: 'lt-empty' }, t('page.empty'))
      return h('div', null, blocks)
    }

    /** 单轮的一句话概览。 */
    function summarizeTurn(turn, t) {
      const items = [...(turn.preamble || [])]
      for (const step of turn.steps || []) items.push(...(step.items || []))
      const tools = new Map()
      const reads = new Set()
      const writes = new Set()
      const web = new Set()
      const skills = new Set()
      for (const item of items) {
        if (item.k !== 'tool') continue
        tools.set(item.name, (tools.get(item.name) || 0) + 1)
        if (!item.subject) continue
        if (item.category === 'file-read') reads.add(item.subject)
        else if (item.category === 'file-write') writes.add(item.subject)
        else if (item.category === 'web') web.add(item.subject)
        else if (item.category === 'skill') skills.add(item.skill || item.subject)
      }
      const lines = []
      if (tools.size > 0) lines.push(`${t('item.summaryTools')}：${[...tools.entries()].map(([name, count]) => `${name}×${count}`).join('、')}`)
      if (reads.size > 0) lines.push(`${t('item.summaryReads')}：${[...reads].join('、')}`)
      if (writes.size > 0) lines.push(`${t('item.summaryWrites')}: ${[...writes].join('、')}`)
      if (web.size > 0) lines.push(`${t('item.summaryWeb')}：${[...web].join('、')}`)
      if (skills.size > 0) lines.push(`${t('item.summarySkills')}：${[...skills].join('、')}`)
      return lines
    }

    /** 会话概览统计。 */
    function Stats(props) {
      const { summary, t } = props
      return h(
        'div',
        { className: 'lt-stats' },
        h(Stat, { label: t('stat.turns'), value: summary.turns || 0 }),
        h(Stat, { label: t('stat.steps'), value: summary.steps || 0 }),
        h(Stat, { label: t('stat.tools'), value: summary.tools || 0 }),
        h(Stat, { label: t('stat.files'), value: summary.files || 0 }),
        h(Stat, { label: t('stat.web'), value: summary.web || 0 }),
        h(Stat, { label: t('stat.skills'), value: summary.skills || 0 }),
        h(Stat, { label: t('stat.tokens'), value: num(summary.tokens || 0) }),
      )
    }

    // ── 审阅页 ────────────────────────────────────────────────────────────

    /** 主审阅页。 */
    function makePage(ctx, store, bridge, t) {
      return function Page() {
        const snap = useStore(store)
        const [selected, setSelected] = useState(null)
        const [mode, setMode] = useState('timeline')
        const [auto, setAuto] = useState(true)
        const [flash, setFlash] = useState('')
        const [writing, setWriting] = useState(false)
        const sessions = (snap && snap.sessions) || []
        const detail = useRemote(bridge, 'session.get', selected ? { id: selected, maxChars: 12000 } : null, {
          pollMs: auto && selected ? 4000 : 0,
        })
        const markdown = useRemote(bridge, 'markdown.get', selected && mode === 'markdown' ? { id: selected } : null, {
          pollMs: 0,
        })
        useEffect(() => {
          if (!selected && sessions.length > 0) setSelected(sessions[0].id)
        }, [sessions.length, selected])
        useEffect(() => {
          if (!auto) return undefined
          const timer = setInterval(() => void store.refreshSessions(), 5000)
          return () => clearInterval(timer)
        }, [auto, store])
        const write = () => {
          if (!selected) return
          setWriting(true)
          bridge
            .call('write.now', { id: selected })
            .then((result) => {
              setFlash(result && result.path ? t('page.written', { path: result.path }) : '—')
              void store.refreshSessions()
            })
            .catch((error) => setFlash(String(error && error.message ? error.message : error)))
            .finally(() => setWriting(false))
        }
        const selectedRow = sessions.find((row) => row.id === selected)
        return h(
          'div',
          { className: 'lt-root' },
          styleTag(),
          h(
            'div',
            { className: 'lt-head' },
            h('h2', { className: 'lt-title' }, t('page.title')),
            h('span', { className: 'lt-sub' }, t('page.subtitle')),
            h('span', { className: 'lt-spacer' }),
            h(Switch, { on: auto, onChange: setAuto, label: t('page.autoRefresh') }),
            h(
              'span',
              { className: 'lt-seg' },
              h('button', { type: 'button', className: mode === 'timeline' ? 'on' : '', onClick: () => setMode('timeline') }, t('page.timeline')),
              h('button', { type: 'button', className: mode === 'markdown' ? 'on' : '', onClick: () => setMode('markdown') }, t('page.markdown')),
            ),
            h('button', { className: 'lt-btn', type: 'button', onClick: () => void store.refreshSessions() }, t('page.refresh')),
            h(
              'button',
              { className: 'lt-btn pri', type: 'button', disabled: !selected || writing, onClick: write },
              writing ? t('page.writing') : t('page.write'),
            ),
          ),
          flash ? h('div', { className: 'lt-flash', style: { padding: '6px 14px' } }, flash) : null,
          snap && snap.error ? h('div', { className: 'lt-err', style: { margin: 10 } }, `${t('err.title')}：${snap.error}`) : null,
          h(
            'div',
            { className: 'lt-body' },
            h(
              'div',
              { className: 'lt-side' },
              h('h3', null, t('page.sessions')),
              sessions.length === 0 ? h('div', { className: 'lt-note', style: { padding: '0 6px' } }, t('page.empty')) : null,
              sessions.map((row) =>
                h(
                  'div',
                  {
                    key: row.id,
                    className: `lt-row${row.id === selected ? ' on' : ''}`,
                    onClick: () => setSelected(row.id),
                  },
                  h('div', { className: 'lt-row-t' }, shortId(row.id)),
                  h('div', { className: 'lt-row-m' }, row.cwd || '—'),
                  h(
                    'div',
                    { className: 'lt-row-m' },
                    `${row.turns || 0} 轮 · ${row.steps || 0} 步 · ${row.tools || 0} 工具${row.tracked === false ? ' · 未记录' : ''}`,
                    row.writeError ? h('span', { className: 'lt-badge err', style: { marginLeft: 6 } }, '写入失败') : null,
                  ),
                ),
              ),
              snap && snap.configPath ? h('div', { className: 'lt-note', style: { padding: '10px 6px 0' } }, `${t('page.configFile')}：${snap.configPath}`) : null,
            ),
            h(
              'div',
              { className: 'lt-main' },
              !selected
                ? h('div', { className: 'lt-empty' }, t('page.selectSession'))
                : mode === 'markdown'
                  ? renderMarkdownPane(markdown, t)
                  : detail.error
                    ? h(
                        'div',
                        null,
                        h('div', { className: 'lt-err' }, `${t('err.title')}：${detail.error}`),
                        h('button', { className: 'lt-btn', type: 'button', onClick: () => void detail.reload() }, t('err.retry')),
                      )
                    : !detail.data
                      ? h('div', { className: 'lt-empty' }, t('page.selectSession'))
                      : h(
                          'div',
                          null,
                          detail.data.summary ? h(Stats, { summary: detail.data.summary, t }) : null,
                          selectedRow && selectedRow.writeError
                            ? h('div', { className: 'lt-err' }, `写入失败：${selectedRow.writeError}`)
                            : null,
                          h(Timeline, { detail: detail.data, t }),
                        ),
            ),
          ),
        )
      }
    }

    /** Markdown 源码面板。 */
    function renderMarkdownPane(markdown, t) {
      if (markdown.error) return h('div', { className: 'lt-err' }, `${t('err.title')}：${markdown.error}`)
      if (!markdown.data) return h('div', { className: 'lt-empty' }, t('set.reloading'))
      return h(
        'div',
        null,
        markdown.data.path ? h('div', { className: 'lt-note' }, `${markdown.data.path}${markdown.data.truncated ? ` · 已截断（全文 ${num(markdown.data.fullLength)} 字）` : ''}`) : null,
        h('pre', { className: 'lt-pre', style: { maxHeight: 'none' } }, markdown.data.text || ''),
      )
    }

    /** 会话 id 的短形式。 */
    function shortId(id) {
      const text = String(id || '')
      return text.length > 26 ? `${text.slice(0, 26)}…` : text
    }

    /** 毫秒的人读形式。 */
    function humanMs(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
      return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
    }

    // ── 设置页 ────────────────────────────────────────────────────────────

    /** 采集项的中文/英文标题键。 */
    const CAPTURE_KEYS = [
      'systemPrompt',
      'promptAssembly',
      'rawRequest',
      'userMessages',
      'assistantMessages',
      'reasoning',
      'toolCalls',
      'toolResults',
      'files',
      'web',
      'skills',
      'commands',
      'usage',
    ]

    /** 设置页。 */
    function makeSettingsPage(store, bridge, t) {
      return function SettingsPage() {
        const snap = useStore(store)
        const [draft, setDraft] = useState(null)
        const [flash, setFlash] = useState('')
        const [busy, setBusy] = useState(false)
        const workspaces = useRemote(bridge, 'workspaces.list', null, { pollMs: 0 })
        useEffect(() => {
          if (snap && snap.config && !draft) setDraft(JSON.parse(JSON.stringify(snap.config)))
        }, [snap, draft])
        const patch = (mutate) => {
          setDraft((prev) => {
            if (!prev) return prev
            const next = JSON.parse(JSON.stringify(prev))
            mutate(next)
            return next
          })
        }
        const save = () => {
          if (!draft) return
          setBusy(true)
          store
            .save(draft)
            .then(() => setFlash(t('set.saved')))
            .catch((error) => setFlash(t('set.saveFail', { msg: String(error && error.message ? error.message : error) })))
            .finally(() => setBusy(false))
        }
        const reset = () => {
          setBusy(true)
          store
            .reset()
            .then((result) => {
              setDraft(JSON.parse(JSON.stringify(result.config)))
              setFlash(t('set.saved'))
            })
            .catch(() => {})
            .finally(() => setBusy(false))
        }
        if (!draft) {
          return h('div', { className: 'lt-root' }, styleTag(), h('div', { className: 'lt-empty' }, t('set.reloading')))
        }
        const cap = draft.capture || {}
        const scope = draft.scope || {}
        const out = draft.output || {}
        const entries = draft.entries || {}
        const sessionRows = (snap && snap.sessions) || []
        const workspaceRows = (workspaces.data && workspaces.data.workspaces) || []

        const toggleMembership = (list, value, skip) => {
          if (skip) return list
          return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
        }

        return h(
          'div',
          { className: 'lt-root' },
          styleTag(),
          h(
            'div',
            { className: 'lt-head' },
            h('h2', { className: 'lt-title' }, t('set.title')),
            h('span', { className: 'lt-sub' }, t('set.subtitle')),
            h('span', { className: 'lt-spacer' }),
            flash ? h('span', { className: 'lt-flash' }, flash) : null,
            h('button', { className: 'lt-btn', type: 'button', disabled: busy, onClick: reset }, t('set.reset')),
            h('button', { className: 'lt-btn pri', type: 'button', disabled: busy, onClick: save }, t('set.save')),
          ),
          h(
            'div',
            { className: 'lt-main', style: { paddingBottom: 40 } },
            h('div', { className: 'lt-note' }, t('note.independent')),

            h(
              'div',
              { className: 'lt-grp' },
              h('div', { className: 'lt-box', style: { display: 'flex', alignItems: 'center', gap: 12 } },
                h('div', { style: { flex: 1 } },
                  h('h4', null, t('set.enabled')),
                  h('p', null, t('set.enabledDesc')),
                ),
                h(Switch, { on: draft.enabled !== false, onChange: (on) => patch((next) => { next.enabled = on }) }),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.capture')),
              h('p', null, t('set.captureDesc')),
              h(
                'div',
                { className: 'lt-grid' },
                CAPTURE_KEYS.map((key) =>
                  h(
                    'div',
                    { key, className: 'lt-box' },
                    h(
                      'label',
                      { className: 'lt-sw' },
                      h(Switch, {
                        on: cap[key] !== false,
                        onChange: (on) => patch((next) => {
                          next.capture = next.capture || {}
                          next.capture[key] = on
                        }),
                      }),
                      h('span', { style: { fontWeight: 600 } }, t(`cap.${key}`)),
                    ),
                  ),
                ),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.detail')),
              h('p', null, t('set.detailDesc')),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.detail'))),
                h(Segmented, {
                  value: draft.detail || 'standard',
                  options: [
                    { value: 'summary', label: t('set.detail.summary') },
                    { value: 'standard', label: t('set.detail.standard') },
                    { value: 'full', label: t('set.detail.full') },
                  ],
                  onChange: (value) => patch((next) => { next.detail = value }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.maxInlineChars')), h('span', null, t('set.maxInlineCharsDesc'))),
                h('input', {
                  className: 'lt-in num',
                  type: 'number',
                  min: 200,
                  step: 200,
                  value: draft.maxInlineChars ?? 4000,
                  onChange: (event) => patch((next) => { next.maxInlineChars = Number(event.target.value) || 4000 }),
                }),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.rawMode')),
              h('p', null, t('set.rawModeDesc')),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.rawMode'))),
                h(Segmented, {
                  value: draft.rawRequestMode || 'changed',
                  options: [
                    { value: 'changed', label: t('set.rawMode.changed') },
                    { value: 'always', label: t('set.rawMode.always') },
                    { value: 'off', label: t('set.rawMode.off') },
                  ],
                  onChange: (value) => patch((next) => { next.rawRequestMode = value }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.maxRawMessages'))),
                h('input', {
                  className: 'lt-in num',
                  type: 'number',
                  min: 10,
                  step: 10,
                  value: draft.maxRawMessages ?? 300,
                  onChange: (event) => patch((next) => { next.maxRawMessages = Number(event.target.value) || 300 }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.rawBudget')), h('span', null, t('set.rawBudgetDesc'))),
                h('input', {
                  className: 'lt-in num',
                  type: 'number',
                  min: 2000,
                  step: 2000,
                  value: draft.rawRequestBudget ?? 24000,
                  onChange: (event) => patch((next) => { next.rawRequestBudget = Number(event.target.value) || 24000 }),
                }),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.dedupe')),
              h('p', null, t('set.dedupeDesc')),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.dedupeSystem'))),
                h(Switch, {
                  on: draft.dedupeSystem !== false,
                  onChange: (on) => patch((next) => { next.dedupeSystem = on }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.dedupeAssembly'))),
                h(Switch, {
                  on: draft.dedupeAssembly !== false,
                  onChange: (on) => patch((next) => { next.dedupeAssembly = on }),
                }),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.scope')),
              h('p', null, t('set.scopeDesc')),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.scope'))),
                h(Segmented, {
                  value: scope.mode || 'all',
                  options: [
                    { value: 'all', label: t('set.scope.all') },
                    { value: 'include', label: t('set.scope.include') },
                    { value: 'exclude', label: t('set.scope.exclude') },
                  ],
                  onChange: (value) => patch((next) => {
                    next.scope = next.scope || {}
                    next.scope.mode = value
                  }),
                }),
                h(Switch, {
                  on: scope.includeSubagents !== false,
                  onChange: (on) => patch((next) => {
                    next.scope = next.scope || {}
                    next.scope.includeSubagents = on
                  }),
                  label: t('set.includeSubagents'),
                }),
              ),
              h('div', { className: 'lt-note' }, t('set.scopeHint')),
              h('div', { className: 'lt-note', style: { fontWeight: 600 } }, t('set.sessions')),
              h(
                'div',
                null,
                sessionRows.length === 0 ? h('span', { className: 'lt-note' }, t('set.none')) : null,
                sessionRows.map((row) =>
                  h(
                    'span',
                    {
                      key: row.id,
                      className: `lt-chip${(scope.sessions || []).includes(row.id) ? ' on' : ''}`,
                      onClick: () => patch((next) => {
                        next.scope = next.scope || {}
                        const list = Array.isArray(next.scope.sessions) ? next.scope.sessions : []
                        next.scope.sessions = toggleMembership(list, row.id)
                      }),
                    },
                    shortId(row.id),
                  ),
                ),
              ),
              h('div', { className: 'lt-note', style: { fontWeight: 600, marginTop: 8 } }, t('set.workspaces')),
              h(
                'div',
                null,
                workspaceRows.length === 0 ? h('span', { className: 'lt-note' }, t('set.none')) : null,
                workspaceRows.map((row) =>
                  h(
                    'span',
                    {
                      key: row.id,
                      className: `lt-chip${(scope.workspaces || []).some((item) => String(item).toLowerCase() === String(row.path).toLowerCase()) ? ' on' : ''}`,
                      title: row.path,
                      onClick: () => patch((next) => {
                        next.scope = next.scope || {}
                        const list = Array.isArray(next.scope.workspaces) ? next.scope.workspaces : []
                        const has = list.some((item) => String(item).toLowerCase() === String(row.path).toLowerCase())
                        next.scope.workspaces = has ? list.filter((item) => String(item).toLowerCase() !== String(row.path).toLowerCase()) : [...list, row.path]
                      }),
                    },
                    row.title || row.path,
                  ),
                ),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.output')),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.outputDir')), h('span', null, t('set.outputDirDesc'))),
                h('input', {
                  className: 'lt-in txt',
                  type: 'text',
                  value: out.dir ?? 'harness-trace',
                  onChange: (event) => patch((next) => {
                    next.output = next.output || {}
                    next.output.dir = event.target.value
                  }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.writeOn'))),
                h(Segmented, {
                  value: out.writeOn || 'turn',
                  options: [
                    { value: 'turn', label: t('set.writeOn.turn') },
                    { value: 'step', label: t('set.writeOn.step') },
                    { value: 'manual', label: t('set.writeOn.manual') },
                  ],
                  onChange: (value) => patch((next) => {
                    next.output = next.output || {}
                    next.output.writeOn = value
                  }),
                }),
              ),
              h(
                'div',
                { className: 'lt-field' },
                h('div', { className: 'lt-fl' }, h('b', null, t('set.debounce')), h('span', null, t('set.debounceDesc'))),
                h('input', {
                  className: 'lt-in num',
                  type: 'number',
                  min: 300,
                  step: 100,
                  value: out.debounceMs ?? 2500,
                  onChange: (event) => patch((next) => {
                    next.output = next.output || {}
                    next.output.debounceMs = Number(event.target.value) || 2500
                  }),
                }),
              ),
            ),

            h(
              'div',
              { className: 'lt-grp' },
              h('h3', null, t('set.entries')),
              h('p', null, t('set.entriesDesc')),
              [
                ['sidebar', 'set.entry.sidebar'],
                ['settings', 'set.entry.settings'],
                ['conversationTab', 'set.entry.conversationTab'],
                ['headerAction', 'set.entry.headerAction'],
              ].map(([key, labelKey]) =>
                h(
                  'div',
                  { key, className: 'lt-field' },
                  h('div', { className: 'lt-fl' }, h('b', null, t(labelKey))),
                  h(Switch, {
                    on: entries[key] !== false,
                    onChange: (on) => patch((next) => {
                      next.entries = next.entries || {}
                      next.entries[key] = on
                    }),
                  }),
                  h('span', { className: 'lt-sub' }, t('set.order')),
                  h('input', {
                    className: 'lt-in num',
                    type: 'number',
                    value: (entries.order && entries.order[key] !== undefined) ? entries.order[key] : 0,
                    onChange: (event) => patch((next) => {
                      next.entries = next.entries || {}
                      next.entries.order = next.entries.order || {}
                      next.entries.order[key] = Number(event.target.value) || 0
                    }),
                  }),
                ),
              ),
            ),
          ),
        )
      }
    }

    // ── 会话视图与头部动作 ────────────────────────────────────────────────

    /** 会话内「记录」标签页：只看当前会话。 */
    function makeConversationView(bridge, t) {
      return function ConversationView(props) {
        const sessionId = props && props.sessionId ? String(props.sessionId) : null
        const [auto, setAuto] = useState(true)
        const detail = useRemote(bridge, 'session.get', sessionId ? { id: sessionId, maxChars: 12000 } : null, {
          pollMs: auto ? 4000 : 0,
        })
        if (!sessionId) return h('div', { className: 'lt-empty' }, t('page.selectSession'))
        return h(
          'div',
          { className: 'lt-root' },
          styleTag(),
          h(
            'div',
            { className: 'lt-head' },
            h('span', { className: 'lt-title' }, t('tab.title')),
            h('span', { className: 'lt-spacer' }),
            h(Switch, { on: auto, onChange: setAuto, label: t('page.autoRefresh') }),
            h('button', { className: 'lt-btn sm', type: 'button', onClick: () => void detail.reload() }, t('page.refresh')),
          ),
          h(
            'div',
            { className: 'lt-main' },
            detail.error
              ? h('div', { className: 'lt-err' }, `${t('err.title')}：${detail.error}`)
              : detail.data && detail.data.missing
                ? h('div', { className: 'lt-empty' }, t('page.empty'))
                : !detail.data
                  ? h('div', { className: 'lt-empty' }, t('set.reloading'))
                  : h(
                      'div',
                      null,
                      detail.data.summary ? h(Stats, { summary: detail.data.summary, t }) : null,
                      h(Timeline, { detail: detail.data, t }),
                    ),
          ),
        )
      }
    }

    /** 会话头部快捷动作：写入 + 暂停/开始。 */
    function makeHeaderAction(store, bridge, ctx, t) {
      return function HeaderAction() {
        const snap = useStore(store)
        const [flash, setFlash] = useState('')
        const enabled = !snap || !snap.config || snap.config.enabled !== false
        const toggle = () => {
          store
            .save({ enabled: !enabled })
            .then(() => setFlash(!enabled ? t('act.capture') : t('act.pause')))
            .catch(() => {})
        }
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          styleTag(),
          h(
            'button',
            { className: 'lt-btn sm', type: 'button', title: enabled ? t('act.pause') : t('act.capture'), onClick: toggle },
            h('span', { className: enabled ? 'lt-badge ok' : 'lt-badge warn' }, enabled ? '● 记录中' : '‖ 已暂停'),
          ),
          h(
            'button',
            {
              className: 'lt-btn sm',
              type: 'button',
              title: t('act.write'),
              onClick: () => {
                bridge
                  .call('write.now', null)
                  .then(() => setFlash(t('set.saved')))
                  .catch(() => {})
              },
            },
            '⤓',
          ),
          flash ? h('span', { className: 'lt-flash' }, flash) : null,
        )
      }
    }

    /** 侧边栏入口图标。 */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'span',
        { className: 'lt-icons' },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M4 6h8M4 8.5h8M4 11h5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ),
      )
    }

    // ── 装配 ──────────────────────────────────────────────────────────────

    /**
     * 按配置注册全部入口；配置变化时先全部卸载再重建，
     * 因此「入口位置」可以随时按序号调整。
     * @param ctx - 客户端上下文。
     * @param store - 配置存储。
     * @param bridge - 宿主调用器。
     * @param t - 翻译函数。
     */
    function watchEntries(ctx, store, bridge, t) {
      let disposers = []
      let signature = null
      const own = (result) => {
        if (typeof result === 'function') disposers.push(result)
      }
      const unmount = () => {
        while (disposers.length > 0) {
          const dispose = disposers.pop()
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* 忽略 */
          }
        }
      }
      const mount = (config) => {
        const entries = (config && config.entries) || {}
        const order = entries.order || {}
        const orderOf = (key, fallback) => (typeof order[key] === 'number' ? order[key] : fallback)
        const Page = makePage(ctx, store, bridge, t)
        const SettingsPage = makeSettingsPage(store, bridge, t)
        const ConversationView = makeConversationView(bridge, t)
        const HeaderAction = makeHeaderAction(store, bridge, ctx, t)
        if (entries.sidebar !== false) {
          own(ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => h(Page, props)),
          ))
          own(ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: orderOf('sidebar', 30),
                label: () => t('label'),
                locale: NS,
              },
              (props) => h(PanelIcon, props),
            ),
          ))
        }
        if (entries.settings !== false) {
          own(ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SETTINGS_ID,
                order: orderOf('settings', 22),
                label: () => t('label'),
                locale: NS,
              },
              (props) => h(SettingsPage, props),
            ),
          ))
        }
        if (entries.conversationTab !== false) {
          own(ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'trace',
                order: orderOf('conversationTab', 15),
                locale: NS,
                label: () => t('tab.conversation'),
              },
              (props) => h(ConversationView, props),
            ),
          ))
        }
        if (entries.headerAction !== false) {
          own(ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: HEADER_ACTION_ID,
                order: orderOf('headerAction', 12),
                locale: NS,
                label: () => t('act.write'),
              },
              (props) => h(HeaderAction, props),
            ),
          ))
        }
      }
      const sync = (snapshot) => {
        // 读不到配置（宿主半不可用、或 RPC 失败）时用一套内置默认入口挂载：
        // 让界面至少可见并给出错误提示，而不是整个插件静默消失。
        const config = snapshot && snapshot.config ? snapshot.config : LAST_RESORT
        if (!config) return
        const next = JSON.stringify({ e: config.entries ? config.entries : {} })
        if (next === signature) return
        signature = next
        unmount()
        try {
          mount(config)
        } catch {
          /* 装配失败不影响其余入口 */
        }
      }
      return {
        start() {
          const unsubscribe = store.subscribe(sync)
          if (store.value) sync(store.value)
          else void store.load(false)
          return () => {
            unsubscribe()
            unmount()
          }
        },
      }
    }

    return {
      name: '@local/dsh-harness-trace',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-harness-trace: dictionaries')
        const t = ctx.locale.bind(NS)
        const bridge = makeBridge(ctx)
        const store = createStore(bridge)
        void store.load(false)
        const watcher = watchEntries(ctx, store, bridge, t)
        ctx.effect(() => watcher.start(), 'dsh-harness-trace: entries')
      },
    }
  },
})
