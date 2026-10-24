#!/usr/bin/env node
/**
 * Visual check: drives the real notifier with three sample stop reasons.
 *
 *   node scripts/visual-check.mjs
 *
 * Three notification cards appear on the active screen (stacked bottom-right)
 * and disappear after a few seconds. Use it to verify the renderer works on
 * this machine without waiting for an agent turn.
 *
 * The filename intentionally avoids `*-test.mjs` / `test/**` so `node --test`
 * does not pick it up (it opens real windows).
 */
import { createNotifier } from '../lib/index.js'

const notifier = createNotifier({
  suppressWhenFocused: false,
  durationMs: 6000,
  debug: true,
}, {
  logger: {
    info: (message) => console.log('[dsh-notify]', message),
    warn: (message, error) => console.warn('[dsh-notify]', message, error ?? ''),
  },
})

const session = {
  id: 'visual-check',
  header: { cwd: 'C:\\work\\demo' },
  deriveMessages: () => [
    { role: 'assistant', content: [{ type: 'text', text: '修复了通知渲染，并通过 10 个单元测试。' }] },
  ],
}

const now = Date.now()

// 1. completed turn
notifier.handleSessionEvent(session, { type: 'session/title', seq: 0, time: now, data: { title: '通知插件自检' } })
notifier.handleSessionEvent(session, { type: 'turn/start', seq: 1, time: now - 151_000, data: { turn: 1 } })
notifier.handleSessionEvent(session, { type: 'step/end', seq: 2, time: now - 100_000, data: { turn: 1, step: 1 } })
notifier.handleSessionEvent(session, { type: 'step/end', seq: 3, time: now - 50_000, data: { turn: 1, step: 2 } })
notifier.handleSessionEvent(session, { type: 'turn/end', seq: 4, time: now, data: { turn: 1, reason: { kind: 'completed' } } })

setTimeout(() => {
  // 2. needs an answer (normal ask_user_question)
  notifier.handleQuestionRequest({
    questions: [
      { id: 'q1', question: '要把测试通过的报告一起发出去吗？' },
      { id: 'q2', question: '第二个问题' },
    ],
    agent: { id: session.id, session },
    wait: { callId: 'visual-check-question' },
  })
}, 500)

setTimeout(() => {
  // 3. failed turn
  notifier.handleSessionEvent(session, { type: 'turn/start', seq: 10, time: now, data: { turn: 2 } })
  notifier.handleSessionEvent(session, {
    type: 'turn/end',
    seq: 11,
    time: now + 1000,
    data: { turn: 2, reason: { kind: 'error', error: { message: 'upstream closed the connection', code: 'ECONNRESET' } } },
  })
}, 1000)

setTimeout(() => {
  console.log('[dsh-notify] visual check finished; notifications close themselves.')
}, 2500)
