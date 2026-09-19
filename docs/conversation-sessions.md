# Conversation sessions

New Claude, Codex, Pi, and OpenCode sessions use a Clave-owned conversation
view. Each session has a fixed provider. Terminal tabs, Antigravity, and
`claude agents` keep their PTY implementation. Saved Claude, Codex, and Pi
terminal tabs open a migration view rather than attaching a terminal.

## Working with the view

The conversation uses a bounded reading column and a separate composer. Tool
activity between messages shares one collapsed row, including mixed calls such
as reads, searches, and commands. Expanding it shows targets, available line
ranges and changes, and eight-line content previews with **Show more**. **Raw
details** retains the original input/output. Unknown tools keep their names and
readable output. Artifact entries remain outside the tool dropdown.

Opening tool details pauses auto-follow so expansion keeps your place. Use
**Jump to latest** to follow new output again. Groups update while tools run
and keep the reader's open/closed choice, including when a call fails. Failures
show an indicator in the summary but never expand a group automatically.
Session capabilities live behind **Session details**; permission requests,
provider failures, and Pi's missing approval gate stay visible.

Enter sends a message, Shift+Enter adds a line, and IME composition does not
submit. Drafts belong to the session rather than the mounted view. They survive
switching and renderer reload through local browser storage. A send acknowledgment
clears only the submitted draft revision, never text typed while it was pending.
An uncertain retry keeps its command ID to avoid duplicate execution.

With an empty composer, Up recalls the current session's sent messages from the
saved transcript. Up/Down move through multiline text first, including wrapped
lines, and browse older/newer messages at the first/last visual line. Down past
the newest message restores the empty composer. Editing recalled text exits
history browsing; sending it creates a new message. Drafts, pending sends, and
uncertain retries are not replaced by history navigation.

Streaming follows the latest message while the reader is at the bottom. Scrolling
up stops that behavior; **Jump to latest** resumes it. Permission and question
controls remain usable even while a prompt is waiting for acknowledgment.

For UI iteration, use `npm run dev:ui`. It keeps app state in the gitignored
`.clave-ui-dev/` directory in this checkout. The normal `npm run dev` still uses
the default app profile and can restore installed-app sessions.

This is app-profile isolation, not an agent sandbox. Provider logins still come
from the machine, and terminal tmux mode still uses the machine's `clave` socket.
Turn off tmux mode in the separate profile before experimenting with plain
terminal tabs. The Electron UX checks use fake providers instead of live agents.

## Launch profiles and migration

Settings → Agents owns the executable and additional arguments for every
conversation provider, including OpenCode and installed runtime providers.
Selection follows explicit profile → workspace default → global default →
provider default. A new conversation saves the resolved profile ID. A missing
explicit profile fails instead of silently choosing another command. Editing
a profile does not change an already-connected process; the next process
start resolves the saved profile again.

Claude inherits `permissions.defaultMode` from its native settings, such as
`auto`, unless the trusted launch profile explicitly supplies `--permission-mode`.
Clave does not force manual/default mode. The separate dangerous option still
requests permission bypass. Profile command wrappers such as
`env -u ANTHROPIC_API_KEY claude` are preserved.

Saved legacy Claude, Codex, and Pi tabs retain their sidebar position and
attached preview while waiting for migration. Opening the tab does not start,
attach, or stop its agent. Choose a launch profile and select **Move to
conversation**. A native confirmation explains that migration will stop the
old process. Cancelling leaves it and its record untouched.

Migration saves a prepared conversation before stopping the exact owned
process. It then remaps the layout and attached-view owner and marks the import
complete. An interrupted migration can be retried without creating another
conversation. Prepared imports cannot send prompts.

The first explicit message starts the selected profile with the recorded
native resume ID, when one exists. Without an ID, the view warns that context
will start fresh. Native terminal history is not imported into the Clave
transcript, and old prompts are never replayed. Hidden serving terminals and
unsupported agent types retain their existing PTY behavior.

## Restarting an older background service

Quitting the app leaves its conversation service running. Rebuilding the app
therefore does not upgrade that service. An incompatible service is left alone,
and new conversation operations fail with a recovery message.

Matching protocol versions are not enough: the built-in provider revision in a
new launch must match the running service's advertised revision. Clave checks
this before creating a conversation, preparing a migration, or submitting a
message that would start a provider. A mismatch leaves the draft and command ID
unsubmitted. Reading history, closing sessions, and sending to already-connected
providers remain available.

Use **Restart background service** in Settings → Agents or the migration
error view. The native confirmation applies to the selected app profile and
warns that its running conversation work will stop. History and profiles remain
on disk. Restart does not replay prompts or start providers automatically.

Modern services expose an authenticated shutdown operation. For older services,
macOS/Linux recovery verifies the exact executable, daemon path, profile, UID,
and process start identity before signalling that one PID. An unverified owner
or a service launched from a different build path is refused. Windows requires
the shutdown operation. There is no broad process kill or forced escalation.

Restart loads the current build; it does not silently replace old sessions'
pinned provider revisions. If a conversation's built-in revision is no longer
available after a core update, its history stays readable, but continuing work
requires a new conversation with the current provider.

## Ownership

The renderer is a subscriber, not the owner of the provider process.

- Electron main resolves launch profiles, working directories, account
  credentials, and window ownership.
- A detached local service owns provider processes and durable session state.
  Quitting Electron disconnects its client without terminating these processes.
- An adapter translates one provider's protocol into Clave messages, tool
  activity, requests, and lifecycle events.
- The renderer uses the same commands and event projection for every provider.

The public IPC accepts conversation operations, not executables or environment
variables. Main resolves those from existing trusted settings. Environment
variables and account tokens cross the authenticated local connection but are
not saved in conversation records or returned to the renderer.

Before creating a headless session, Clave requires workspace trust using the
existing trusted-root registry. An untrusted folder gets an explicit confirmation:
provider startup hooks and plugins can run before tool-approval requests exist.
Cancelling creates no provider session. Explicitly trusted workspace roots do not
prompt again.

The service uses a private authenticated Unix socket on macOS/Linux and a
named pipe on Windows. Service data lives under
`<userData>/conversation-service/`. Provider session files live under
`<userData>/conversations/providers/` where supported. Provider-owned history
may also remain in the provider's native storage.

A kernel-held loopback port elects the service owner, so stale PID files cannot
block recovery or cause two services to take the same socket. That port accepts
no commands. A collision with another local listener fails explicitly; it never
replaces that listener.

## Lifecycle

Creating a session saves its identity and options. The provider process starts
on the first message. Closing the view does not close the session. Explicitly
closing the tab disposes its provider process and closes the session.

Reopening Clave reattaches to the service and reads a snapshot. It does not send
the previous prompt again. If the service itself dies or the machine reboots,
records reopen as stopped, with pending permission requests cancelled. A later
explicit send starts the provider with its saved conversation ID when supported.
This resumes provider context; it does not resurrect a process.

Each accepted send has a durable command ID. Retrying the same command ID does
not execute it twice. A disconnect after submission can leave its outcome
unknown. Neither transport reconnection nor daemon recovery automatically
replays it.

The event sequence is per Clave session. A view subscribes before reading its
snapshot, buffers concurrent events, and discards events already represented by
that snapshot. Sequence gaps trigger a fresh snapshot.

Moving a tab between windows changes its home metadata and transfers the view.
It does not restart the agent. Closing a non-last window hands its conversations
and group layout to the primary window.

Text deltas batch for up to 40 ms. Non-text events, snapshots, and accepted
commands flush immediately. An abrupt service kill can lose the last unflushed
text batch, but does not cause accepted commands to replay.

The current view retains the whole Clave transcript up to a 4 MiB UTF-8 snapshot
limit. At capacity, the session stops with an explicit error and preserves its
existing history; it never silently deletes earlier messages. Continuing requires
a new session. History pagination is not implemented. Individual prompts have a
128 KiB service limit, and at most 1,000 sessions may remain open. Closed records
are archived and do not count toward that active-session limit.

## Provider protocols

| Provider | Interface                                                                                     |
| -------- | --------------------------------------------------------------------------------------------- |
| Claude   | Installed Claude CLI with stream-JSON input/output and control messages. No Claude Agent SDK. |
| Codex    | Installed `codex app-server` over stdio.                                                      |
| OpenCode | A Clave-owned `opencode serve` instance on authenticated loopback HTTP with SSE.              |
| Pi       | Installed `pi --mode rpc` over JSONL stdio.                                                   |

See `src/main/conversations/adapters/README.md` for tested versions, supported
requests, and protocol-specific limitations. An adapter must reject unsupported
actionable requests, not silently approve them or leave the user waiting.

The view is shared; provider capabilities are not necessarily identical.
In particular, Pi's RPC mode does not provide the same tool permission-review
contract as Claude, Codex, and OpenCode. Its limitation is displayed in the view.
Do not describe that as Clave granting permission for each tool call.

The existing Claude account selection supplies the CLI's environment. No SDK
dependency or new Claude login flow is introduced.

## Compatibility boundaries

- Migration does not convert a running tmux process into a protocol process.
  It stops that process after confirmation and resumes its recorded native
  context in a new process on the next explicit message.
- OpenCode is a direct launcher option. The current `.clave` format has no
  OpenCode agent field. Pinning or exporting an OpenCode session is explicitly
  rejected instead of silently writing a plain terminal.
- Changing providers creates a separate session. Clave does not claim that
  another provider can inherit the original agent's internal context.
- The in-app MCP server still belongs to Electron. Agents can keep working
  while Clave is closed, but Clave-specific MCP tools need the app running.
  Per-session MCP credentials survive restarts without rotation.
- Windows named-pipe and packaged-app behavior require platform verification;
  macOS development verification is not evidence for those environments.

## Verification contract

The change is checked at three levels:

1. Pure tests cover projection ordering, duplicate commands, credential
   separation, permission validation, recovery, and provider protocol fixtures.
2. Real Electron tests with fake providers cover the complete IPC/service/view
   path without model calls. Quitting and reopening the app must retain the
   same provider process and transcript.
3. Installed CLI smoke tests use isolated configuration and perform version and
   initialization handshakes only. They do not prove billable model execution.

Provider upgrades need adapter contract tests and a handshake smoke test against
the new version. Fixtures reduce maintenance scope; they do not make upstream
protocol changes automatically compatible.

Migration checks include `npm test -- migration restart`,
`npm run test:e2e -- session-migration`, and
`npm run test:e2e -- provider-launch-profiles`. The service
migration fixture uses a local fake CLI and inspects its actual argv and resume
ID. It never calls a live model or stops a user's daemon.
