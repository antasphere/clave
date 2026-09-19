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
- `sessions:write(id, input)` refuses sessions outside the caller’s window and accepts `Uint8Array` or a `user_message` event.

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
