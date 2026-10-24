import test from 'node:test'
import assert from 'node:assert/strict'

test('client half polls the host route and opens the requested session', async () => {
  let registration
  const opened = []
  const cleanups = []
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    fetch: async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'application/json; charset=utf-8' : null) },
      json: async () => ({ sessionId: 'sess-42', at: 12345 }),
    }),
  }
  try {
    const clientUrl = new URL('../lib/client.js', import.meta.url).href
    await import(`${clientUrl}?client-half-test`)
    assert.equal(registration.id, 'dsh-notify')
    const exports = registration.factory(() => {
      throw new Error('the client half must not require other modules')
    })
    assert.equal(exports.name, 'dsh-notify')
    assert.deepEqual(exports.inject, ['uiWorkspace'])
    assert.equal(typeof exports.apply, 'function')

    const ctx = {
      uiWorkspace: {
        openSession(sessionId) {
          opened.push(sessionId)
        },
      },
      effect(factory) {
        cleanups.push(factory())
      },
    }
    exports.apply(ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(opened, ['sess-42'])
  } finally {
    for (const cleanup of cleanups) cleanup()
    delete globalThis.window
  }
})
