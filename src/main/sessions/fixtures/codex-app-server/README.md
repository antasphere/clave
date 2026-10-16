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

## Resumed chat history

`codex-history.test.ts` covers the rollout formats used by resumed chats: older
`response_item` messages and tools, and the newer `event_msg/item_completed`
items. The latter use `UserMessage`, `AgentMessage`, `CommandExecution` and
`FileChange`. Agent text blocks use `Text`; user text blocks use `text`.
These shapes were checked against a local Codex rollout on 2026-10-12. Tests use
synthetic content; no user transcript is checked in.

The `codex/resumed-chat` scenario uses `@structure-ai/fixtures`. A recording
provider writes a rollout after a message sent through `SessionManager.write`.
The scenario then closes and resumes the conversation through the session
manager and checks its history query. Its input is `{}` and its target is the
test's isolated manager and temporary Codex home. No external provider runs.

Load and verify it with:

```sh
npx vitest run src/main/sessions/adapters/codex-history.fixtures.test.ts
```

The test prints its run ID, session IDs and temporary directory. It releases
the sessions and retains the rollout for inspection. To clean up a run,
remove only the printed `clave-codex-fixture-<run-id>` directory.

After `npm run build`, the Electron check is:

```sh
npm run test:e2e -- codex-chat-tab-restore
```

It quits and relaunches the app, restores a hidden workspace, checks the saved
answer in the chat before sending anything, then verifies that a new answer
appears without duplicating the saved one. It counts provider requests from
the relaunch, including startup triggered by the view or model picker.
Historical images are represented by `[Image]`; their binary content is not
sent through the history endpoint.

## Subagents and background commands (0.162.1)

`agent-tasks.ndjson` and `agent-tasks-interrupt.ndjson` are selected, redacted
captures from the installed CLI on 2026-10-14 (`codex-cli 0.162.1`), over the
same `initialize` the adapter sends (no `experimentalApi`), with
`thread/start` on `workspace-write` and `never`. Thread and turn IDs are
renamed (`thread-parent`, `thread-child`, `turn-parent`, `turn-child`), the
home and working directories replaced, and the hook, account, remote-control
and MCP-startup frames dropped. Each row also carries `at`, the milliseconds
since the connection opened. The protocol types were generated with
`codex app-server generate-ts`.

- `agent-tasks.ndjson`: one turn asked to spawn a subagent that runs
  `sleep 20`, start `sleep 30 && echo bg2` without waiting, run `echo fg`, and
  answer. The subagent is a `subAgentActivity` item (`kind: started`, with
  `agentThreadId`, `agentPath` and the resolved `model`), sent as both
  `item/started` and `item/completed`; the child thread's own frames carry its
  `threadId`. Every command is `source: unifiedExecStartup`, the foreground
  one included: nothing marks a command as left running mid-turn. The parent's
  `turn/completed` arrives while the background command is still `inProgress`;
  its `item/completed` comes 17 s later, and the subagent's
  `subAgentActivity` `kind: completed` 21 s after the turn.
- `agent-tasks-interrupt.ndjson`: a background `sleep 40` and a foreground
  `sleep 30`, then `turn/interrupt` three seconds into the second. The turn
  completes `interrupted` with both still running; the foreground command's
  `item/completed` follows 27 s later (the capture ends before the other's).

- `agent-tasks-followup.ndjson`: a subagent spawned and waited on, then given
  a follow-up (`sleep 6`, then a reply) that it runs past the parent's turn.
  The follow-up is `subAgentActivity` `kind: interacted` with `model: null`,
  then the child thread's own `turn/started`; its end is a second
  `kind: completed`. This one was captured with `experimentalApi` on; its
  `thread/backgroundTerminals/list` frames and the capability are removed,
  and nothing it keeps depends on them.

`thread/backgroundTerminals/list` answers `-32600` ("requires experimentalApi
capability") on the adapter's connection, and with the capability it lists
every live process, commands the turn is still waiting on included (a probe
on 2026-10-14 saw `sleep 4` and `sleep 15` there while their calls waited).
It cannot tell a command left running from a waited-on one, so the adapter
does not use it. The Terminal view instead shows every running Codex command
from its `commandExecution` call to its result, as running work; the adapter
lists one as background work only once the turn completes without it (the
tab's background count reads that list alone). The v1
`collabAgentToolCall` item and `thread/closed` are covered by schema-derived
synthetic cases in `codex-agent-tasks.test.ts`, not by a capture.

The `codex/agent-tasks` scenario uses `@structure-ai/fixtures`: a recording
provider replays `agent-tasks.ndjson` into a real `CodexAdapter` through
`SessionManager`, up to the turn's end on the message, and the rest on the
scenario's second command. Its input is `{}` and its target is the test's
isolated manager. Load and verify it with:

```sh
npx vitest run src/main/sessions/adapters/codex-agent-tasks.fixtures.test.ts
```

It prints its run ID and session ID and keeps only its temporary
`clave-codex-agent-tasks-<run-id>` folder; remove that folder to clean up.
After `npm run build`, the Electron check is
`npm run test:e2e -- codex-chat-agent-tasks`.

## Runtime retained across CLI upgrades

`codex/runtime-survives-upgrade` loads fresh and resumed chats through
`SessionManager` and `CodexAdapter`, using a local standalone-provider fixture.
It removes the original installation while both app-servers run, then executes
their real helper processes directly and through a child. It makes no provider
requests and uses no existing Clave data. Load its empty input and verify with:

```sh
npx vitest run src/main/sessions/adapters/codex-runtime.fixtures.test.ts
```

The receipt prints the run ID, session IDs and isolated target directory,
`clave-codex-upgrade-fixture-<run-id>`. The manager closes its sessions and revokes
their credentials. Remove that one directory to clean up the retained receipt.
`codex-runtime.test.ts` also covers replacement versions, shared runtime leases,
profile/account bindings, symlinked resources, legacy helper pairs and incomplete
packages. These are synthetic installer fixtures, not live Codex recordings.

POSIX direct Codex and `env`-wrapped commands retain a standalone package or a
legacy native executable/helper pair before starting the app-server. Copies run
outside Electron main and share a private directory until the last app-server
exits. A standalone package's metadata and relative executable path are retained
intact, so an unfamiliar self-contained layout can keep using its own metadata.
The current known layout is checked for incomplete resources before startup.
Filesystem clones are used where available. Windows, arbitrary wrapper
executables and npm launchers without this standalone layout keep their existing
launch behavior. A process crash can leave its private temporary directory until
the operating system cleans temporary storage. Existing processes started before
this change require a chat restart to acquire a retained runtime.
