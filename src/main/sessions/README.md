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

## Attachments

A `user_message` may carry `attachments`: records (id, path, name, MIME type,
size, delivery) of files the reader attached, never their bytes. The composer
obtains a record through `sessions:files` (`prepare`), which validates the
file, copies it out of an OS temp folder into
`<userData>/session-attachments/<sessionId>/` (a macOS screenshot preview is
gone before the agent reads it) and writes a pasted image there from its bytes,
named by its magic number rather than by the clipboard. The same channel offers
the native picker, a preview and open-in-app for a chip.

Sending is the ordinary `sessions:write`. For a message with attachments the
handler builds the prepared prompt in main — every file is stat'ed and read
again at send time, against the adapter's `images` capability
(`sessions:capabilities`) — and hands the adapter the message with a `prepared`
field: the text with one JSON line per reference appended under "Attached local
files", and the images as base64. Whatever a renderer put in `prepared` is
discarded. Adapters call `providerPrompt(input)` for what to send (Claude:
image content blocks in stream-json; Codex: `image` input items as data URLs;
echo: appends "(N images received)"; PTY and plugin providers: the text) and
`userMessageEvent(input)` for what to stream, which is the message as written,
attachments included and `prepared` dropped, so no image payload reaches a
renderer's log. An image for an adapter without the capability is refused at
the write with the reader's remedy in the message; the fallback to a reference
is the reader's explicit choice in the composer, never automatic. Limits:
10 files, 5 MiB per image, 20 MiB of images per message
(`src/shared/attachments.ts`). A resumed Claude transcript replays the text of
a past message; its image content has no path and is not replayed as chips.

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

The launcher lists **Claude (chat)** (`claude-chat`) and **Codex (chat)**
(`codex-chat`) when their adapters are available. Saved Claude and Codex launch
profiles also offer a chat choice, such as **Work (chat)**. These choices use the
saved command and arguments, including wrappers, and can be selected as global
or workspace defaults. They are derived from the saved profile, so editing it
updates both choices; deleting it clears either default. Their stable ids are
`chat:<family>:<profile id>`, and a stale chat id fails instead of launching a
different command. Claude chat restore keeps this id and the account selection.
Events profiles carry `adapterId`. The facade resolves the registered adapter
and awaits its standard `spawn()`.
The PTY path still prepares synchronously, starts on the first resize, and keeps
tmux adoption unchanged; only its IPC caller awaits the returned session.
PTY and opt-in echo remain available. An events session does not create a PTY or
tmux session. A Claude handle starts its pipe process at `ready()`, the moment
a consumer is bound (or on the first input, the models/commands menus or a
model switch, whichever comes first), so the CLI's boot — login shell, plugins,
MCP servers, seconds on a loaded setup — overlaps the reader's typing instead
of following their Enter; the init frame only follows the first message, so no
listener misses it. The process starts directly when `findExecutable` places
the command on the cached login environment's PATH (`src/main/shell-launch.ts`)
and through the login-shell wrapper only when it cannot, since an events
session has no terminal for the user's shell to own and the wrapper cost a
zprofile on every launch. A user message marks the session `working` at once,
the first one included; the CLI's init frame used to be the first word.

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

A chat tab is named by its first message, as a terminal tab is. The terminal
path reads the first user message off Claude's transcript; a chat tab has no
transcript to watch, so `sessions:write` hands every user message to
`title-generator.ts` (`notifyChatMessage`), which acts on the first one worth
a title (not a slash command, not a bare yes/no) for a session the facade
scheduled at spawn (`scheduleChatTitle`, fresh conversations only — a resumed
one keeps the name it was saved under). The title arrives on
`session:auto-title:<id>`, the terminal tab's channel, and the pane host
(`views/registry.tsx`) applies it through `autoRenameSession`, so a name the
user chose is never overwritten. `title-generator.test.ts`,
`pty-manager-chat-records.test.ts`, `ipc.test.ts` and
`tests/e2e/chat-first-message-title.spec.mjs` hold this.

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

## Plugin-supplied adapters (wave 3)

A plugin contributes a provider through `contributes.adapters[]`:
`{ id, name, entry, command, capabilities }`, validated in
`packages/plugin-sdk/src/manifest.ts`. The entry is a **built CommonJS file**
inside the plugin, `id` may not be one of `pty`, `echo`, `claude-chat`,
`codex-chat`, and declaring an adapter at all requires `sessions.write` in
`permissions` — an adapter owns a session's input and output, and nothing
narrower covers that. `src/main/sessions/plugin-adapters.ts` is the host side.

**The mapping onto `SessionAdapter`.** The plugin does not implement the
adapter interface; `PluginSessionAdapter` does, one instance per contributed id,
and it is what `sessionManager` registers. The plugin exports
`createAdapter(launch, emit)` returning `{ start, send, interrupt, respond,
dispose }` plus optional `models` / `commands` / `setModel`. `launch` carries
`{ sessionId, cwd, command, options }`, frozen; `command` is the manifest's,
verbatim, which is what a real provider spawns.

| `SessionAdapter`              | The plugin's adapter                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `spawn`                       | resolves the pinned revision, requires the module, `start()` |
| `ready`                       | drains what `start()` emitted (see below)                    |
| `write` `user_message`        | `send(text)`                                                 |
| `write` `interrupt`           | `interrupt()`                                                |
| `write` `permission_response` | `respond({ id, optionId })`, prefix stripped                 |
| `write` `set_model`           | `setModel(model)`, or a non-fatal error if it has none       |
| `write` raw bytes             | refused: a plugin adapter is events-only                     |
| `models` / `commands`         | the optional methods, or an empty list                       |
| `kill`                        | `dispose()`, then exit 0                                     |

**Readiness, not binding, releases the first events.** The manager binds its own
listeners inside `adopt()` but publishes to the consumers it has at that moment,
and it has none until `sessions:subscribe`. So everything emitted between
`spawn` and readiness is buffered (1000 events) and flushed in `ready()`, which
runs after a consumer's stream and exit notifications are bound. A plugin can
therefore speak in `start()` without its first words falling on the floor.

**Every event crosses a schema.** `emit` validates against `SessionEventSchema`;
an invalid event is dropped with a logged error and the session continues. Ids a
plugin mints (`tool_call`, `tool_result`, `permission_request`) are prefixed with
the plugin id so two plugins cannot collide, and the prefix is stripped off an
incoming `permission_response` before the plugin sees it.

**Capabilities are enforced.** `permissions: false` drops a request that names a
`toolName`; `questions: false` drops one that does not — a request naming no tool
is a free-form question. `resume: false` refuses a launch carrying a resume id
rather than quietly starting a fresh session. `notice` is emitted once at session
start as a `provider_event` carrying `{ notice }`; rendering it is the view's.

**The module loads at spawn and nowhere else** — never during discovery, install
or listing. The plugin's `contentDigest`, which `PluginStore` computes at
discovery, is pinned per session: a revision the store has re-hashed since is
required afresh rather than served from Node's module cache, sessions already
running keep the factory they started on, and `attach` refuses once the pin and
the store disagree. The digest is the store's _discovery-time_ digest, so bytes
edited mid-run are caught at the next discovery (`needsReview: 'digest-change'`),
not at the next spawn.

**Enabling and disabling.** An adapter id keeps resolving to its events profile
for the life of the app, whether the plugin is enabled, disabled or since removed,
so a launch naming it is refused by name instead of silently becoming a terminal.
That holds on both paths: an explicit launch id is refused when the adapter spawns,
and a _stored default_ is refused in `resolve()`, which is the common case and the
one the shared resolver would otherwise answer with the family's built-in. Its one
limit is a restart: an id contributed by a plugin removed in an earlier run is
indistinguishable from a deleted custom profile, and takes the built-in fallback.
Only enabled plugins with `sessions.write` actually granted appear in the launcher. Disabling hides new launches and leaves running
sessions alone — the registered adapter lives for the app's lifetime, and the
manager holds its reference per session. Whether a bundled plugin starts enabled
is the host's own rule (`BUNDLED_ON_FIRST_INSTALL` in
`src/main/plugins/plugin-store.ts`); `clave.echo-provider` is deliberately not on
that list, because a launcher must not offer a provider nobody asked for.

**The manifest's `command` is a declaration, not a launch.** The host never runs
it. Nothing is spawned for an events session, and the command is handed to the
adapter as frozen data for it to interpret, besides being shown as the launch
profile's command. So there is no host-side environment stripping and no binary
check on it, and a plugin may start whatever it likes with the main process's
full environment.

**This is a protocol boundary, not a sandbox.** A plugin's adapter module is
`createRequire`d into Clave's **main process**: the app's pid, the app's full
environment, `require` of anything, and the ability to start other programs. That
is a different and much weaker containment than the one `src/main/plugins/README.md`
describes for a plugin's `main`, which does get its own utility process and a
trimmed environment; that file now carries both models side by side, and the
review dialog says which one applies before an adapter plugin is enabled. Link
only code you trust.

**Two limits worth knowing.** A plugin can emit `user_message` and a fatal
`error` on its own session, so it can write turns into its own transcript that
read as the user's and can end its own session; this reaches no other session.
And an event is bounded at 256 KiB, dropped with a logged error above that,
because plugin code mints these and they cross into a renderer.

`plugins/echo-provider/` is the bundled example, and `plugin-adapters.test.ts`,
`plugin-sessions.test.ts` and `tests/e2e/plugin-provider.spec.mjs` are what hold
all of the above.
