/**
 * dsh-notify — desktop notifications when a DeepSeek Harness session stops.
 *
 * Host-side cordis plugin. It observes the session event firehose and the
 * user-questions waterfall, then renders a topmost notification card (and/or
 * a Windows toast) through `lib/notify.ps1`.
 *
 * Supported stop reasons:
 *   - turn completed                -> "会话完成"
 *   - turn failed                   -> "会话异常结束" (error text included)
 *   - turn aborted / blocked /
 *     output-token ceiling          -> "会话已中止" / "会话被阻断" / "输出达到上限"
 *   - approval requested            -> "需要你的批准"
 *   - ask_user_question / plan review -> "需要你的选择"
 *
 * The plugin is fail-open: every listener contains its own errors, nothing it
 * does can veto an agent turn, and a missing PowerShell only logs a warning.
 *
 * @module dsh-notify
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'notify.ps1')

/** Resolve the default Windows PowerShell to an absolute path; custom values pass through. */
function resolvePowershell(command) {
  if (command !== 'powershell.exe' && command !== 'powershell') return command
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : command
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether an HTTP request came from this machine. */
function isLoopbackRequest(req) {
  const address = typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : ''
  return LOOPBACK_ADDRESSES.has(address)
}

/** Write one small JSON response, owning the response lifecycle. */
function writeJson(res, status, value) {
  try {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      // response already gone
    }
  }
}

/** Stable loader identity. */
export const name = 'dsh-notify'

/** Default configuration; every field can be overridden from the profile patch. */
const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Notify when a turn ends normally. */
  notifyCompleted: true,
  /** Notify when the agent waits for an answer or a plan review. */
  notifyNeedsInput: true,
  /** Notify when a turn fails with an error. */
  notifyError: true,
  /** Notify when the user (or a policy) cancels the turn. */
  notifyAborted: true,
  /** Notify when a turn is blocked by policy. */
  notifyBlocked: true,
  /** Notify when a turn ends at the output-token ceiling. */
  notifyMaxTokens: true,
  /** Also notify for subagent sessions (default: root sessions only). */
  subagents: false,
  /** `popup` (topmost card), `toast` (Windows notification) or `both`. */
  style: 'popup',
  /** Popup anchor on the screen. */
  position: 'bottom-right',
  /** Play a notification sound. */
  sound: true,
  /** Skip the popup while the DSH window is in the foreground. */
  suppressWhenFocused: false,
  /** Popup lifetime in milliseconds. */
  durationMs: 7000,
  /** Hard timeout for one renderer process. */
  timeoutMs: 20000,
  /** Simultaneous popups (stacked slots). */
  maxConcurrent: 3,
  /** Show a preview of the final assistant message on completion. */
  showPreview: true,
  /** Clicking a notification focuses DSH and opens that session. */
  openOnClick: true,
  /** Character budgets for the rendered text. */
  maxBodyChars: 220,
  maxTitleChars: 96,
  /** PowerShell executable (set `pwsh` if Windows PowerShell is unavailable). */
  powershell: 'powershell.exe',
  /** Optional AUMID override for toast style. */
  toastAppId: '',
  /** Log every decision to the host log. */
  debug: false,
  /** Render nothing; record payloads in `notifier.sent` (tests only). */
  dryRun: false,
}

const KIND_FLAGS = {
  completed: 'notifyCompleted',
  error: 'notifyError',
  aborted: 'notifyAborted',
  blocked: 'notifyBlocked',
  'max-tokens': 'notifyMaxTokens',
}

const TITLES = {
  completed: '会话完成',
  error: '会话异常结束',
  aborted: '会话已中止',
  blocked: '会话被阻断',
  'max-tokens': '输出达到上限',
}

const ACCENTS = {
  completed: '#3FB950',
  error: '#F85149',
  aborted: '#8B949E',
  blocked: '#D29922',
  'max-tokens': '#D29922',
  input: '#D29922',
}

const STYLES = new Set(['popup', 'toast', 'both'])
const POSITIONS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])

/** Coerce raw profile config into a complete, bounded configuration object. */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const number = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(value, min), max)
  }
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  const config = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = source[key]
    if (typeof fallback === 'boolean') config[key] = bool(value, fallback)
    else if (typeof fallback === 'number') config[key] = number(value, fallback, 0, 600000)
    else config[key] = text(value, fallback)
  }
  config.durationMs = Math.min(Math.max(config.durationMs, 1500), 600000)
  config.timeoutMs = Math.min(Math.max(config.timeoutMs, 3000), 120000)
  config.maxConcurrent = Math.min(Math.max(Math.trunc(config.maxConcurrent) || 1, 1), 5)
  config.maxBodyChars = Math.min(Math.max(Math.trunc(config.maxBodyChars) || 40, 40), 2000)
  config.maxTitleChars = Math.min(Math.max(Math.trunc(config.maxTitleChars) || 8, 8), 300)
  if (!STYLES.has(config.style)) config.style = DEFAULTS.style
  if (!POSITIONS.has(config.position)) config.position = DEFAULTS.position
  return config
}

/** Collapse whitespace and clip one line of text. */
export function clipText(value, maxChars) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text === '') return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/** `45 秒` / `2 分 31 秒` / `1 分`. */
export function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return ''
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/** Local wall-clock `HH:mm`, independent of locale data. */
function clockTime(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** Extract the model failure message from a `turn/end` reason. */
function errorText(reason) {
  const failure = reason?.error
  if (typeof failure === 'string' && failure.trim() !== '') return failure.trim()
  if (failure !== null && typeof failure === 'object') {
    const message = typeof failure.message === 'string' ? failure.message.trim() : ''
    const code = typeof failure.code === 'string' ? failure.code.trim() : ''
    if (message !== '' && code !== '') return `${message} (${code})`
    if (message !== '') return message
    if (code !== '') return code
  }
  return '模型调用失败，请查看会话以了解详情'
}

/** Build the notification payload for one finished turn, or null when ignored. */
export function buildTurnNotification({ kind, reason, label, durationMs, steps, preview, config }) {
  const title = TITLES[kind]
  if (title === undefined) return null
  let body
  switch (kind) {
    case 'completed':
      body = preview || '本轮已结束'
      break
    case 'error':
      body = errorText(reason)
      break
    case 'aborted':
      body = '已取消本轮运行'
      break
    case 'blocked':
      body = '策略或权限阻止了继续执行'
      break
    case 'max-tokens':
      body = '本轮达到模型的输出 token 上限'
      break
    default:
      body = ''
  }
  const footer = [
    label,
    formatDuration(durationMs),
    steps > 0 ? `${steps} 步` : '',
    clockTime(),
  ].filter((part) => part !== '').join(' · ')
  return {
    kind: kind === 'error' ? 'error' : kind === 'completed' ? 'completed' : 'input',
    title: clipText(title, config.maxTitleChars),
    body: clipText(body, config.maxBodyChars),
    footer: clipText(footer, config.maxBodyChars),
    accent: ACCENTS[kind] ?? ACCENTS.completed,
    style: config.style,
    position: config.position,
    sound: config.sound,
    suppressWhenFocused: config.suppressWhenFocused,
    durationMs: config.durationMs,
    toastAppId: config.toastAppId,
  }
}

/** Build the notification payload for an approval request. */
export function buildApprovalNotification({ toolName, reason, label, config }) {
  const tool = typeof toolName === 'string' && toolName.trim() !== '' ? toolName.trim() : '工具'
  const detail = clipText(reason, 120)
  return {
    kind: 'input',
    title: '需要你的批准',
    body: `${tool} 请求你的批准${detail === '' ? '' : `：${detail}`}`,
    footer: clipText(`${label} · 等待你的操作`, config.maxBodyChars),
    accent: ACCENTS.input,
    style: config.style,
    position: config.position,
    sound: config.sound,
    suppressWhenFocused: config.suppressWhenFocused,
    durationMs: config.durationMs,
    toastAppId: config.toastAppId,
  }
}

/** Build the notification payload for a user-questions (or plan-review) request. */
export function buildQuestionNotification({ questions, label, config }) {
  const list = Array.isArray(questions) ? questions : []
  const first = list[0] ?? {}
  const intent = first?.intent
  let title = '需要你的选择'
  let body
  if (intent?.kind === 'plan-review') {
    title = '计划待审阅'
    body = typeof first?.question === 'string' && first.question.trim() !== ''
      ? first.question
      : '审阅计划并选择「批准」或「继续规划」'
  } else {
    const question = typeof first?.question === 'string' ? first.question.trim() : ''
    const more = list.length > 1 ? `（共 ${list.length} 个问题）` : ''
    body = question === '' ? `有 ${Math.max(1, list.length)} 个问题等待你回答` : `${question}${more}`
  }
  return {
    kind: 'input',
    title,
    body: clipText(body, config.maxBodyChars),
    footer: clipText(`${label} · 等待你的操作`, config.maxBodyChars),
    accent: ACCENTS.input,
    style: config.style,
    position: config.position,
    sound: config.sound,
    suppressWhenFocused: config.suppressWhenFocused,
    durationMs: config.durationMs,
    toastAppId: config.toastAppId,
  }
}

/**
 * Create the notification engine. Exposed for tests and for reuse; `apply`
 * wires it to a cordis context.
 *
 * @param rawConfig - plugin row config.
 * @param options - `logger` (info/warn/debug) and `spawn` override.
 */
export function createNotifier(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = options.logger ?? null
  const spawnProcess = options.spawn ?? defaultSpawn
  const powershellPath = resolvePowershell(config.powershell)
  const sent = []
  const titles = new Map()
  const turns = new Map()
  const seen = new Map()
  const timers = new Set()
  const children = new Set()
  const queue = []
  const freeSlots = Array.from({ length: config.maxConcurrent }, (_, index) => index)
  let active = 0
  let disposed = false

  const warn = (message, error) => {
    try {
      logger?.warn?.(message, error)
    } catch {
      // logging must never break the notifier
    }
  }
  const debug = (message) => {
    if (!config.debug) return
    try {
      logger?.info?.(message)
    } catch {
      // ignore
    }
  }

  function defer(callback) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try {
        callback()
      } catch (error) {
        warn('notification callback failed', error)
      }
    }, 0)
    timers.add(timer)
  }

  function once(key, ttl = 4000) {
    const now = Date.now()
    const previous = seen.get(key)
    if (previous !== undefined && now - previous < ttl) return false
    seen.set(key, now)
    if (seen.size > 256) {
      for (const [entry, at] of seen) {
        if (now - at > ttl) seen.delete(entry)
      }
    }
    return true
  }

  function rememberTitle(sessionId, title) {
    if (sessionId === undefined || typeof title !== 'string' || title.trim() === '') return
    titles.set(sessionId, clipText(title, 80))
    if (titles.size > 300) titles.delete(titles.keys().next().value)
  }

  function labelFor(session, sessionId) {
    const id = sessionId ?? session?.id
    if (id !== undefined) {
      const title = titles.get(id)
      if (title) return title
    }
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') {
      try {
        const folder = basename(cwd)
        if (folder !== '') return folder
      } catch {
        // fall through to the id label
      }
    }
    if (typeof id === 'string' && id.length > 0) return `会话 ${id.slice(0, 8)}`
    return 'DSH 会话'
  }

  function assistantPreview(session) {
    try {
      const messages = session?.deriveMessages?.()
      if (!Array.isArray(messages)) return ''
      for (let index = messages.length - 1; index >= 0 && index >= messages.length - 40; index -= 1) {
        const message = messages[index]
        if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue
        const blocks = Array.isArray(message.content) ? message.content : []
        const text = blocks
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim()
        if (text !== '') return text
      }
    } catch {
      // preview is best-effort only
    }
    return ''
  }

  function enqueue(payload) {
    if (disposed || payload === null || typeof payload !== 'object') return
    if (config.dryRun) {
      sent.push(payload)
      return
    }
    if (queue.length >= 8) queue.shift()
    queue.push(payload)
    pump()
  }

  /**
   * Attach the click-to-open URL when a web server is available and the
   * feature is enabled. The URL points at this plugin's own loopback route;
   * the renderer process performs the focus + request on click.
   */
  function withClick(payload, sessionId) {
    if (!config.openOnClick) return payload
    let base = ''
    try {
      base = typeof options.clickBase === 'function' ? options.clickBase() : ''
    } catch {
      base = ''
    }
    if (typeof base !== 'string' || base === '') return payload
    if (typeof sessionId !== 'string' || sessionId === '') return payload
    return {
      ...payload,
      clickUrl: `${base.replace(/\/+$/u, '')}/dsh-notify/click?session=${encodeURIComponent(sessionId)}`,
      footer: clipText(`${payload.footer} · 点击打开会话`, config.maxBodyChars),
    }
  }

  function pump() {
    while (!disposed && active < config.maxConcurrent && freeSlots.length > 0 && queue.length > 0) {
      const slot = freeSlots.shift()
      const payload = queue.shift()
      active += 1
      launch(payload, slot)
    }
  }

  function release(slot) {
    active = Math.max(0, active - 1)
    if (!freeSlots.includes(slot)) freeSlots.push(slot)
    freeSlots.sort((left, right) => left - right)
    pump()
  }

  function launch(payload, slot) {
    const message = { ...payload, slot }
    let child
    try {
      child = spawnProcess(
        message,
        {
          powershell: powershellPath,
          scriptPath: SCRIPT_PATH,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
          timeoutMs: config.timeoutMs,
        },
      )
    } catch (error) {
      warn('failed to launch the notification renderer', error)
      release(slot)
      return
    }
    if (child === null || child === undefined || typeof child !== 'object') {
      release(slot)
      return
    }
    let settled = false
    let timer = null
    const settle = () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      children.delete(child)
      release(slot)
    }
    children.add(child)
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      settle()
    }, config.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    let stderr = ''
    if (child.stderr !== null && child.stderr !== undefined && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4000) stderr += String(chunk)
      })
    }
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        warn('notification renderer failed', error)
        settle()
      })
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) warn(`notification renderer exited with code ${code}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(-500)}`}`)
        else debug('notification rendered')
        settle()
      })
    }
    try {
      child.stdin.end(JSON.stringify(message), 'utf8')
    } catch (error) {
      warn('failed to write the notification payload', error)
      settle()
    }
  }

  function handleTurnEnd(session, event) {
    const reason = event?.data?.reason
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    if (kind === 'interrupted' || kind === 'forked') return
    const flag = KIND_FLAGS[kind]
    if (flag === undefined || config[flag] !== true) return
    if (!once(`turn:${String(session?.id)}:${String(event?.seq)}`)) return
    const turn = turns.get(session?.id)
    turns.delete(session?.id)
    const startedAt = typeof turn?.startedAt === 'number' ? turn.startedAt : 0
    const durationMs = startedAt > 0 && typeof event?.time === 'number' ? Math.max(0, event.time - startedAt) : 0
    const steps = typeof turn?.steps === 'number' ? turn.steps : 0
    const label = labelFor(session)
    defer(() => {
      const preview = config.showPreview ? assistantPreview(session) : ''
      const payload = buildTurnNotification({ kind, reason, label, durationMs, steps, preview, config })
      if (payload !== null) enqueue(withClick(payload, session?.id))
    })
  }

  function handleApprovalAsked(session, event) {
    if (!config.notifyNeedsInput) return
    const data = event?.data ?? {}
    const key = `approval:${String(data.id ?? event?.seq)}`
    if (!once(key)) return
    enqueue(withClick(buildApprovalNotification({ toolName: data.toolName, reason: data.reason, label: labelFor(session), config }), session?.id))
  }

  function handleSessionEvent(session, event) {
    if (disposed || !config.enabled || session === null || typeof session !== 'object' || event === null || typeof event !== 'object') return
    try {
      if (!config.subagents && (session.header?.origin === 'subagent' || (typeof session.header?.delegationDepth === 'number' && session.header.delegationDepth > 0))) return
      switch (event.type) {
        case 'session/title':
          rememberTitle(session.id, event.data?.title)
          return
        case 'turn/start':
          turns.set(session.id, { startedAt: typeof event.time === 'number' ? event.time : 0, steps: 0 })
          return
        case 'step/end': {
          const turn = turns.get(session.id)
          if (turn !== undefined) turn.steps += 1
          return
        }
        case 'turn/end':
          handleTurnEnd(session, event)
          return
        case 'approval/asked':
          handleApprovalAsked(session, event)
          return
        default:
          return
      }
    } catch (error) {
      warn('session event handling failed', error)
    }
  }

  function handleQuestionRequest(request) {
    if (disposed || !config.enabled || !config.notifyNeedsInput) return
    try {
      const questions = Array.isArray(request?.questions) ? request.questions : []
      const first = questions[0] ?? {}
      const callId = request?.wait?.callId
      const key = `question:${String(callId ?? first?.id ?? request?.agent?.id ?? 'unknown')}`
      if (!once(key)) return
      const label = labelFor(request?.agent?.session, request?.agent?.id)
      enqueue(withClick(buildQuestionNotification({ questions, label, config }), request?.agent?.id))
    } catch (error) {
      warn('question notification failed', error)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    queue.length = 0
    for (const child of children) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    children.clear()
  }

  return {
    config,
    sent,
    enqueue,
    handleSessionEvent,
    handleQuestionRequest,
    dispose,
  }
}

/** Spawn the renderer process for one payload. */
function defaultSpawn(payload, settings) {
  return spawn(settings.powershell, settings.args, {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
}

/**
 * Register the two loopback routes that carry a popup click to the browser
 * half. `/click` is called by the popup renderer; `/pending` is polled by the
 * client, which then selects the session. Registration waits for the webServer
 * service, so headless profiles simply never mount them.
 */
function installOpenRoutes(ctx, state, logger) {
  const install = (hostCtx) => {
    const webServer = hostCtx?.webServer
    if (webServer === undefined || webServer === null) return
    state.webServer = webServer
    const register = (path, handler) => {
      try {
        hostCtx.effect(() => webServer.register({ kind: 'exact', path, handler }))
      } catch (error) {
        try {
          logger?.warn?.(`dsh-notify: failed to register ${path}`, error)
        } catch {
          // logging must never break the plugin
        }
      }
    }
    register('/dsh-notify/click', (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      let sessionId = ''
      try {
        sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session') ?? ''
      } catch {
        sessionId = ''
      }
      if (sessionId === '' || sessionId.length > 200) {
        writeJson(res, 400, { error: 'invalid-session' })
        return
      }
      state.pending = { sessionId, at: Date.now() }
      writeJson(res, 200, { ok: true })
    })
    register('/dsh-notify/pending', (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      const pending = state.pending
      state.pending = null
      if (pending === null || Date.now() - pending.at > 120000) {
        writeJson(res, 200, { sessionId: null })
        return
      }
      writeJson(res, 200, pending)
    })
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install)
  } catch (error) {
    try {
      logger?.warn?.('dsh-notify: failed to install click routes', error)
    } catch {
      // ignore
    }
  }
}

/**
 * Cordis plugin entry.
 *
 * @param ctx - host context.
 * @param rawConfig - the plugin row config from the profile patch.
 * @returns the notifier (handy for tests; cordis ignores the return value).
 */
export function apply(ctx, rawConfig) {
  let logger = null
  try {
    logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-notify') : null
  } catch {
    logger = null
  }
  const open = { webServer: null, pending: null }
  const notifier = createNotifier(rawConfig, {
    logger,
    clickBase: () => {
      try {
        return open.webServer?.getOrigin?.() ?? ''
      } catch {
        return ''
      }
    },
  })
  if (notifier.config.enabled === false) return notifier
  installOpenRoutes(ctx, open, logger)
  try {
    ctx.on('session/event', (session, event) => {
      notifier.handleSessionEvent(session, event)
    })
    ctx.on('user-questions/request', (request, next) => {
      try {
        notifier.handleQuestionRequest(request)
      } catch {
        // never veto a question request
      }
      return typeof next === 'function' ? next() : undefined
    })
    if (typeof ctx.effect === 'function') ctx.effect(() => () => notifier.dispose())
    else process.once('exit', () => notifier.dispose())
  } catch (error) {
    try {
      logger?.warn?.('failed to register notification listeners', error)
    } catch {
      // ignore
    }
  }
  return notifier
}

export default apply
