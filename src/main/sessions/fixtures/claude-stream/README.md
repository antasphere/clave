# Claude Code 2.1.278 protocol fixtures

Recorded by hand on 2026-09-19. Local username is replaced with REDACTED; the
no-tools conversation id is replaced with a fixed UUID. Other correlation IDs
are inert transcript identifiers. No credentials are present.

`real-turn.ndjson`: stdin was one line:
`{"type":"user","message":{"role":"user","content":"Reply with exactly CLAVE_OK."}}`

Command (from `/tmp`, with CLAUDECODE removed from the environment):

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --tools '' --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

11 frames, successful result `CLAVE_OK`, exit 0. No tools used.

`permission-turn.ndjson`: same command, with `--tools Write` and
`--permission-prompt-tool stdio`. Prompt: "Use Write to create
/tmp/clave-2535-permission-probe.txt containing CLAVE_OK. If denied, stop."
Stdin remained open; the control request was answered with:

```
{"type":"control_response","response":{"subtype":"success","request_id":"<request_id from stdout>","response":{"behavior":"deny","message":"Denied by user"}}}
```

41 frames, one permission request, correlated denied tool result and final
result. No file was written. A preliminary run with only permission-prompts host
denied automatically without a control request, which caught the missing flag.
The E2E stub replays this transcript, pausing at the real control request until
it receives the renderer's response. All automated tests are offline.

Control protocol reference checked against Anthropic's SDK:
https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py
and `_configure_can_use_tool` in `src/claude_agent_sdk/types.py`.

## `background-bash.ndjson` (2026-10-14)

Captured from the installed CLI (`claude -p --input-format stream-json
--output-format stream-json --verbose --include-partial-messages --model haiku
--tools Bash --allowedTools Bash --setting-sources '' --strict-mcp-config
--mcp-config '{"mcpServers":{}}'`, from an empty `/tmp` folder, with stdin held
open 25 s after the result). Prompt: run `sleep 10 && echo bgc` with Bash's
`run_in_background`, then `echo fgc` normally, then reply `ok`. The home and
project paths are replaced with `REDACTED`, and the `rate_limit_event` frames
(account quota) are dropped; 63 frames remain.

The order the chat's Bash cards rely on:

1. the background call's `tool_use` (`run_in_background: true`), then the
   waited-on call's `tool_use`;
2. 1.6 s later, `system` `background_tasks_changed` naming the task
   (`task_type: local_bash`) and `task_started` (`is_backgrounded: true`,
   `tool_use_id` of the call);
3. the background call's `tool_result` ("Command running in background with
   ID: …"), then the waited-on call's result `fgc`, the answer and `result`;
4. 9 s after the result, `task_updated` (`completed`), `task_notification`
   and `background_tasks_changed` with an empty list, followed by the CLI's
   own turn about the finished command.

The list in step 2 names the task before `task_started` gives its call id.
Published as it stands, it would carry a task with no `toolUseId`, which the
Terminal view would draw as a second card beside the call's own until the
link arrives. The translator therefore holds a list that names an unlinked
task until the end of the read it came in: the `task_started` that links
it, any later event a view reads, or the read's end publishes it. A list
whose `task_started` arrives in a later read still publishes unlinked at the
end of its own read; that duplicate is transient (one snapshot) and the
next snapshot settles to one card. A call asking for `run_in_background`
whose result is an error before any list names it is cleared; once listed,
the list alone ends it. If the CLI never sends `task_started`, a
backgrounding call's card stays until the turn ends.

The list names a task by the Bash call's `description` when the model gave
one (this Haiku capture has none, so it reads as the command; Opus usually
writes one). A command's card keeps the command text it opened with through
its promotion; only a task with no card of its own reads as the list names
it. The Electron replay (`claude-chat-bash-tasks.spec.mjs`) gives the
background call a prose `description` explicitly, to hold that. A waited-on
Bash call's foreground `task_started` names its `tool_use_id` too; the
translator keeps that link, unlisted, so a list that later names the task
(the command moved to the background) links it to its call, and forgets it
at the task's end, at the turn's `result` and at the CLI's exit. No capture
shows a command moved to the background mid-run; that path is covered by
unit tests on the synthetic sequence.

The `claude/bash-tasks` scenario uses `@structure-ai/fixtures`: a recording
process stands in for the spawned CLI and answers the session's own message
with this capture, up to the first `result`, and the rest on the scenario's
second command, through the real Claude adapter and `SessionManager`. Its
input is `{}` and its target is the test's isolated manager; nothing is
written to disk. Load and verify it with:

```sh
npx vitest run src/main/sessions/adapters/claude-bash-tasks.fixtures.test.ts
```

After `npm run build`, the Electron check is
`npm run test:e2e -- claude-chat-bash-tasks`.
