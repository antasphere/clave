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
