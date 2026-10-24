import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildApprovalNotification,
  buildQuestionNotification,
  buildTurnNotification,
  clipText,
  createNotifier,
  formatDuration,
  normalizeConfig,
} from '../lib/index.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function fakeSession(overrides = {}) {
  return {
    id: 'sess-1',
    header: { cwd: 'C:\\work\\demo' },
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read' }, { type: 'text', text: '已修复登录页的 token 刷新逻辑。' }] },
    ],
    ...overrides,
  }
}

const config = normalizeConfig({})

test('normalizeConfig fills defaults and clamps numbers', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.style, 'popup')
  assert.equal(defaults.position, 'bottom-right')
  assert.equal(defaults.suppressWhenFocused, false)

  const tuned = normalizeConfig({
    suppressWhenFocused: false,
    durationMs: 10,
    maxConcurrent: 99,
    style: 'nonsense',
    powershell: '  pwsh  ',
  })
  assert.equal(tuned.suppressWhenFocused, false)
  assert.equal(tuned.durationMs, 1500)
  assert.equal(tuned.maxConcurrent, 5)
  assert.equal(tuned.style, 'popup')
  assert.equal(tuned.powershell, 'pwsh')
})

test('formatDuration renders seconds and minutes', () => {
  assert.equal(formatDuration(0), '')
  assert.equal(formatDuration(45_000), '45 秒')
  assert.equal(formatDuration(120_000), '2 分')
  assert.equal(formatDuration(151_000), '2 分 31 秒')
})

test('clipText collapses whitespace and ellipsizes', () => {
  assert.equal(clipText(' a\n b\t c ', 20), 'a b c')
  assert.equal(clipText('0123456789', 5), '0123…')
})

test('buildTurnNotification covers completed, error and abnormal reasons', () => {
  const completed = buildTurnNotification({
    kind: 'completed',
    reason: { kind: 'completed' },
    label: '演示会话',
    durationMs: 151_000,
    steps: 5,
    preview: '已修复。',
    config,
  })
  assert.equal(completed.title, '会话完成')
  assert.equal(completed.body, '已修复。')
  assert.equal(completed.accent, '#3FB950')
  assert.match(completed.footer, /演示会话 · 2 分 31 秒 · 5 步/u)

  const failed = buildTurnNotification({
    kind: 'error',
    reason: { kind: 'error', error: { message: 'upstream reset', code: 'ECONNRESET' } },
    label: '演示会话',
    config,
  })
  assert.equal(failed.title, '会话异常结束')
  assert.equal(failed.body, 'upstream reset (ECONNRESET)')
  assert.equal(failed.accent, '#F85149')
  assert.equal(failed.kind, 'error')

  const aborted = buildTurnNotification({ kind: 'aborted', reason: { kind: 'aborted' }, label: 'x', config })
  assert.equal(aborted.title, '会话已中止')

  const blocked = buildTurnNotification({ kind: 'blocked', reason: { kind: 'blocked' }, label: 'x', config })
  assert.equal(blocked.title, '会话被阻断')

  const maxTokens = buildTurnNotification({ kind: 'max-tokens', reason: { kind: 'max-tokens' }, label: 'x', config })
  assert.equal(maxTokens.title, '输出达到上限')

  assert.equal(buildTurnNotification({ kind: 'interrupted', label: 'x', config }), null)
})

test('approval and question payloads carry the waiting context', () => {
  const approval = buildApprovalNotification({
    toolName: 'bash',
    reason: 'write outside the workspace',
    label: '演示会话',
    config,
  })
  assert.equal(approval.title, '需要你的批准')
  assert.match(approval.body, /bash 请求你的批准：write outside the workspace/u)
  assert.equal(approval.accent, '#D29922')

  const question = buildQuestionNotification({
    questions: [{ id: 'q1', question: '要保留旧配置吗？' }, { id: 'q2', question: '第二个' }],
    label: '演示会话',
    config,
  })
  assert.equal(question.title, '需要你的选择')
  assert.match(question.body, /要保留旧配置吗？/u)
  assert.match(question.body, /共 2 个问题/u)
  assert.match(question.footer, /等待你的操作/u)

  const plan = buildQuestionNotification({
    questions: [{ id: 'plan-review', question: 'Approve this plan?', intent: { kind: 'plan-review' } }],
    label: '演示会话',
    config,
  })
  assert.equal(plan.title, '计划待审阅')
  assert.match(plan.body, /Approve this plan/u)
})

test('completed turn becomes one notification with title, duration and preview', async () => {
  const notifier = createNotifier({ dryRun: true }, { logger: silentLogger })
  const session = fakeSession()
  const start = 1_000_000
  notifier.handleSessionEvent(session, { type: 'session/title', seq: 0, time: start, data: { title: '登录页修复' } })
  notifier.handleSessionEvent(session, { type: 'turn/start', seq: 1, time: start, data: { turn: 1 } })
  notifier.handleSessionEvent(session, { type: 'step/end', seq: 2, time: start + 1000, data: { turn: 1, step: 1 } })
  notifier.handleSessionEvent(session, { type: 'step/end', seq: 3, time: start + 2000, data: { turn: 1, step: 2 } })
  notifier.handleSessionEvent(session, {
    type: 'turn/end',
    seq: 4,
    time: start + 95_000,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(notifier.sent.length, 1)
  const payload = notifier.sent[0]
  assert.equal(payload.title, '会话完成')
  assert.equal(payload.body, '已修复登录页的 token 刷新逻辑。')
  assert.match(payload.footer, /登录页修复 · 1 分 35 秒 · 2 步/u)
  notifier.dispose()
})

test('subagent sessions are ignored unless enabled', async () => {
  const notifier = createNotifier({ dryRun: true }, { logger: silentLogger })
  const child = fakeSession({ id: 'child', header: { cwd: 'C:\\work\\demo', origin: 'subagent', delegationDepth: 1 } })
  notifier.handleSessionEvent(child, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  notifier.handleSessionEvent(child, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(notifier.sent.length, 0)

  const allowed = createNotifier({ dryRun: true, subagents: true }, { logger: silentLogger })
  allowed.handleSessionEvent(child, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  allowed.handleSessionEvent(child, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(allowed.sent.length, 1)
  notifier.dispose()
  allowed.dispose()
})

test('approval and question requests notify once per identity', () => {
  const notifier = createNotifier({ dryRun: true }, { logger: silentLogger })
  const session = fakeSession()
  const approval = { type: 'approval/asked', seq: 7, time: 1, data: { id: 'approval-1', toolName: 'pwsh', reason: 'run a command' } }
  notifier.handleSessionEvent(session, approval)
  notifier.handleSessionEvent(session, approval)
  assert.equal(notifier.sent.length, 1)
  assert.equal(notifier.sent[0].title, '需要你的批准')

  const request = {
    questions: [{ id: 'q1', question: '选哪个方案？' }],
    agent: { id: session.id, session },
    wait: { callId: 'call-1' },
  }
  notifier.handleQuestionRequest(request)
  notifier.handleQuestionRequest(request)
  assert.equal(notifier.sent.length, 2)
  assert.equal(notifier.sent[1].title, '需要你的选择')
  notifier.dispose()
})

test('concurrent notifications are assigned distinct stacking slots', () => {
  const messages = []
  const children = []
  const spawn = (message) => {
    messages.push(message)
    const handlers = new Map()
    const child = {
      stdin: { end() {} },
      stderr: { on() {} },
      on(name, handler) { handlers.set(name, handler); return child },
      kill() {},
      finish() { handlers.get('exit')?.(0) },
    }
    children.push(child)
    return child
  }
  const notifier = createNotifier({}, { logger: silentLogger, spawn })
  notifier.enqueue({ title: 'a' })
  notifier.enqueue({ title: 'b' })
  notifier.enqueue({ title: 'c' })
  assert.deepEqual(messages.map((message) => message.slot), [0, 1, 2])
  assert.deepEqual(messages.map((message) => message.title), ['a', 'b', 'c'])
  for (const child of children) child.finish()
  notifier.dispose()
})

test('click-to-open attaches a loopback URL and a hint when a web server exists', async () => {
  const origin = 'http://127.0.0.1:4321'
  const notifier = createNotifier({ dryRun: true }, { logger: silentLogger, clickBase: () => origin })
  const session = fakeSession()
  notifier.handleSessionEvent(session, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  notifier.handleSessionEvent(session, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(notifier.sent.length, 1)
  assert.equal(notifier.sent[0].clickUrl, `${origin}/dsh-notify/click?session=sess-1`)
  assert.match(notifier.sent[0].footer, /点击打开会话/u)

  const disabled = createNotifier({ dryRun: true, openOnClick: false }, { logger: silentLogger, clickBase: () => origin })
  disabled.handleSessionEvent(session, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  disabled.handleSessionEvent(session, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(disabled.sent[0].clickUrl, undefined)
  notifier.dispose()
  disabled.dispose()
})

test('web server routes hand a clicked session to the polling client', async () => {
  const origin = 'http://127.0.0.1:4321'
  const routes = new Map()
  const hostCtx = {
    webServer: {
      getOrigin: () => origin,
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect(factory) {
      factory()
      return () => {}
    },
  }
  const ctx = {
    on() {},
    effect(factory) {
      factory()
      return () => {}
    },
    logger() {
      return silentLogger
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      callback(hostCtx)
    },
  }
  const notifier = apply(ctx, { dryRun: true })
  assert.equal(typeof routes.get('/dsh-notify/click'), 'function')
  assert.equal(typeof routes.get('/dsh-notify/pending'), 'function')

  const makeResponse = () => ({
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
    destroy() {},
  })
  const request = (url) => ({ url, socket: { remoteAddress: '127.0.0.1' } })

  const click = makeResponse()
  routes.get('/dsh-notify/click')(request('/dsh-notify/click?session=sess-9'), click)
  assert.equal(click.status, 200)
  assert.deepEqual(JSON.parse(click.body), { ok: true })

  const first = makeResponse()
  routes.get('/dsh-notify/pending')(request('/dsh-notify/pending'), first)
  const firstBody = JSON.parse(first.body)
  assert.equal(firstBody.sessionId, 'sess-9')
  assert.equal(typeof firstBody.at, 'number')

  const second = makeResponse()
  routes.get('/dsh-notify/pending')(request('/dsh-notify/pending'), second)
  assert.deepEqual(JSON.parse(second.body), { sessionId: null })

  const rejected = makeResponse()
  routes.get('/dsh-notify/click')({ url: '/dsh-notify/click?session=x', socket: { remoteAddress: '10.0.0.5' } }, rejected)
  assert.equal(rejected.status, 403)

  const session = fakeSession()
  notifier.handleSessionEvent(session, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  notifier.handleSessionEvent(session, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(notifier.sent[0].clickUrl, `${origin}/dsh-notify/click?session=sess-1`)
  notifier.dispose()
})

test('apply registers the session and question listeners and disposes cleanly', async () => {
  const handlers = new Map()
  let effectDisposer = null
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    effect(factory) {
      effectDisposer = factory()
      return () => {}
    },
    logger() {
      return silentLogger
    },
  }
  const notifier = apply(ctx, { dryRun: true })
  assert.equal(typeof handlers.get('session/event'), 'function')
  assert.equal(typeof handlers.get('user-questions/request'), 'function')
  assert.equal(typeof effectDisposer, 'function')
  let nextCalled = false
  const result = await handlers.get('user-questions/request')(
    { questions: [{ id: 'q1', question: '继续吗？' }] },
    async () => { nextCalled = true; return { answers: [] } },
  )
  assert.equal(nextCalled, true)
  assert.deepEqual(result, { answers: [] })
  assert.equal(notifier.sent.length, 1)
  effectDisposer()
  notifier.handleQuestionRequest({ questions: [{ id: 'q2', question: '之后还会通知吗？' }] })
  assert.equal(notifier.sent.length, 1)
})
