# Conversation provider adapters

`createAdapter` owns one installed CLI process for one conversation. It does not
use an agent SDK, PTY, tmux, shell command string, or shared provider daemon.
The conversation service owns durable Clave history; the provider owns its native
resume history.

## Protocol compatibility

Verified locally with installed CLIs:

| Provider | Version | No-model verification | Turn protocol |
| --- | --- | --- | --- |
| Claude Code | 2.1.274 | `--version`, `--help`, stream-json `initialize` | Persistent `--print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --permission-prompt-tool stdio` |
| Codex | 0.154.0 | `--version`, app-server help, `initialize`, `thread/start` | stdio app-server `thread/start` or `thread/resume`, `turn/start`, `turn/interrupt` |
| OpenCode | 1.18.15 | `--version`, serve help, authenticated health/SSE/session creation | Owned loopback `serve`, HTTP commands and SSE events |
| Pi | 0.85.1 | `--version`, `--help`, RPC `get_state` | `--mode rpc`, `prompt`, `abort`, agent/message/tool events |

These are compatibility observations, not a promise that every older or newer CLI
works. Initialization negotiates the protocol through its real handshake and
validates response shapes. Codex opts into experimental question requests and sets
`approvalsReviewer: "user"`. OpenCode requires the version-bearing health response.
Unknown actionable Claude controls, Codex server requests, OpenCode permission or
question events, and Pi extension input requests fail closed. Non-interactive
provider telemetry can be ignored.

Protocol references used, without importing their runtimes:

* [Claude Python SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py):
  initialize, interrupt, `can_use_tool`, allow `updatedInput`, deny, cancellation.
  This is a wire reference only. Clave launches the installed Claude coding CLI.
* [Codex protocol source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2):
  `thread.rs`, `turn.rs`, and `item.rs` define camel-case requests, text input,
  accept/decline approval decisions, and question answer maps.
* [OpenCode generated SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts):
  session permission rules, `prompt_async`, message part deltas, permission
  reply, question reply/reject, session status.
* Pi's installed `docs/rpc.md`, `dist/modes/rpc/rpc-types.d.ts` and `rpc-mode.js`.
  In 0.85.1 `prompt` responds after preflight acceptance, not after generation.
  `agent_settled`, not `agent_end`, ends the operation after retries/compaction.

No paid/model prompts or authentication changes were performed against installed
providers. Real generation, login-specific behavior, and actual paid-turn resume
remain unverified. Fixtures exercise these protocol transitions without invoking
a model.

## Lifecycle and safety

* `start()` resolves after the handshake and session initialization. `send()`
  resolves on command acceptance, never after the whole turn. Claude has no
  separate prompt acknowledgement, so its acceptance means a successful stdin
  write; later provider rejection becomes a failed turn. Pi also acknowledges
  the pipe write, since a preflight extension can ask a question before its
  prompt RPC replies. That outstanding RPC is bounded by the process/session
  lifecycle rather than a wall-clock deadline while waiting for a human.
* A result/turn-completed/agent-settled/session-idle event ends the turn. Interrupt
  leaves the process and native history intact, removes pending UI requests, and
  waits for the provider's terminal event. Missing interrupt completion is fatal
  after 10 seconds.
* Partial text and final snapshots share IDs. Full assistant snapshots replace,
  rather than append to, already streamed text.
* Tool permission responses require an explicit allow. Denials use each native
  protocol. Unknown controls never grant approval. `dangerousMode` selects
  Claude permission bypass, Codex unrestricted sandbox, or OpenCode allow rules.
  Claude otherwise follows its native settings and trusted profile's
  `--permission-mode`, including `auto`. Clave does not append a mode override.
  Native policy can approve tools without sending a request to Clave; a working
  permission-review interface does not mean every tool requires a host prompt.
* Pi has **no tool permission API**. Its capability notice says tools run according
  to Pi configuration. The question UI is only for its extension UI requests, not
  a pretend tool approval gate.
* OpenCode generates a fresh 256-bit server password in memory, binds loopback at
  an OS-assigned port, and uses Basic authentication for HTTP and SSE. It accepts
  only its child's announced loopback address and validates authenticated health.
  It never discovers/reuses a user's running server. Session rules use `ask`
  unless dangerous mode is explicit, including when resuming a session.
* Every command-prefix and additional argument is preserved as an argv entry.
  Managed transport and persistence overrides are rejected. Claude's
  `--permission-mode` is a profile option, not a transport override.
  No shell interprets those arguments. Other trusted profile flags still follow
  the installed CLI's own semantics and can be rejected by that CLI.
* Native provider storage follows the supplied environment. New Pi sessions use
  `sessionDirectory`; imported Pi history UUIDs keep using their native store on
  every restart. Claude/Codex/OpenCode do not expose an equivalent independent
  per-conversation transcript directory, so they keep their native store. Changing
  their config/data homes merely to relocate history would also change account and
  project configuration.
* JSONL/SSE events and HTTP bodies are limited to 4 MiB. Prompts are limited to
  1,000,000 UTF-8 bytes, pending RPC and user requests to 64, tools/message role
  indexes to 4096 per turn. Tool display fields are capped at 32 KiB. RPC calls time
  out after 30 seconds, HTTP calls and readiness after 15 seconds.
* Stderr is drained with constant memory but never stored or displayed. Errors
  contain fixed messages and numeric exit/status codes, not provider bodies,
  credentials, launch environments, or command lines.
* Disposal targets only the owned POSIX process group, with SIGTERM and SIGKILL
  after 500 ms. Windows uses `taskkill /PID <owned pid> /T`. Tools that deliberately
  detach into a separate process group are outside this guarantee. No broad process
  matching is used.
* Disconnects are fatal rather than transparently reconnecting and losing
  permission requests or text. The service can explicitly restart/resume.

## Supported questions and limitations

Claude `AskUserQuestion`, Codex `item/tool/requestUserInput`, OpenCode question
requests and Pi select/confirm/input/editor requests map to Clave questions.
Providers that bundle questions get a separate Clave request per question; the
adapter sends the native reply after all answers arrive. The current contract has
one string per answer, so multi-select questionnaires support one selected value,
not a full multi-select widget. Codex secret questions fail closed because this
contract has no secure, non-persisted answer channel.

Claude cancellation controls and Codex `serverRequest/resolved` invalidate the
matching UI requests. OpenCode reply/reject events do the same. Pi question
timeouts cancel the local request and send a negative response. Interrupt, exit
and disposal invalidate all requests. Responses to stale IDs reject.

Thinking/reasoning, token usage, attachments, interactive MCP elicitation,
realtime/audio, arbitrary dynamic tool execution and richer extension widgets are
not part of this contract. New actionable server requests for these fail closed;
non-interactive reasoning/usage events are not projected. Existing provider-native
history is resumed but is not re-imported into Clave's already-persisted transcript.
Claude can receive the service-generated `mcpConfigPath`; other MCP configuration
continues to come from the provider's native configuration.

## Verification

```sh
npm test -- src/main/conversations/adapters
npm run typecheck:node

# Opt-in installed CLI startup only, with temporary in-repository data homes.
# Does not submit any prompt.
CLAVE_PROVIDER_SMOKE=1 npm test -- src/main/conversations/adapters/smoke.test.ts
```

Tests were added before implementation. `fixtures/` contains deterministic
stdio and authenticated HTTP/SSE peers. Checks assert multi-turn behavior, native
resume commands, authoritative streaming snapshots, tool transitions, allow/deny
wire decisions, questions, cancellation, unknown controls, split UTF-8,
malformed/oversized framing, crashes, interrupt and managed flag conflicts.
The installed smoke checks assert readiness and provider IDs and exit nonzero on
failure. Temporary homes are deleted only after owned-process disposal.

Mutation check: changing Claude's explicit deny response into an allow makes
`claude permissions > requires explicit deny response` fail on its wire-decision
assertion. The mutation was removed and the same test passed again.
