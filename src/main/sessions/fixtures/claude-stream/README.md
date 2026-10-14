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
