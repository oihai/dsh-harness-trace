/**
 * dsh-harness-trace — 宿主半（Host half）。
 *
 * 职责：持续监听本地 Harness 与 LLM 的交互，把「每轮次 / 每步」依时间关系拼接成
 * 一条可读的时间线，并汇总为 Markdown 落在该会话对应的工作区内。
 *
 * 采集来源（全部来自 Harness 自身的事件契约，不依赖任何第三方插件）：
 *   - `session/event`          会话日志的权威提交流：轮次/步骤边界、用户输入、
 *                              系统提示词（含各插件注入）、注入内容、助手回复、
 *                              工具调用与结果、请求头（模型与工具表）。
 *   - `llm/stream`（waterfall）每次模型流式调用前的「冻结请求」：真正发出去的
 *                              messages / system / tools，用于核对完整提示词。
 *   - `system-prompt/assemble` 系统提示词的装配结果，用于分辨哪一段由谁注入。
 *
 * 落盘：`<会话 cwd>/<output.dir>/<序号>-<时间>.md`，一次会话一个文件，
 * 后续轮次持续追加（整体重写）。文件名 = 序号 + 时间。
 */

import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-harness-trace'

/**
 * 与浏览器半的通信入口。
 *
 * 走**共享 `/api` 通道上的精确 Fetch 路由**，而不是自建顶层通道
 * （`connection.rpc.handle('/harness-trace')`）：在 Desktop 组合里网页由
 * `dsh-desktop-next/webserver` 提供，它不组合插件自建的顶层路由，
 * 请求会落到静态兜底上返回 405。`/api` 是所有部署都存在的通道，
 * 精确路由优先于该通道上的拦截器，因此这条路径在 Web 与 Desktop
 * 两种组合下都成立。
 */
const API_CHANNEL = '/api'
const API_ENDPOINT = 'harness-trace'
const API_PATH = `${API_CHANNEL}/${API_ENDPOINT}`

/** 配置版本，用于将来迁移。 */
const CONFIG_VERSION = 1

/** 默认配置：每一项都对应 UI 上一个可调开关。 */
const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  enabled: true,
  capture: {
    systemPrompt: true,
    promptAssembly: true,
    rawRequest: true,
    userMessages: true,
    assistantMessages: true,
    reasoning: true,
    toolCalls: true,
    toolResults: true,
    files: true,
    web: true,
    skills: true,
    commands: true,
    usage: true,
  },
  detail: 'standard',
  maxInlineChars: 4000,
  rawRequestMode: 'changed',
  maxRawMessages: 300,
  rawRequestBudget: 24000,
  dedupeAssembly: true,
  dedupeSystem: true,
  scope: {
    mode: 'all',
    sessions: [],
    workspaces: [],
    includeSubagents: true,
  },
  output: {
    dir: 'harness-trace',
    layout: 'session',
    writeOn: 'turn',
    debounceMs: 2500,
  },
  entries: {
    sidebar: true,
    settings: true,
    conversationTab: true,
    headerAction: true,
    order: { sidebar: 30, settings: 22, conversationTab: 15, headerAction: 12 },
  },
}

// ────────────────────────────────────────────────────────────────────────────
// 通用小工具
// ────────────────────────────────────────────────────────────────────────────

/** DSH 主目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** `YYYYMMDD-HHmmss`，文件名安全（不含冒号）。 */
function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 本地时间 `HH:mm:ss`，用于时间线。 */
function clock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--:--'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 耗时显示。 */
function humanMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

/** 千分位整数。 */
function num(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '0'
}

/** 只保留 JSON 可表达的结构，带深度与循环保护。 */
function plain(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return String(value)
  if (t === 'function' || t === 'symbol') return undefined
  if (depth > 8) return '[深度截断]'
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[循环]'
    seen.add(value)
    const out = []
    for (const item of value.slice(0, 500)) {
      const v = plain(item, depth + 1, seen)
      if (v !== undefined) out.push(v)
    }
    seen.delete(value)
    return out
  }
  if (t === 'object') {
    if (seen.has(value)) return '[循环]'
    seen.add(value)
    const out = {}
    let i = 0
    for (const key of Object.keys(value)) {
      if (i++ > 200) break
      const v = plain(value[key], depth + 1, seen)
      if (v !== undefined) out[key] = v
    }
    seen.delete(value)
    return out
  }
  return String(value)
}

/** 把消息 content（字符串或内容块数组）转成可读文本。 */
function blocksToText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (!block || typeof block !== 'object') continue
      switch (block.type) {
        case 'text':
          parts.push(String(block.text ?? ''))
          break
        case 'reasoning':
          parts.push(`[推理]\n${String(block.text ?? '')}`)
          break
        case 'image':
          parts.push(`[图片 ${block.attachment?.mediaType ?? ''} ${block.attachment?.bytes ?? ''}B]`)
          break
        case 'file':
          parts.push(`[文件 ${block.attachment?.name ?? ''} ${block.attachment?.bytes ?? ''}B]`)
          break
        case 'tool-call':
          parts.push(`[工具调用 ${block.name ?? ''} ${block.arguments ?? ''}]`)
          break
        case 'tool-addition':
          parts.push(`[工具加入 ${block.toolName ?? ''}]`)
          break
        case 'tool-removal':
          parts.push(`[工具移除 ${block.toolName ?? ''}]`)
          break
        default:
          parts.push(`[${String(block.type ?? '块')}]`)
      }
    }
    return parts.join('\n\n')
  }
  return String(content)
}

/** 工具名 → 归类，用于「文件 / 联网 / 技能 / 命令」等专题汇总。 */
const TOOL_CATEGORY = {
  skill: 'skill',
  read: 'file-read',
  read_image: 'file-read',
  glob: 'file-read',
  grep: 'file-read',
  lsp: 'file-read',
  write: 'file-write',
  edit: 'file-write',
  web_search: 'web',
  web_fetch: 'web',
  pwsh: 'command',
  bash: 'command',
  job_output: 'command',
  job_list: 'command',
  job_kill: 'command',
}

/** 判定工具归类。 */
function categoryOf(toolName) {
  const key = String(toolName ?? '')
  if (TOOL_CATEGORY[key]) return TOOL_CATEGORY[key]
  if (/^web[_-]/.test(key) || key === 'web_search' || key === 'web_fetch') return 'web'
  if (/^(read|grep|glob|list|stat|search)/.test(key)) return 'file-read'
  if (/^(write|edit|mkdir|apply)/.test(key)) return 'file-write'
  if (/^(bash|pwsh|shell|terminal|job|exec)/.test(key)) return 'command'
  if (/^skill/.test(key)) return 'skill'
  return 'tool'
}

/** 归类的中文名与图标，供 Markdown 与 UI 复用。 */
const CATEGORY_LABEL = {
  'file-read': '读取文件',
  'file-write': '写入文件',
  web: '联网',
  skill: '加载技能',
  command: '执行命令',
  tool: '工具调用',
  system: '系统提示词',
  inject: '注入内容',
  user: '用户输入',
  assistant: '模型回复',
  request: '模型请求',
  raw: '原始请求',
  assembly: '提示词装配',
}

/** 安全 JSON 解析。 */
function tryParseJson(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 从工具参数里取一个字符串字段。 */
function pickString(args, keys) {
  if (!args || typeof args !== 'object') return undefined
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

/** 深合并配置（数组整体替换）。 */
function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const key of Object.keys(patch)) {
    const next = patch[key]
    if (next === undefined) continue
    const prev = out[key]
    if (
      next &&
      typeof next === 'object' &&
      !Array.isArray(next) &&
      prev &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = mergeConfig(prev, next)
    } else {
      out[key] = Array.isArray(next) ? [...next] : next
    }
  }
  return out
}

/** 规范化路径，用于工作区范围匹配。 */
function normPath(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

// ────────────────────────────────────────────────────────────────────────────
// 记录器
// ────────────────────────────────────────────────────────────────────────────

/**
 * 创建一个记录器：持有配置、每会话时间线、落盘队列与全部 RPC 端点。
 * @param ctx - 插件上下文。
 * @param initial - 来自 cordis.patch.yml 的初始配置（可为空）。
 */
function createRecorder(ctx, initial) {
  /** 当前生效配置。 */
  let config = mergeConfig(DEFAULT_CONFIG, initial && typeof initial === 'object' ? initial : {})

  /** 会话 id → 时间线状态。 */
  const sessions = new Map()
  /** 输出目录 → 分配序号用的串行锁。 */
  const dirLocks = new Map()
  /** 延迟落盘的定时器。 */
  const timers = new Set()
  /** 最近一次落盘错误，供 UI 展示。 */
  let lastError = null
  /** 落盘计数。 */
  let writeCount = 0

  const configPath = () => join(dshHome(), 'harness-trace', 'config.json')

  /** 读取持久化配置（失败保持默认）。 */
  async function loadConfig() {
    try {
      const raw = await readFile(configPath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') config = mergeConfig(DEFAULT_CONFIG, parsed)
    } catch {
      /* 首次运行或文件损坏：沿用默认 */
    }
  }

  /** 持久化配置。 */
  async function saveConfig() {
    const file = configPath()
    await mkdir(join(dshHome(), 'harness-trace'), { recursive: true })
    const snapshot = plain(config, 0, new WeakSet())
    await writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8')
    return file
  }

  // ── 范围判定 ──────────────────────────────────────────────────────────────

  /** 该会话是否在记录范围内。 */
  function sessionAllowed(state) {
    if (!config.enabled) return false
    const scope = config.scope || {}
    if (scope.includeSubagents === false && state.parentSession) return false
    const mode = scope.mode === 'include' || scope.mode === 'exclude' ? scope.mode : 'all'
    if (mode === 'all') return true
    const ids = new Set(
      (Array.isArray(scope.sessions) ? scope.sessions : [])
        .map((v) => String(v ?? '').trim())
        .filter(Boolean),
    )
    const dirs = (Array.isArray(scope.workspaces) ? scope.workspaces : [])
      .map(normPath)
      .filter(Boolean)
    const cwd = normPath(state.cwd)
    const hitId = ids.has(state.id)
    const hitDir = dirs.length > 0 && cwd !== '' && dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`) || cwd.endsWith(`/${d}`))
    const listed = hitId || hitDir
    return mode === 'include' ? listed : !listed
  }

  // ── 会话状态 ──────────────────────────────────────────────────────────────

  /** 取（必要时创建）一个会话的时间线状态。 */
  function stateFor(session) {
    const id = String(session?.id ?? 'unknown')
    let state = sessions.get(id)
    if (state) return state
    const header = session && session.header ? session.header : {}
    state = {
      id,
      cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : Date.now(),
      agentPreset: header.agentPreset,
      parentSession: header.parentSession,
      origin: header.origin,
      model: null,
      turns: [],
      currentTurn: null,
      currentStep: null,
      pendingCalls: new Map(),
      lastRawMessages: null,
      fileReads: new Map(),
      fileWrites: new Map(),
      stats: { tools: 0, steps: 0, turns: 0, skills: [], web: [] },
      dirty: false,
      timer: null,
      filePath: null,
      fileName: null,
      order: null,
      updatedAt: Date.now(),
      lastWriteAt: null,
      writeError: null,
    }
    sessions.set(id, state)
    return state
  }

  /** 取当前应挂载事件的容器（步骤优先，否则轮次前言，否则会话前言）。 */
  function bucketOf(state) {
    if (state.currentStep) return state.currentStep.items
    if (state.currentTurn) return state.currentTurn.preamble
    if (!state.orphanItems) state.orphanItems = []
    return state.orphanItems
  }

  /** 追加一条时间线条目。 */
  function push(state, item) {
    item.time = typeof item.time === 'number' ? item.time : Date.now()
    bucketOf(state).push(item)
    state.updatedAt = item.time
    markDirty(state)
  }

  /** 标注有变更并按策略安排落盘。 */
  function markDirty(state) {
    state.dirty = true
    const writeOn = config.output?.writeOn
    if (writeOn === 'step') return // 由 step/end 直接触发
    if (state.timer) return
    const delay = Math.max(300, Number(config.output?.debounceMs) || 2500)
    const timer = setTimeout(() => {
      state.timer = null
      timers.delete(timer)
      void writeSession(state)
    }, delay)
    state.timer = timer
    timers.add(timer)
  }

  // ── 事件处理 ──────────────────────────────────────────────────────────────

  /** 处理一条已提交的会话事件。 */
  function onSessionEvent(session, event) {
    try {
      if (!event || typeof event !== 'object') return
      const id = String((session && session.id) || 'unknown')
      let state = sessions.get(id)
      if (!state) {
        const header = (session && session.header) || {}
        const probe = { id, cwd: header.cwd, parentSession: header.parentSession }
        if (!sessionAllowed(probe)) return
        state = stateFor(session)
      }
      handleEvent(state, event, event.data || {})
    } catch (error) {
      lastError = `事件处理失败：${String(error && error.message ? error.message : error)}`
    }
  }

  /** 把一条事件写进时间线。 */
  function handleEvent(state, event, data) {
    const time = typeof event.time === 'number' ? event.time : Date.now()
    switch (event.type) {
      case 'turn/start': {
        const turn = {
          turn: data.turn,
          time0: time,
          time1: null,
          reason: null,
          preamble: [],
          steps: [],
          usage: null,
        }
        state.turns.push(turn)
        state.currentTurn = turn
        state.currentStep = null
        state.stats.turns = state.turns.length
        return
      }
      case 'turn/end': {
        if (state.currentTurn) {
          state.currentTurn.time1 = time
          state.currentTurn.reason = plain(data.reason, 0, new WeakSet())
        }
        state.currentTurn = null
        state.currentStep = null
        finalizeTurn(state, state.turns[state.turns.length - 1], time)
        return
      }
      case 'step/start': {
        if (!state.currentTurn) {
          const turn = {
            turn: data.turn,
            time0: time,
            time1: null,
            reason: null,
            preamble: [],
            steps: [],
            usage: null,
          }
          state.turns.push(turn)
          state.currentTurn = turn
          state.stats.turns = state.turns.length
        }
        const step = { step: data.step, time0: time, time1: null, items: [], usage: null }
        state.currentTurn.steps.push(step)
        state.currentStep = step
        state.stats.steps += 1
        return
      }
      case 'step/end': {
        if (state.currentStep) state.currentStep.time1 = time
        state.currentStep = null
        if (config.output?.writeOn === 'step') void writeSession(state)
        return
      }
      case 'user/message': {
        if (!config.capture.userMessages) return
        if (!state.currentTurn) {
          const turn = {
            turn: state.turns.length + 1,
            time0: time,
            time1: null,
            reason: null,
            preamble: [],
            steps: [],
            usage: null,
            synthetic: true,
          }
          state.turns.push(turn)
          state.currentTurn = turn
          state.stats.turns = state.turns.length
        }
        push(state, { k: 'user', time, text: blocksToText(data.content) })
        return
      }
      case 'system/message': {
        if (!config.capture.systemPrompt) return
        const text = blocksToText(data.message?.content)
        // 同一步骤会为每次模型调用重复提交同一份系统提示词：内容未变时只留一个位置标记，
        // 避免整份提示词被反复写入而撑爆文件。
        if (config.dedupeSystem !== false) {
          const signature = simpleSignature([{ role: 'system', text }])
          const bucket = bucketOf(state)
          for (let i = bucket.length - 1; i >= 0; i--) {
            if (bucket[i].k === 'system') {
              if (bucket[i].signature === signature) {
                push(state, { k: 'system', time, unchanged: true, signature })
                return
              }
              break
            }
          }
          push(state, { k: 'system', time, text, signature, seq: event.seq })
          return
        }
        push(state, { k: 'system', time, text, seq: event.seq })
        return
      }
      case 'developer/message': {
        if (!config.capture.systemPrompt) return
        push(state, {
          k: 'inject',
          time,
          text: blocksToText(data.message?.content),
          turn: data.turn,
          step: data.step,
        })
        return
      }
      case 'assistant/message': {
        if (!config.capture.assistantMessages) return
        const text = blocksToText(data.message?.content)
        const usage = config.capture.usage && data.usage ? plain(data.usage, 0, new WeakSet()) : null
        if (state.currentStep) {
          state.currentStep.usage = usage
          state.currentStep.model = {
            provider: data.message?.source?.provider,
            model: data.message?.source?.model,
          }
        }
        if (usage) {
          const turn = state.currentTurn || state.turns[state.turns.length - 1]
          if (turn) turn.usage = usage
        }
        if (data.message?.source?.model) {
          state.model = { provider: data.message?.source?.provider, model: data.message?.source?.model }
        }
        push(state, {
          k: 'assistant',
          time,
          text,
          reasoning: config.capture.reasoning ? extractReasoning(data.message?.content) : undefined,
          usage,
          interrupted: data.interrupted === true,
          model: state.model,
        })
        return
      }
      case 'tool/call': {
        if (!config.capture.toolCalls) return
        const category = categoryOf(data.name)
        if (category === 'skill' && !config.capture.skills) return
        if (category === 'web' && !config.capture.web) return
        if ((category === 'file-read' || category === 'file-write') && !config.capture.files) return
        if (category === 'command' && !config.capture.commands) return
        const args = tryParseJson(data.arguments)
        const item = {
          k: 'tool',
          category,
          time,
          callId: String(data.callId ?? ''),
          name: String(data.name ?? ''),
          args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null),
          parsed: args,
          subject: describeSubject(category, data.name, args),
          result: null,
          resultState: 'pending',
        }
        state.stats.tools += 1
        if (category === 'skill') {
          const name = pickString(args, ['name', 'skill', 'skillName']) || item.subject
          if (name && !state.stats.skills.includes(name)) state.stats.skills.push(name)
          item.skill = name
        }
        if (category === 'web') {
          const q = pickString(args, ['query', 'url', 'queries'])
          if (q) state.stats.web.push(q)
        }
        if (category === 'file-read' || category === 'file-write') {
          const path = pickString(args, ['path', 'file_path', 'filePath', 'target', 'file'])
          if (path) {
            const map = category === 'file-read' ? state.fileReads : state.fileWrites
            map.set(path, (map.get(path) || 0) + 1)
          }
        }
        if (item.callId) state.pendingCalls.set(item.callId, item)
        push(state, item)
        return
      }
      case 'tool/result': {
        // 结果与调用的关联键：ToolResultMessage 同时携带顶层 `toolCallId` 与 `source.callId`，两者都接受。
        const callId = String(data.message?.source?.callId ?? data.message?.toolCallId ?? '')
        const item = callId ? state.pendingCalls.get(callId) : undefined
        const text = blocksToText(data.message?.content)
        const record = {
          text,
          isError: data.message?.isError === true || Boolean(data.error),
          error: data.error ? plain(data.error, 0, new WeakSet()) : undefined,
          meta: config.capture.usage && data.meta ? plain(data.meta, 0, new WeakSet()) : undefined,
        }
        if (item) {
          item.result = record
          item.resultState = record.isError ? 'error' : 'ok'
          item.resultTime = time
          state.pendingCalls.delete(callId)
          state.dirty = true
        } else if (config.capture.toolResults) {
          push(state, {
            k: 'result',
            time,
            callId,
            text,
            isError: record.isError,
            error: record.error,
          })
        }
        markDirty(state)
        return
      }
      case 'request/header': {
        if (!config.capture.systemPrompt && !config.capture.rawRequest) return
        const header = data.header || {}
        const tools = Array.isArray(header.tools) ? header.tools : []
        push(state, {
          k: 'request',
          time,
          reason: data.reason,
          startsSeries: data.startsSeries === true,
          config: plain(header.config, 0, new WeakSet()),
          adapterDefaults: plain(header.adapterDefaults, 0, new WeakSet()),
          toolCount: tools.length,
          tools: tools.map((t) => ({ name: t?.name, description: t?.description })),
        })
        return
      }
      case 'request/context': {
        if (!config.capture.systemPrompt) return
        push(state, { k: 'context', time, context: plain(data, 0, new WeakSet()) })
        return
      }
      default:
        return
    }
  }

  /** 从助手消息内容块里提取推理文本。 */
  function extractReasoning(content) {
    if (!Array.isArray(content)) return undefined
    const parts = content.filter((b) => b && b.type === 'reasoning').map((b) => String(b.text ?? ''))
    const text = parts.join('\n\n').trim()
    return text === '' ? undefined : text
  }

  /** 为工具调用生成一句话主题（便于表格阅读）。 */
  function describeSubject(category, toolName, args) {
    if (!args || typeof args !== 'object') return ''
    if (category === 'file-read' || category === 'file-write') {
      return pickString(args, ['path', 'file_path', 'filePath', 'pattern', 'glob', 'query']) || ''
    }
    if (category === 'web') return pickString(args, ['query', 'url']) || ''
    if (category === 'command') return pickString(args, ['command', 'cmd']) || ''
    if (category === 'skill') return pickString(args, ['name', 'skill', 'skillName']) || ''
    return pickString(args, ['path', 'query', 'name', 'command']) || ''
  }

  /** 轮次结束时收尾并落盘。 */
  function finalizeTurn(state, turn, time) {
    if (!turn) return
    if (turn.time1 === null) turn.time1 = time
    void writeSession(state)
  }

  /** 记录一次冻结的模型请求（来自 llm/stream）。 */
  function recordRawRequest(options) {
    try {
      if (!config.enabled || !config.capture.rawRequest) return
      const sessionId = options && options.sessionId ? String(options.sessionId) : null
      if (!sessionId) return
      const session = ctx.get && ctx.get('sessions') ? ctx.get('sessions').get(sessionId) : undefined
      const state = sessions.get(sessionId)
      const probe = state || { id: sessionId, cwd: session?.header?.cwd, parentSession: session?.header?.parentSession }
      if (!sessionAllowed(probe)) return
      const target = state || stateFor(session || { id: sessionId, header: { cwd: probe.cwd } })
      const messages = Array.isArray(options.messages)
        ? options.messages.map((m) => ({
            role: String(m?.role ?? ''),
            text: blocksToText(m?.content),
            origin: m?.source ? String(m.source.kind ?? '') : undefined,
            provider: m?.source && m.source.kind === 'model' ? m.source.provider : undefined,
            model: m?.source && m.source.kind === 'model' ? m.source.model : undefined,
          }))
        : []
      const signature = simpleSignature(messages)
      const changed = target.lastRawMessages !== signature
      const record = {
        k: 'raw',
        time: Date.now(),
        provider: options.provider,
        model: options.model,
        purpose: options.purpose,
        messageCount: messages.length,
        messages,
        system: typeof options.system === 'string' ? options.system : undefined,
        tools: Array.isArray(options.tools) ? options.tools.map((t) => ({ name: t?.name, description: t?.description })) : [],
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        changed,
      }
      if (options.provider || options.model) {
        target.model = { provider: options.provider, model: options.model }
      }
      target.lastRawMessages = signature
      push(target, record)
      return target.id
    } catch (error) {
      lastError = `记录原始请求失败：${String(error && error.message ? error.message : error)}`
      return undefined
    }
  }

  /** 请求消息的轻量指纹，用于判断与上一次是否相同。 */
  function simpleSignature(messages) {
    let hash = 2166136261
    for (const m of messages) {
      const s = `${m.role}\u0000${m.text.length}\u0000${m.text.slice(0, 200)}`
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
    }
    return `${messages.length}:${(hash >>> 0).toString(36)}`
  }

  /** 记录一次模型调用的结果（用量与结束原因），并入相邻的 raw 条目。 */
  function recordStreamOutcome(options, usage, finish) {
    try {
      const sessionId = options && options.sessionId ? String(options.sessionId) : null
      if (!sessionId) return
      const state = sessions.get(sessionId)
      if (!state) return
      const items = bucketOf(state)
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        if (item.k === 'raw' && item.outcome === undefined) {
          item.outcome = { usage: plain(usage, 0, new WeakSet()), finish: plain(finish, 0, new WeakSet()) }
          item.attemptTime = Date.now()
          break
        }
      }
      state.dirty = true
    } catch {
      /* 结果记录失败不影响主流程 */
    }
  }

  /** 记录一次系统提示词装配结果。 */
  function recordAssembly(assembly, context) {
    try {
      if (!config.enabled || !config.capture.promptAssembly) return
      const sessionId =
        context && (context.sessionId || (context.agent && context.agent.id))
          ? String(context.sessionId || context.agent.id)
          : null
      if (!sessionId) return
      const state = sessions.get(sessionId)
      const probe = state || { id: sessionId, cwd: undefined }
      if (!sessionAllowed(probe)) return
      const target = state || stateFor({ id: sessionId, header: {} })
      const sections = Array.isArray(assembly?.sections)
        ? assembly.sections.map((s, i) => ({
            name: s?.name,
            order: i,
            text: typeof s?.text === 'string' ? s.text : blocksToText(s?.content),
          }))
        : []
      const contexts = Array.isArray(assembly?.contexts)
        ? assembly.contexts.map((c, i) => ({
            name: c?.name,
            order: i,
            text: typeof c?.text === 'string' ? c.text : blocksToText(c?.content),
          }))
        : []
      const variables = assembly?.variables ? plain(assembly.variables, 0, new WeakSet()) : undefined
      const tools = Array.isArray(assembly?.tools) ? assembly.tools.map((t) => ({ name: t?.name, description: t?.description })) : undefined
      // 同一套装配在同一步骤里会对每次模型调用重复触发；内容未变时不再记录，避免文件被同一份提示词撑爆。
      const signature = simpleSignature([
        { role: 'sections', text: sections.map((s) => `${s.name}\u0001${s.text}`).join('\u0002') },
        { role: 'contexts', text: contexts.map((c) => `${c.name}\u0001${c.text}`).join('\u0002') },
      ])
      let lastSignature = null
      const bucket = bucketOf(target)
      for (let i = bucket.length - 1; i >= 0; i--) {
        if (bucket[i].k === 'assembly') {
          lastSignature = bucket[i].signature
          break
        }
      }
      if (config.dedupeAssembly !== false && lastSignature === signature) return
      push(target, {
        k: 'assembly',
        signature,
        time: Date.now(),
        sections,
        contexts,
        variables,
        tools,
      })
    } catch (error) {
      lastError = `记录提示词装配失败：${String(error && error.message ? error.message : error)}`
    }
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────────

  /** 该会话的输出目录（优先工作区内）。 */
  function outDirFor(state) {
    const sub = String(config.output?.dir || 'harness-trace')
    if (typeof state.cwd === 'string' && state.cwd.trim() !== '') return join(state.cwd, sub)
    return join(dshHome(), 'harness-trace', 'out')
  }

  /** 串行分配序号并确定文件名，避免并发重名。 */
  async function ensureFile(state) {
    if (state.filePath) return state.filePath
    const dir = outDirFor(state)
    const previous = dirLocks.get(dir) || Promise.resolve()
    const job = previous.then(async () => {
      if (state.filePath) return state.filePath
      let order = 1
      let targetDir = dir
      try {
        await mkdir(targetDir, { recursive: true })
        const entries = await readdir(targetDir)
        for (const entry of entries) {
          const match = /^(\d+)-/.exec(entry)
          if (match) order = Math.max(order, Number(match[1]) + 1)
        }
      } catch {
        // 工作区不可写：退回到 DSH 主目录
        targetDir = join(dshHome(), 'harness-trace', 'out')
        await mkdir(targetDir, { recursive: true })
        const entries = await readdir(targetDir)
        for (const entry of entries) {
          const match = /^(\d+)-/.exec(entry)
          if (match) order = Math.max(order, Number(match[1]) + 1)
        }
      }
      const fileName = `${String(order).padStart(4, '0')}-${stamp(new Date(state.createdAt || Date.now()))}.md`
      state.order = order
      state.fileName = fileName
      state.filePath = join(targetDir, fileName)
      return state.filePath
    })
    dirLocks.set(
      dir,
      job.catch(() => {}),
    )
    return job
  }

  /** 把一个会话的时间线渲染成 Markdown 并写入磁盘。 */
  async function writeSession(state) {
    if (!state || !config.enabled) return null
    try {
      const target = await ensureFile(state)
      const markdown = renderMarkdown(state, config)
      await writeFile(target, markdown, 'utf8')
      state.dirty = false
      state.lastWriteAt = Date.now()
      state.writeError = null
      writeCount += 1
      return target
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      state.writeError = message
      lastError = `写入失败：${message}`
      return null
    }
  }

  /** 立即写入全部会话（UI 的手动触发）。 */
  async function writeAll() {
    const out = []
    for (const state of sessions.values()) {
      const path = await writeSession(state)
      out.push({ id: state.id, path, error: state.writeError })
    }
    return out
  }

  // ── Markdown 渲染 ─────────────────────────────────────────────────────────

  /** 按详细程度决定正文呈现。 */
  function body(text, level, opts = {}) {
    const raw = typeof text === 'string' ? text : ''
    if (raw.trim() === '') return '_(空)_\n'
    const limit = Math.max(200, Number(config.maxInlineChars) || 4000)
    if (level === 'summary') {
      const oneLine = raw.replace(/\s+/g, ' ').trim()
      return `${oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine}\n`
    }
    if (raw.length <= limit) {
      return `\`\`\`${opts.lang || 'text'}\n${fenceSafe(raw)}\n\`\`\`\n`
    }
    if (level === 'standard') {
      return `\`\`\`${opts.lang || 'text'}\n${fenceSafe(raw.slice(0, limit))}\n\`\`\`\n\n_（已截断，原文 ${num(raw.length)} 字；调高「单条上限」或改用「完整」级别可看全）_\n`
    }
    return `<details><summary>展开全文（${num(raw.length)} 字）</summary>\n\n\`\`\`${opts.lang || 'text'}\n${fenceSafe(raw)}\n\`\`\`\n\n</details>\n`
  }

  /** 避免正文里出现 ``` 时破坏围栏。 */
  function fenceSafe(text) {
    return String(text).replace(/```/g, '``\u200b`')
  }

  /** 渲染整个会话的 Markdown。 */
  function renderMarkdown(state, cfg) {
    const level = cfg.detail === 'full' || cfg.detail === 'summary' ? cfg.detail : 'standard'
    const lines = []
    const caption = state.id.length > 18 ? `${state.id.slice(0, 18)}…` : state.id
    lines.push(`# Harness 交互追踪 · ${caption}`)
    lines.push('')
    lines.push('> 本文件由 DSH 插件「Harness 交互追踪」自动生成，持续追加。研究用途：观察 Harness 与模型的真实交互。')
    lines.push('')
    lines.push('| 项目 | 值 |')
    lines.push('| --- | --- |')
    lines.push(`| 会话 ID | \`${state.id}\` |`)
    lines.push(`| 工作区 | \`${state.cwd ?? '（未知）'}\` |`)
    lines.push(`| 模型 | \`${state.model ? `${state.model.provider}/${state.model.model}` : '（未捕获）'}\` |`)
    lines.push(`| 预设 | \`${state.agentPreset ?? '（默认）'}\` |`)
    if (state.parentSession) lines.push(`| 父会话 | \`${state.parentSession}\` |`)
    lines.push(`| 会话创建 | ${new Date(state.createdAt).toLocaleString('zh-CN')} |`)
    lines.push(`| 记录级别 | ${level === 'full' ? '完整' : level === 'summary' ? '摘要' : '标准'} |`)
    lines.push(`| 生成时间 | ${new Date().toLocaleString('zh-CN')} |`)
    lines.push(`| 文件序号 | ${state.order ?? '（待分配）'} |`)
    lines.push('')
    lines.push(renderSessionSummary(state))
    lines.push(...renderGlobalSections(state))
    lines.push('## 时间线')
    lines.push('')
    if (state.orphanItems && state.orphanItems.length > 0) {
      lines.push('### 轮次之外')
      lines.push('')
      lines.push(...renderItems(state.orphanItems, state, level, 'orphan'))
      lines.push('')
    }
    for (const turn of state.turns) {
      lines.push(...renderTurn(state, turn, level))
    }
    if (state.turns.length === 0 && (!state.orphanItems || state.orphanItems.length === 0)) {
      lines.push('_（本次会话还没有可记录的交互）_')
      lines.push('')
    }
    lines.push('---')
    lines.push('')
    lines.push(`_最后写入：${state.lastWriteAt ? new Date(state.lastWriteAt).toLocaleString('zh-CN') : '尚未写入'}_`)
    lines.push('')
    return lines.join('\n')
  }

  /** 会话级统计表。 */
  function renderSessionSummary(state) {
    const usage = aggregateUsage(state)
    const lines = []
    lines.push('## 会话概览')
    lines.push('')
    lines.push('| 轮次 | 步骤 | 工具调用 | 读取文件 | 写入文件 | 联网 | 技能 | 输入 tokens | 输出 tokens |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    lines.push(
      `| ${state.stats.turns} | ${state.stats.steps} | ${state.stats.tools} | ${state.fileReads.size} | ${state.fileWrites.size} | ${state.stats.web.length} | ${state.stats.skills.length} | ${num(usage.inputTokens)} | ${num(usage.outputTokens)} |`,
    )
    lines.push('')
    return lines.join('\n')
  }

  /** 汇总整会话的 token 用量。 */
  function aggregateUsage(state) {
    const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const visit = (usage) => {
      if (!usage || typeof usage !== 'object') return
      for (const key of Object.keys(total)) {
        if (typeof usage[key] === 'number') total[key] += usage[key]
      }
    }
    for (const turn of state.turns) {
      visit(turn.usage)
      for (const step of turn.steps) visit(step.usage)
    }
    return total
  }

  /** 专题汇总：文件、联网、技能、命令。 */
  function renderGlobalSections(state) {
    const lines = []
    if (state.fileReads.size > 0 || state.fileWrites.size > 0) {
      lines.push('## 文件访问汇总')
      lines.push('')
      lines.push('| 文件 | 读取 | 写入 |')
      lines.push('| --- | --- | --- |')
      const paths = new Set([...state.fileReads.keys(), ...state.fileWrites.keys()])
      for (const path of paths) {
        const r = state.fileReads.get(path) || 0
        const w = state.fileWrites.get(path) || 0
        lines.push(`| \`${path.replace(/\|/g, '\\|')}\` | ${r} | ${w} |`)
      }
      lines.push('')
    }
    if (state.stats.web.length > 0) {
      lines.push('## 联网活动汇总')
      lines.push('')
      const seen = new Set()
      for (const q of state.stats.web) {
        if (seen.has(q)) continue
        seen.add(q)
        lines.push(`- \`${q}\``)
      }
      lines.push('')
    }
    if (state.stats.skills.length > 0) {
      lines.push('## 技能加载汇总')
      lines.push('')
      for (const s of state.stats.skills) lines.push(`- ${s}`)
      lines.push('')
    }
    return lines
  }

  /** 单轮渲染。 */
  function renderTurn(state, turn, level) {
    const lines = []
    const title = turn.synthetic ? `第 ${turn.turn} 轮（推断）` : `第 ${turn.turn} 轮`
    lines.push(`<a id="turn-${turn.turn}"></a>`)
    lines.push('')
    lines.push(`## ${title}`)
    lines.push('')
    const parts = []
    parts.push(`开始 ${clock(turn.time0)}`)
    if (turn.time1 !== null) parts.push(`结束 ${clock(turn.time1)}`)
    parts.push(`耗时 ${humanMs((turn.time1 ?? Date.now()) - turn.time0)}`)
    parts.push(`步骤 ${turn.steps.length}`)
    if (turn.reason) parts.push(`结束原因 \`${reasonText(turn.reason)}\``)
    lines.push(`_${parts.join(' · ')}_`)
    lines.push('')
    const overview = renderTurnOverview(turn)
    if (overview.length > 0) {
      lines.push(...overview)
      lines.push('')
    }
    if (turn.preamble.length > 0) {
      lines.push('### 轮次开始处')
      lines.push('')
      lines.push(...renderItems(turn.preamble, state, level, `t${turn.turn}`))
      lines.push('')
    }
    for (const step of turn.steps) {
      lines.push(`<a id="step-${turn.turn}-${step.step}"></a>`)
      lines.push('')
      lines.push(`### 步骤 ${turn.turn}.${step.step}`)
      lines.push('')
      const stepParts = [`开始 ${clock(step.time0)}`]
      if (step.time1 !== null) stepParts.push(`结束 ${clock(step.time1)}`)
      stepParts.push(`耗时 ${humanMs((step.time1 ?? Date.now()) - step.time0)}`)
      if (step.usage) stepParts.push(`tokens ${num(step.usage.inputTokens)}↑ ${num(step.usage.outputTokens)}↓`)
      lines.push(`_${stepParts.join(' · ')}_`)
      lines.push('')
      lines.push(...renderItems(step.items, state, level, `t${turn.turn}s${step.step}`))
      lines.push('')
    }
    return lines
  }

  /** 结束原因的可读文本。 */
  function reasonText(reason) {
    if (!reason) return '未知'
    if (typeof reason === 'string') return reason
    if (reason.kind === 'completed') return '正常完成'
    if (reason.kind === 'aborted') return '被中断'
    if (reason.kind === 'blocked') return '被阻止'
    if (reason.kind === 'max-tokens') return '达到 token 上限'
    if (reason.kind === 'interrupted') return '被打断'
    if (reason.kind === 'forked') return '被分叉'
    if (reason.kind === 'error') return `错误：${reason.error?.message ?? ''}`
    return reason.kind ?? '未知'
  }

  /** 单轮小结：这一轮用了哪些工具、读了哪些文件、发了哪些查询。 */
  function renderTurnOverview(turn) {
    const items = [...turn.preamble]
    for (const step of turn.steps) items.push(...step.items)
    const tools = new Map()
    const files = { read: [], write: [] }
    const web = []
    const skills = []
    for (const item of items) {
      if (item.k !== 'tool') continue
      tools.set(item.name, (tools.get(item.name) || 0) + 1)
      const subject = item.subject || ''
      if (item.category === 'file-read' && subject) files.read.push(subject)
      if (item.category === 'file-write' && subject) files.write.push(subject)
      if (item.category === 'web' && subject) web.push(subject)
      if (item.category === 'skill' && (item.skill || subject)) skills.push(item.skill || subject)
    }
    const lines = []
    if (tools.size > 0) {
      lines.push(`- **工具**：${[...tools.entries()].map(([n, c]) => `\`${n}\`×${c}`).join('、')}`)
    }
    if (files.read.length > 0) lines.push(`- **读取**：${[...new Set(files.read)].map((p) => `\`${p}\``).join('、')}`)
    if (files.write.length > 0) lines.push(`- **写入**：${[...new Set(files.write)].map((p) => `\`${p}\``).join('、')}`)
    if (web.length > 0) lines.push(`- **联网**：${[...new Set(web)].map((q) => `\`${q}\``).join('、')}`)
    if (skills.length > 0) lines.push(`- **技能**：${[...new Set(skills)].join('、')}`)
    return lines
  }

  /** 渲染一组时间线条目。 */
  function renderItems(items, state, level, anchor) {
    const lines = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = `${anchor}-${i}`
      switch (item.k) {
        case 'user': {
          lines.push(`#### 用户输入 · ${clock(item.time)}`)
          lines.push('')
          lines.push(body(item.text, level === 'summary' ? 'summary' : level, { lang: 'text' }))
          break
        }
        case 'system': {
          lines.push(`#### 系统提示词 · ${clock(item.time)}`)
          lines.push('')
          if (item.unchanged) {
            lines.push(`_（与上一条系统提示词完全相同，此处省略；如需每次都写完整内容，请在设置里关闭「系统提示词去重」。）_`)
            lines.push('')
            break
          }
          lines.push(`_这是本步真正进入请求的系统提示词（含 Harness 与各插件注入的内容）。_`)
          lines.push('')
          lines.push(body(item.text, level, { lang: 'markdown' }))
          break
        }
        case 'inject': {
          lines.push(`#### 注入内容 · ${clock(item.time)}`)
          lines.push('')
          lines.push(body(item.text, level, { lang: 'markdown' }))
          break
        }
        case 'context': {
          lines.push(`#### 请求上下文 · ${clock(item.time)}`)
          lines.push('')
          lines.push(kvTable(item.context))
          break
        }
        case 'request': {
          lines.push(`#### 模型请求配置 · ${clock(item.time)}`)
          lines.push('')
          const head = []
          if (item.config) head.push(`- 提供商/模型：\`${item.config.provider ?? '?'} / ${item.config.model ?? '?'}\``)
          if (item.config && item.config.reasoningEffort) head.push(`- 推理强度：\`${item.config.reasoningEffort}\``)
          if (typeof item.config?.maxTokens === 'number') head.push(`- 最大输出：${num(item.config.maxTokens)}`)
          if (typeof item.config?.temperature === 'number') head.push(`- 温度：${item.config.temperature}`)
          head.push(`- 请求原因：\`${item.reason ?? 'initial'}\`${item.startsSeries ? '（新一轮请求序列的开始）' : ''}`)
          head.push(`- 可用工具：${item.toolCount} 个`)
          lines.push(head.join('\n'))
          lines.push('')
          if (Array.isArray(item.tools) && item.tools.length > 0 && level !== 'summary') {
            const names = item.tools.map((t) => t.name).filter(Boolean)
            if (level === 'full') {
              lines.push('<details><summary>工具清单</summary>')
              lines.push('')
              for (const t of item.tools) lines.push(`- \`${t.name}\`：${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
              lines.push('')
              lines.push('</details>')
            } else {
              lines.push(`- 工具清单：${names.map((n) => `\`${n}\``).join('、')}`)
            }
            lines.push('')
          }
          break
        }
        case 'raw': {
          lines.push(`#### 原始请求（发往模型） · ${clock(item.time)}`)
          lines.push('')
          lines.push(
            `_提供商 \`${item.provider ?? '?'}\` · 模型 \`${item.model ?? '?'}\` · 消息 ${item.messageCount} 条` +
              `${item.purpose ? ` · 用途 \`${item.purpose}\`` : ''}${item.reasoningEffort ? ` · 推理强度 \`${item.reasoningEffort}\`` : ''}_`,
          )
          lines.push('')
          if (!item.changed && config.rawRequestMode === 'changed') {
            lines.push('_（与上一步发送的消息完全相同，此处省略；如需逐步完整保留，请把「原始请求」模式改为「每次都写」。）_')
            lines.push('')
          } else if (level === 'summary') {
            lines.push(`- 消息角色序列：${item.messages.map((m) => m.role).join(' → ')}`)
            lines.push('')
          } else {
            const cap = Math.max(10, Number(config.maxRawMessages) || 300)
            const total = Math.min(item.messages.length, cap)
            const budget = Math.max(2000, Number(config.rawRequestBudget) || 24000)
            const perMessage = Math.max(200, Number(config.maxInlineChars) || 4000)
            // 预算从最新一条往前分配：最近的消息最贴近当前决策，历史前缀只留一行摘要。
            // 否则「完整历史 × 每一步都写」会让单次会话的文件膨胀到几十兆，失去可读性。
            const full = new Set()
            let used = 0
            for (let i = total - 1; i >= 0; i--) {
              const cost = Math.min(item.messages[i].text.length, perMessage)
              if (full.size > 0 && used + cost > budget) break
              full.add(i)
              used += cost
            }
            let foldedStarted = false
            for (let i = 0; i < total; i++) {
              const message = item.messages[i]
              if (full.has(i)) {
                lines.push(`**\`${message.role}\`**${message.model ? ` · \`${message.provider}/${message.model}\`` : ''}`)
                lines.push('')
                lines.push(
                  body(message.text === '' ? '_（无文本内容）_' : message.text, level === 'full' ? 'full' : 'standard', {
                    lang: 'text',
                  }),
                )
              } else {
                if (!foldedStarted) {
                  lines.push('')
                  foldedStarted = true
                }
                const oneLine = message.text.replace(/\s+/g, ' ').trim()
                lines.push(
                  `- \`${message.role}\`（${num(message.text.length)} 字，已折叠）：${oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine}`,
                )
              }
            }
            const folded = total - full.size
            if (folded > 0 || item.messages.length > total) {
              lines.push('')
              lines.push(
                `_（共 ${item.messages.length} 条消息：完整展示 ${full.size} 条，折叠 ${folded} 条` +
                  `${item.messages.length > total ? `，超出条数上限省略 ${item.messages.length - total} 条` : ''}。` +
                  `调高「原始请求总预算」或「最多消息数」可看更多。）_`,
              )
            }
            if (Array.isArray(item.tools) && item.tools.length > 0) {
              lines.push('')
              lines.push(`**本次声明的工具（${item.tools.length}）**：${item.tools.map((t) => `\`${t.name}\``).join('、')}`)
            }
          }
          if (item.outcome) {
            const usage = item.outcome.usage
            const finish = item.outcome.finish
            const bits = []
            if (usage) {
              bits.push(`输入 ${num(usage.inputTokens)}`)
              bits.push(`输出 ${num(usage.outputTokens)}`)
              if (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) bits.push(`缓存读 ${num(usage.cacheReadTokens)}`)
              if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) bits.push(`推理 ${num(usage.reasoningTokens)}`)
            }
            if (finish) bits.push(`结束 \`${typeof finish === 'string' ? finish : reasonText(finish)}\``)
            if (bits.length > 0) {
              lines.push(`_结果：${bits.join(' · ')}_`)
              lines.push('')
            }
          }
          break
        }
        case 'assembly': {
          lines.push(`#### 提示词装配 · ${clock(item.time)}`)
          lines.push('')
          lines.push(`_由 Harness 的提示词装配过程记录，显示每段内容由谁贡献。_`)
          lines.push('')
          lines.push(`**提示词段落（${item.sections.length}）**`)
          lines.push('')
          if (item.sections.length === 0) lines.push('_（无）_')
          for (const section of item.sections) {
            lines.push(`- \`${section.name ?? '(匿名)'}\`${typeof section.order === 'number' ? `（顺序 ${section.order}）` : ''}`)
            if (level !== 'summary' && section.text) {
              lines.push('')
              lines.push(body(section.text, level === 'full' ? 'full' : 'standard', { lang: 'markdown' }))
            }
          }
          lines.push('')
          if (item.contexts.length > 0) {
            lines.push(`**上下文条目（${item.contexts.length}）**`)
            lines.push('')
            for (const context of item.contexts) {
              lines.push(`- \`${context.name ?? '(匿名)'}\``)
              if (level !== 'summary' && context.text) {
                lines.push('')
                lines.push(body(context.text, level === 'full' ? 'full' : 'standard', { lang: 'markdown' }))
              }
            }
            lines.push('')
          }
          if (item.variables && level === 'full') {
            lines.push('<details><summary>装配变量</summary>')
            lines.push('')
            lines.push('```json')
            lines.push(fenceSafe(JSON.stringify(item.variables, null, 2)))
            lines.push('```')
            lines.push('')
            lines.push('</details>')
            lines.push('')
          }
          break
        }
        case 'assistant': {
          const label = item.model ? ` · \`${item.model.provider}/${item.model.model}\`` : ''
          lines.push(`#### 模型回复 · ${clock(item.time)}${item.interrupted ? ' · 被打断' : ''}`)
          lines.push('')
          if (item.reasoning) {
            lines.push('**推理过程**')
            lines.push('')
            lines.push(body(item.reasoning, level, { lang: 'text' }))
          }
          lines.push(body(item.text, level, { lang: 'markdown' }))
          if (item.usage && config.capture.usage) {
            lines.push(
              `_用量：输入 ${num(item.usage.inputTokens)} · 输出 ${num(item.usage.outputTokens)}` +
                `${typeof item.usage.cacheReadTokens === 'number' && item.usage.cacheReadTokens > 0 ? ` · 缓存读 ${num(item.usage.cacheReadTokens)}` : ''}` +
                `${typeof item.usage.reasoningTokens === 'number' && item.usage.reasoningTokens > 0 ? ` · 推理 ${num(item.usage.reasoningTokens)}` : ''}_${label}`,
            )
            lines.push('')
          } else if (label) {
            lines.push(`_${label.trim()}_`)
            lines.push('')
          }
          break
        }
        case 'tool': {
          const label = CATEGORY_LABEL[item.category] || '工具调用'
          lines.push(`#### ${label} · \`${item.name}\` · ${clock(item.time)}`)
          lines.push('')
          if (item.subject) lines.push(`**对象**：\`${item.subject}\``)
          lines.push('')
          if (config.capture.toolCalls) {
            lines.push('**参数**')
            lines.push('')
            lines.push(body(item.args, level === 'full' ? 'full' : level === 'summary' ? 'summary' : 'standard', { lang: 'json' }))
          }
          if (config.capture.toolResults && item.result) {
            const stateText = item.resultState === 'error' ? '**结果（失败）**' : '**结果**'
            lines.push(stateText)
            lines.push('')
            if (item.result.error) {
              lines.push(`\`\`\`json\n${fenceSafe(JSON.stringify(item.result.error, null, 2))}\n\`\`\`\n`)
            }
            lines.push(body(item.result.text, level, { lang: 'text' }))
            if (item.result.meta) {
              lines.push(`_结果元数据：\`${fenceSafe(JSON.stringify(item.result.meta)).slice(0, 400)}\`_`)
              lines.push('')
            }
          } else if (item.resultState === 'pending') {
            lines.push('_（调用已发出，结果尚未记录）_')
            lines.push('')
          }
          break
        }
        case 'result': {
          lines.push(`#### 工具结果 · ${clock(item.time)}${item.isError ? ' · 失败' : ''}`)
          lines.push('')
          lines.push(body(item.text, level, { lang: 'text' }))
          break
        }
        default: {
          lines.push(`#### ${String(item.k)} · ${clock(item.time)}`)
          lines.push('')
          lines.push('```json')
          lines.push(fenceSafe(JSON.stringify(plain(item, 0, new WeakSet()), null, 2)))
          lines.push('```')
          lines.push('')
        }
      }
    }
    return lines
  }

  /** 简单 key/value 表格。 */
  function kvTable(record) {
    if (!record || typeof record !== 'object') return '_(空)_\n'
    const lines = ['| 字段 | 值 |', '| --- | --- |']
    for (const [key, value] of Object.entries(record)) {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
      lines.push(`| ${key} | \`${text.replace(/\|/g, '\\|')}\` |`)
    }
    lines.push('')
    return lines.join('\n')
  }

  // ── UI 用的结构化数据 ─────────────────────────────────────────────────────

  /** 供浏览器半审阅的一份会话摘要列表。 */
  function listSessions() {
    const rows = []
    const seen = new Set()
    for (const state of sessions.values()) {
      seen.add(state.id)
      rows.push(summaryOf(state))
    }
    const store = ctx.get && ctx.get('sessions')
    if (store && typeof store.list === 'function') {
      for (const session of store.list()) {
        const id = String(session?.id ?? '')
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        rows.push({
          id,
          cwd: session?.header?.cwd,
          turns: 0,
          steps: 0,
          tools: 0,
          updatedAt: session?.header?.createdAt ?? Date.now(),
          tracked: false,
          file: null,
        })
      }
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return rows
  }

  /** 单会话摘要。 */
  function summaryOf(state) {
    const usage = aggregateUsage(state)
    return {
      id: state.id,
      cwd: state.cwd,
      title: state.cwd ? basename(state.cwd) : state.id.slice(0, 12),
      turns: state.turns.length,
      steps: state.stats.steps,
      tools: state.stats.tools,
      files: state.fileReads.size + state.fileWrites.size,
      web: state.stats.web.length,
      skills: state.stats.skills.length,
      tokens: usage.inputTokens + usage.outputTokens,
      updatedAt: state.updatedAt,
      tracked: true,
      file: state.filePath,
      fileName: state.fileName,
      order: state.order,
      writeError: state.writeError,
      parentSession: state.parentSession ?? null,
    }
  }

  /** 单会话的完整（可截断）时间线，供审阅页渲染。 */
  function detailOf(id, options = {}) {
    const state = sessions.get(String(id ?? ''))
    if (!state) return null
    const cap = Math.max(500, Number(options.maxChars) || 8000)
    const clamp = (text) => {
      if (typeof text !== 'string') return { text: undefined, truncated: false }
      if (text.length <= cap) return { text, truncated: false }
      return { text: text.slice(0, cap), truncated: true, fullLength: text.length }
    }
    const mapItem = (item) => {
      const out = { k: item.k, time: item.time }
      for (const key of ['name', 'category', 'subject', 'resultState', 'reason', 'toolCount', 'messageCount', 'provider', 'model', 'purpose', 'changed', 'isError', 'interrupted', 'callId', 'skill', 'unchanged']) {
        if (item[key] !== undefined) out[key] = item[key]
      }
      if (typeof item.text === 'string') out.text = clamp(item.text)
      if (typeof item.reasoning === 'string') out.reasoning = clamp(item.reasoning)
      if (typeof item.args === 'string') out.args = clamp(item.args)
      if (item.result && typeof item.result === 'object') {
        out.result = { ...item.result, text: clamp(item.result.text) }
      }
      if (item.usage !== undefined) out.usage = item.usage
      if (item.outcome !== undefined) out.outcome = item.outcome
      if (item.config !== undefined) out.config = item.config
      if (Array.isArray(item.tools)) out.tools = item.tools
      if (Array.isArray(item.messages)) {
        out.messages = item.messages.map((message) => ({
          role: message.role,
          model: message.model,
          provider: message.provider,
          ...clamp(message.text),
        }))
      }
      if (Array.isArray(item.sections)) {
        out.sections = item.sections.map((section) => ({ name: section.name, order: section.order, ...clamp(section.text) }))
      }
      if (Array.isArray(item.contexts)) {
        out.contexts = item.contexts.map((context) => ({ name: context.name, order: context.order, ...clamp(context.text) }))
      }
      if (item.context !== undefined) out.context = item.context
      return out
    }
    const onlyTurn = Number.isFinite(options.turn) ? Number(options.turn) : null
    const turns = []
    for (const turn of state.turns) {
      if (onlyTurn !== null && turn.turn !== onlyTurn) continue
      turns.push({
        turn: turn.turn,
        time0: turn.time0,
        time1: turn.time1,
        reason: turn.reason,
        synthetic: turn.synthetic === true,
        usage: turn.usage,
        preamble: turn.preamble.map(mapItem),
        steps: turn.steps.map((step) => ({
          step: step.step,
          time0: step.time0,
          time1: step.time1,
          usage: step.usage,
          model: step.model,
          items: step.items.map(mapItem),
        })),
      })
    }
    return {
      summary: summaryOf(state),
      turns,
      orphan: (state.orphanItems || []).map(mapItem),
      totalTurns: state.turns.length,
      maxChars: cap,
    }
  }

  // ── RPC 端点 ──────────────────────────────────────────────────────────────

  const endpoints = {
    /** 一次性状态：配置 + 会话清单 + 输出位置。 */
    status: async () => ({
      config: plain(config, 0, new WeakSet()),
      defaults: plain(DEFAULT_CONFIG, 0, new WeakSet()),
      sessions: listSessions(),
      outputDir: sessions.size > 0 ? null : undefined,
      lastError,
      writeCount,
      configPath: configPath(),
      dshHome: dshHome(),
    }),

    /** 读取配置。 */
    'config.get': async () => plain(config, 0, new WeakSet()),

    /** 合并式更新配置并持久化。 */
    'config.set': async (payload) => {
      const patch = payload && typeof payload.patch === 'object' ? payload.patch : {}
      config = mergeConfig(config, patch)
      let saved = null
      let saveError = null
      try {
        saved = await saveConfig()
      } catch (error) {
        saveError = String(error && error.message ? error.message : error)
        lastError = `配置保存失败：${saveError}`
      }
      return { config: plain(config, 0, new WeakSet()), saved, saveError }
    },

    /** 恢复默认配置。 */
    'config.reset': async () => {
      config = mergeConfig(DEFAULT_CONFIG, {})
      let saved = null
      try {
        saved = await saveConfig()
      } catch {
        /* 忽略 */
      }
      return { config: plain(config, 0, new WeakSet()), saved }
    },

    /** 会话清单。 */
    'sessions.list': async () => ({ sessions: listSessions() }),

    /** 单会话时间线。 */
    'session.get': async (payload) => {
      const id = payload && payload.id ? String(payload.id) : ''
      const detail = detailOf(id, { turn: payload && payload.turn, maxChars: payload && payload.maxChars })
      if (!detail) return { missing: true, id }
      return detail
    },

    /** 单会话 Markdown 全文（预览用）。 */
    'markdown.get': async (payload) => {
      const state = sessions.get(String((payload && payload.id) || ''))
      if (!state) return { missing: true }
      const text = renderMarkdown(state, config)
      const cap = Math.max(2000, Number((payload && payload.maxChars) || 200000) || 200000)
      return {
        text: text.length > cap ? text.slice(0, cap) : text,
        truncated: text.length > cap,
        fullLength: text.length,
        path: state.filePath,
        fileName: state.fileName,
      }
    },

    /** 立即落盘。 */
    'write.now': async (payload) => {
      const id = payload && payload.id ? String(payload.id) : ''
      if (id) {
        const state = sessions.get(id)
        if (!state) return { ok: false, error: '该会话尚未被记录' }
        const path = await writeSession(state)
        return { ok: path !== null, path, fileName: state.fileName, error: state.writeError }
      }
      const results = await writeAll()
      return { ok: true, results }
    },

    /** 清空某会话（或全部）的内存时间线。 */
    'session.reset': async (payload) => {
      const id = payload && payload.id ? String(payload.id) : ''
      if (id) {
        const state = sessions.get(id)
        if (state && state.timer) {
          clearTimeout(state.timer)
          timers.delete(state.timer)
        }
        sessions.delete(id)
        return { ok: true, cleared: 1 }
      }
      const count = sessions.size
      for (const state of sessions.values()) {
        if (state.timer) {
          clearTimeout(state.timer)
          timers.delete(state.timer)
        }
      }
      sessions.clear()
      return { ok: true, cleared: count }
    },

    /** 可用的工作区列表（供范围配置点选）。 */
    'workspaces.list': async () => {
      const out = []
      const registry = ctx.get && ctx.get('workspaceRegistry')
      if (registry && typeof registry.list === 'function') {
        for (const workspace of registry.list()) {
          out.push({ id: String(workspace.id), path: workspace.path, title: workspace.title })
        }
      }
      const seen = new Set(out.map((w) => normPath(w.path)))
      for (const state of sessions.values()) {
        if (!state.cwd) continue
        const key = normPath(state.cwd)
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        out.push({ id: `cwd:${key}`, path: state.cwd, title: basename(state.cwd) })
      }
      return { workspaces: out }
    },
  }

  /** RPC 总入口：契约与连接服务的 handler 一致。 */
  const rpcHandler = async (endpoint, payload) => {
    const fn = endpoints[endpoint]
    if (typeof fn !== 'function') {
      return { ok: false, error: { code: 'trace/unknown-endpoint', message: `未知端点：${endpoint}`, details: {} } }
    }
    try {
      const value = await fn(payload === undefined ? {} : payload)
      return { ok: true, value: plain(value, 0, new WeakSet()) }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      lastError = `端点 ${endpoint} 失败：${message}`
      return { ok: false, error: { code: 'trace/failed', message, details: {} } }
    }
  }

  return {
    get config() {
      return config
    },
    loadConfig,
    saveConfig,
    onSessionEvent,
    recordRawRequest,
    recordStreamOutcome,
    recordAssembly,
    rpcHandler,
    endpoints,
    writeSession,
    writeAll,
    listSessions,
    detailOf,
    renderMarkdownFor(state) {
      return renderMarkdown(state, config)
    },
    stateOf(id) {
      return sessions.get(String(id ?? ''))
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const state of sessions.values()) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
      }
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 插件入口
// ────────────────────────────────────────────────────────────────────────────

/**
 * 插件装配。
 * @param ctx - 插件上下文。
 * @param config - 来自 cordis.patch.yml 的初始配置（可选）。
 */
export function apply(ctx, config) {
  const recorder = createRecorder(ctx, config)
  // 读取持久化配置：不阻塞激活，读到后再生效。
  void recorder.loadConfig()

  // 启动信标：写一行到 DSH 主目录，用于确认「这一版代码确实被加载了」。
  // 排查时非常有用——模块是否真的换新，只有它自己说得清。
  void (async () => {
    try {
      const dir = join(dshHome(), 'harness-trace')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'startup.log'),
        `[${new Date().toISOString()}] loaded name=${name} entry=host.js\n`,
        { encoding: 'utf8', flag: 'a' },
      )
    } catch {
      /* 信标失败不影响插件 */
    }
  })()

  ctx.effect(() => () => recorder.dispose(), 'dsh-harness-trace: 记录器')

  // 1) 会话日志：权威时间线（用户输入、系统提示词、工具调用、结果、请求头）。
  ctx.on('session/event', (session, event) => {
    recorder.onSessionEvent(session, event)
  })

  // 2) 冻结的模型请求：真正发出去的完整提示词。
  ctx.on('llm/stream', (options, next) => {
    let stream
    try {
      stream = next()
    } catch (error) {
      throw error
    }
    if (!recorder.config.enabled || !recorder.config.capture.rawRequest) return stream
    try {
      recorder.recordRawRequest(options)
    } catch {
      /* 记录失败不影响请求 */
    }
    return (async function* captured() {
      const inner = await stream
      let usage = null
      let finish = null
      for await (const chunk of inner) {
        try {
          if (chunk && chunk.type === 'usage') usage = chunk.usage
          else if (chunk && chunk.type === 'finish') finish = chunk.reason
        } catch {
          /* 忽略 */
        }
        yield chunk
      }
      try {
        recorder.recordStreamOutcome(options, usage, finish)
      } catch {
        /* 忽略 */
      }
    })()
  })

  // 3) 提示词装配：分辨每一段由谁注入。
  ctx.on('system-prompt/assemble', async (assembly, maybeContext, maybeNext) => {
    const context = typeof maybeContext === 'function' ? undefined : maybeContext
    const next = typeof maybeContext === 'function' ? maybeContext : maybeNext
    const result = typeof next === 'function' ? await next() : assembly
    try {
      if (recorder.config.enabled && recorder.config.capture.promptAssembly) {
        recorder.recordAssembly(result, bindingOf(ctx, assembly, context))
      }
    } catch {
      /* 忽略 */
    }
    return result
  })

  // 4) 与浏览器半的通信：`/api` 通道上的精确 Fetch 路由。
  //    浏览器用 connection.rpc.call('/api','harness-trace',…) 调它，拼出的路径同为 API_PATH。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (injected) => {
      const connection =
        (injected && injected.connection) || (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
      if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return () => {}
      const route = {
        path: API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleApiRequest(request, recorder),
      }
      const dispose = connection.fetch.register(route)
      return () => {
        try {
          if (typeof dispose === 'function') void dispose()
        } catch {
          /* 忽略 */
        }
      }
    })
  }
}

/** RPC 编号的允许形状（与连接服务一致）。 */
const RPC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 处理一次来自浏览器半的调用，并回成连接服务认得的信封。
 *
 * 浏览器半用 `rpc.call('/api', 'harness-trace', { method, payload })` 调用：
 * 外层 `method` 就是本插件的端点名（`harness-trace`），真正的操作名在内层
 * `payload.method` 里——与共享通道上其它精确路由的既有约定一致。
 *
 * @param request - Fetch 请求，body 为 `{type:'client-request',rpcId,method,payload}`。
 * @param recorder - 记录器，提供 rpcHandler。
 */
async function handleApiRequest(request, recorder) {
  const reply = (rpcId, result) => Response.json({ type: 'server-response', rpcId, result })
  const reject = (rpcId, message) =>
    reply(rpcId, { ok: false, error: { code: 'trace/bad-request', message, details: {} } })
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  let body = null
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const rpcId =
    body && typeof body.rpcId === 'string' && RPC_ID_PATTERN.test(body.rpcId) ? body.rpcId : 'invalid-request'
  if (!body || body.type !== 'client-request') return reject(rpcId, 'invalid client-request message')
  const inner = body.payload && typeof body.payload === 'object' ? body.payload : {}
  const endpoint = typeof inner.method === 'string' ? inner.method : String(body.method ?? '')
  const result = await recorder.rpcHandler(endpoint, inner.payload === undefined ? null : inner.payload)
  return reply(rpcId, result)
}

/**
 * 尽力推断一次装配属于哪个会话：装配上下文里可能带会话或 Agent 身份，
 * 否则取当前正在驱动的 Agent（装配总是发生在某个 Agent 的调用链里）。
 * @param ctx - 插件上下文，用于兜底查询。
 * @param assembly - 装配结果。
 * @param context - 装配上下文。
 */
function bindingOf(ctx, assembly, context) {
  const direct = context || assembly
  if (direct && typeof direct === 'object') {
    if (direct.sessionId) return { sessionId: String(direct.sessionId) }
    if (direct.session && direct.session.id) return { sessionId: String(direct.session.id) }
    if (direct.agent && direct.agent.id) return { sessionId: String(direct.agent.id) }
    if (direct.scope && typeof direct.scope === 'string' && direct.scope.startsWith('session-')) {
      return { sessionId: direct.scope }
    }
  }
  try {
    const agents = ctx.get && ctx.get('agents')
    if (agents && typeof agents.currentInitiator === 'function') {
      const initiator = agents.currentInitiator()
      if (initiator && initiator.id) return { sessionId: String(initiator.id) }
    }
  } catch {
    /* 忽略 */
  }
  // 兜底：当前只有一个活跃会话时，把装配归给它。
  try {
    const store = ctx.get && ctx.get('sessions')
    if (store && typeof store.list === 'function') {
      const live = store.list()
      if (live.length === 1) return { sessionId: String(live[0].id) }
    }
  } catch {
    /* 忽略 */
  }
  return {}
}
