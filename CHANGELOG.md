# Changelog

## 0.1.0

- Host-side notifications for DSH session stops: completed, needs input,
  failed, aborted, blocked, and output-token ceiling.
- Topmost notification cards with per-kind accent colors, stacking slots,
  click-to-dismiss, and optional Windows toast (`popup` / `toast` / `both`).
- Click-to-open: a card click focuses DeepSeek Harness and selects the session
  through `ctx.uiWorkspace.openSession()`; a loopback route carries the click
  from the renderer to the browser half.
- Focus suppression, sounds, per-kind switches, subagent toggle, completion
  preview, deduplication, and a configurable PowerShell renderer path.
- Unit tests for event mapping, route handoff, and the client polling half.
