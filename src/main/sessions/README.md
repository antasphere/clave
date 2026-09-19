# Sessions and adapters

`sessionManager` owns provider-neutral session records and consumers. Adapters own
processes. `SessionStream` carries either UTF-8 PTY bytes or typed events; state
transitions also appear as `state_change` events. Exit is a separate notification.
Schemas and the v1 event vocabulary live in `src/shared/session-model.ts`.

The existing `ptyManager` API is a compatibility facade. It synchronously prepares
and registers a handle, then the first terminal resize starts the process. The
PTY backend retains launch profiles, Claude account injection, tmux metadata and
recovery. Its data reaches xterm through a registry subscription; additional
consumers do not replace that subscription. App shutdown detaches tmux clients;
explicit close destroys the backing session. `attach()` is reserved for event
adapters and has no production caller in this wave. Restoring a persisted PTY
uses the existing adoption spawn options so the same tmux session is reattached at the terminal's measured size.

## IPC

- `sessions:list` returns the asking window's records.
- `sessions:subscribe(id)` refuses sessions outside the caller’s window, returns the record and starts notifications on
  `sessions:stream:<id>` and `sessions:exit:<id>` for that WebContents.
- `sessions:unsubscribe(id)` removes that consumer's notifications.
- `sessions:write(id, input)` refuses sessions outside the caller’s window and accepts `Uint8Array` or a validated `SessionInput` (user message, permission response, interrupt).

The preload exposes `sessionsList`, `sessionsSubscribe`, `sessionsUnsubscribe`,
`sessionsWrite`, `onSessionStream`, and `onSessionStreamExit` on `window.electronAPI`.
Install notification listeners before invoking subscribe, and await subscription
before writing. Each renderer view pairs its subscribe with unsubscribe and
removes its own listeners; the preload reference-counts the underlying subscription
so closing one view does not silence another. One IPC subscription per session per WebContents is retained;
multiple in-process consumers can each subscribe independently. Window teardown
removes its consumers without killing providers. `SessionIPC` and
`SessionIPCEvents` in the preload declarations describe the additive wire API.

Adapters must retain their handle until kill and defer output until consumers can
bind. The built-in PTY adapter starts on resize; echo emits only in response to
write. Listener exceptions are isolated so a failed consumer cannot interrupt
another view or process cleanup. `forget` removes the registry entry after a
compatibility close or detach, allowing the same id to be adopted in a new window.

## Echo fixture

Launch Electron with `--dev-echo-adapter`; the existing Claude launch-profile
picker gains **Echo (development)**. It creates provider `echo`, adapter `echo`,
transport `events` through the normal launcher. A `user_message` produces, in
order: the message, working state, final assistant text, a correlated tool call
and result, and done state. Closing the tab emits ended state and exit code 0.
The profile is absent without the flag, and explicit attempts to use its reserved
id return false from the echo-profile predicate. It does not invoke a provider or require credentials.

## Capture compatibility

Hook transitions append immediately with main-process identity and the last
renderer identity already received. Matching renderer reports acknowledge those
writes; reports without a manager transition still append. Codex title state
and exits retain the existing renderer capture path; there is no main-process
OSC parser. Pi remains excluded by the unchanged exos contract. Capture caches
are cleared at exit, tab close, and manager removal (including app shutdown).
Late terminal acknowledgements consult the durable log instead of retaining
closed session ids in memory. No capture write waits on a timer.

## Claude conversations (wave 2)

The launcher lists **Claude (chat)** (`claude-chat`); **Codex (chat)** is declared
but is listed only once `codex-chat` registers. Events profiles carry `adapterId`;
the facade resolves the registered adapter and awaits its standard `spawn()`.
The PTY path still prepares synchronously, starts on the first resize, and keeps
tmux adoption unchanged; only its IPC caller awaits the returned session.
PTY and opt-in echo remain available. An events session does not create a PTY or
tmux session. A Claude handle starts its pipe process on the first user input,
so listeners installed before subscribe/write see the initial metadata too.

`SessionInput` accepts `user_message`, `permission_response { id, optionId }`,
and `interrupt`. Raw bytes are rejected by Claude. The shared launch argv builder,
POSIX shell resolver, hook settings, MCP config, account token and config folder
are reused. Account context stays in main, outside the Session record. Options
are `{ resume?, model?, permissionMode? }`; resume replaces `--session-id`.
The launcher dangerous toggle maps to Claude `bypassPermissions` and Codex
`never`, matching each adapter’s provider-specific permission vocabulary.
Closing the tab terminates the owned process group, escalates after one second,
and publishes ended then exit before the facade forgets the record.

Claude Code 2.1.278 needs **both** `--permission-prompts host` and
`--permission-prompt-tool stdio`: host alone silently denies prompts. The recorded
permission turn verifies the control-request/response round trip. Choices are
`allow-once`, `deny`, and `allow-always` only when the request has actual
`permission_suggestions`; the last applies exactly those updates (which may be
session-scoped), never an invented blanket permission. Interrupt is a
`control_request` with `request: { subtype: 'interrupt' }`, not a signal.
Unknown frames and complete message metadata remain `provider_event`; malformed
frames produce nonfatal errors. Text snapshots do not duplicate partial text.
A final empty text event closes each assistant message. Result usage/cost remains
in the provider event, followed by done. Process close publishes ended then exit.

State transitions reach the existing sidebar channel for the owning window and
flow through the existing main capture subscription; hook settings are retained
for capture compatibility. Chat rendering is owned by the separate chat-view
lane. `claude-adapter.test.ts` and `tests/e2e/claude-chat-adapter.spec.mjs` use
recorded fixtures and a stub executable; they never call a real provider.


An adapter may implement optional `ready(handle)`. The manager completes it at most
once per session (failed calls may retry), from `sessions:subscribe` after that
consumer's stream and exit notifications are bound. Claude sends a configured `initialPrompt` then, and
reports `initialCommand` / `autoExecute` as unsupported error events; it never
executes those shell commands. Other adapters need no readiness hook.

For events sessions the stream exclusively owns state; hook files are still
written but cannot race the stream's state. Init metadata stamps the facade's
model before the first working transition while preserving the minted launch
identity, so main-side capture, usage snapshots and subagent discovery do not
depend on a terminal view.
The init frame is deliberately not forwarded as a raw provider event because it
contains local memory and socket paths. App quit awaits process termination and
escalation before allowing Electron to exit. Claude chat is hidden on Windows.

Register `onSessionStream` before awaiting `sessionsSubscribe`: `ready()` runs
inside the subscribe handler and can emit the initial prompt or an error before
that promise resolves. A failed ready call emits a non-fatal error without
rejecting subscription and can be retried by subscribing again; only successful
readiness consumes the one-shot.
## Codex events adapter

`codex-chat` uses one `codex app-server` stdio connection per session. It omits
`sandbox` on `thread/start` and `thread/resume`, preserving the user's own Codex
configuration; it never requests `danger-full-access`. Explicit permission mode
`never` changes approval prompts without choosing a sandbox. The current adapter
supports `on-request` and `never`; `untrusted` is an adapter limitation even though
Codex 0.154.0 accepts it through the thread protocol (but rejects the CLI `-c` form).
A second `user_message` during an active turn is refused by design; steering an
active Codex turn is not exposed through this v1 adapter.
