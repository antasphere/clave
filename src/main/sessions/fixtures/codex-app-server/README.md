# Codex app-server 0.154.0

`live.ndjson` is a selected, redacted capture from the installed CLI on 2026-09-19.
Each row contains `direction` and the actual `frame`. Thread/turn IDs and the home
path are anonymized, the handshake host fingerprint removed, and account quota
values replaced with neutral values. Repetitive local MCP-startup and hook frames
are omitted (they disclose machine integrations); all conversation frames remain.

Discovery commands:

```
codex --version
codex app-server --help
codex app-server generate-ts --out /tmp/clave-2536-protocol
codex app-server -c 'sandbox_mode="read-only"' -c 'approval_policy="on-request"'
```

Over that stdio connection: `initialize`, `initialized`, `thread/start`, then
three `turn/start` calls: a one-line response with no tools, a request to create
`/tmp/clave-2536-approval-check` with escalated permissions, and a prose response
interrupted with `turn/interrupt`. The command approval was answered `decline`;
no command executed. The first completed assistant message was exactly
`Clave protocol ready.`; the final turn completed with status `interrupted`.

The installed executable rejects `untrusted` as a `-c approval_policy` flag,
but accepts it as `thread/start.approvalPolicy` (confirmed by the independent
verifier on 0.154.0). This adapter deliberately exposes only `on-request`
(default) and explicit `never` for now; its `untrusted` rejection is an adapter
limitation, not a limitation of the thread protocol.

The adapter omits `sandbox` on start and resume, preserving the user’s own
Codex configuration, including a stricter `read-only` preference. It never
sends a sandbox-disabling value. Explicit `never` changes approval prompts,
not the configured sandbox. Model and approval policy go
through the thread protocol instead of shell interpolation. The PTY-only
`tui.terminal_title` override is intentionally irrelevant to the headless adapter.
`thread/resume` uses `threadId`, and `turn/interrupt` requires both IDs.

Runtime approval frames include `availableDecisions` even though the stable
TypeScript generator omits that field. String decisions remain option ids;
structured decisions are JSON-serialized as option ids and sent back unchanged.
The capture's decline was accepted even though it was not in availableDecisions;
Clave deliberately limits the UI to exactly the offered choices.

File-change/MCP items, permission grants, and elicitation edge cases in unit tests
are schema-derived synthetic cases, not claimed as live captures. Tests never
contact a real provider.
