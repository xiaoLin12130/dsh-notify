/**
 * dsh-notify browser half.
 *
 * Polls the host plugin's loopback route for a "session to open" signal that
 * the notification renderer posts when the user clicks a popup, then selects
 * that session through the Workspace UI service. Polling (rather than a
 * push channel) keeps the host half free of client-protocol coupling; the
 * request is local, tiny, and only matters right after a click.
 *
 * Loaded by the DSH client module loader, hence the `__ModuleLoader__.load`
 * wrapper (the same shape official client bundles use).
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const name = 'dsh-notify'
    const inject = ['uiWorkspace']
    const ENDPOINT = '/dsh-notify/pending'
    const POLL_MS = 700

    /** Apply the browser half: poll for clicks and open the requested session. */
    function apply(ctx) {
      if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
      let disposed = false
      let inflight = false
      let lastAt = 0

      const open = (sessionId) => {
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch {
          // an unavailable view owner must not break polling
        }
      }

      const tick = async () => {
        if (disposed || inflight) return
        inflight = true
        try {
          const response = await window.fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) return
          const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') ?? '' : ''
          if (!contentType.toLowerCase().includes('application/json')) return
          const data = await response.json()
          if (data === null || typeof data !== 'object') return
          const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
          const at = typeof data.at === 'number' ? data.at : 0
          if (sessionId === '' || at === lastAt) return
          lastAt = at
          open(sessionId)
        } catch {
          // transient transport failure; the next tick retries
        } finally {
          inflight = false
        }
      }

      const timer = setInterval(tick, POLL_MS)
      const cleanup = () => {
        disposed = true
        clearInterval(timer)
      }
      try {
        ctx.effect(() => cleanup)
      } catch {
        // context without effect support: the page lifetime bounds polling
      }
      tick()
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
