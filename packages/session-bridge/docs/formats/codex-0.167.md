# How Codex 0.167 stores a thread

Discovered on 9 November 2026 on a Mac running `codex-cli 0.167.0`, from the files
under `~/.codex`, the CLI's own help, the app-server protocol (`codex app-server
generate-ts`), the Codex source at tag `rust-v0.167.0`
(`codex-rs/protocol/src/items.rs`, `protocol.rs`, `models.rs`), and five resumes
of written files through the real CLI on throwaway homes. The writer in
`src/writers/codex.ts` is pinned to this (`SUPPORTED.codex = ['0.167.x']`).

## The one file that is the thread

A thread is one **rollout** file, one JSON object per line:

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread id>.jsonl
```

The day folder and the stamp are the machine's **local** time of the thread's
start; the id is a UUIDv7 (`uuid::Uuid::now_v7()` in the source), so threads sort
by time. Every row is `{ "timestamp": <ISO 8601, UTC>, "ordinal": <n>, "type":
<row type>, "payload": {...} }`; `ordinal` counts from 0 and exists since the
paginated history (below). Older files (a 0.145 file on this machine) have no
`ordinal`.

Row types seen, in the order a one-turn thread writes them:

| `type`                                        | `payload.type`                           | What it is                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_meta`                                |                                          | the thread: `id`, `session_id` (equal for a root thread), `timestamp`, `cwd`, `runtime_workspace_roots`, `originator`, `cli_version`, `source` (`cli`, `vscode`, `exec`, …), `model_provider`, `base_instructions` (the system prompt, optional), `history_mode` (`legacy` or `paginated`), `context_window`, and a `git` block beside the meta (`commit_hash`, `branch`, `repository_url`) |
| `event_msg`                                   | `task_started`                           | a turn begins: `turn_id`, `root_turn_id`, `started_at` (seconds), `model_context_window`, `collaboration_mode_kind`                                                                                                                                                                                                                                                                         |
| `response_item`                               | `additional_tools`                       | the tool declarations handed to the model (developer role)                                                                                                                                                                                                                                                                                                                                  |
| `response_item`                               | `message` (`developer`)                  | the instruction blocks: base instructions, skills, permissions, apps, plugins, multi-agent hints                                                                                                                                                                                                                                                                                            |
| `response_item`                               | `message` (`user`)                       | the injected `# AGENTS.md instructions …` and `<environment_context>` blocks, then the person's own message                                                                                                                                                                                                                                                                                 |
| `world_state`                                 |                                          | a snapshot of what the model was shown (hashes and texts)                                                                                                                                                                                                                                                                                                                                   |
| `turn_context`                                |                                          | the turn's settings: `turn_id`, `cwd`, `approval_policy`, `approvals_reviewer`, `sandbox_policy`, `permission_profile`, `model`, `effort`, `collaboration_mode`, …                                                                                                                                                                                                                          |
| `event_msg`                                   | `thread_settings_applied`                | the same settings as the UI received them                                                                                                                                                                                                                                                                                                                                                   |
| `event_msg`                                   | `item_completed`                         | one **item** the person sees (below)                                                                                                                                                                                                                                                                                                                                                        |
| `response_item`                               | `message` (`assistant`)                  | what the model said, `content: [{type: "output_text", text}]`, `phase`                                                                                                                                                                                                                                                                                                                      |
| `response_item`                               | `function_call` / `function_call_output` | a tool the model called and what it got back (`call_id` pairs them; `arguments` is a JSON **string**; `output` a string or content items)                                                                                                                                                                                                                                                   |
| `response_item`                               | `reasoning`                              | the model's encrypted reasoning                                                                                                                                                                                                                                                                                                                                                             |
| `token_usage_record`, `event_msg token_count` |                                          | the usage after a response                                                                                                                                                                                                                                                                                                                                                                  |
| `event_msg`                                   | `task_complete` / `turn_aborted`         | the turn ends (`last_agent_message`, `started_at`, `completed_at`, `duration_ms`; `reason: "interrupted"` on an abort)                                                                                                                                                                                                                                                                      |

Two tapes live in the same file:

- **`response_item` rows are what the model sees again** on resume: Codex rebuilds
  the model's history from them (`ResponseItem` in `models.rs`). Every
  `function_call` must have its `function_call_output` under the same `call_id`.
- **`event_msg item_completed` rows are what the person sees**: the `TurnItem`
  enum of `items.rs`, serialised with a PascalCase `type` and snake_case fields.
  The app-server returns them camelCase (`userMessage`, `commandExecution`, …)
  after projecting them.

## The two SQLite stores are Codex's own caches

Beside `sessions/` sit `state_5.sqlite` (table `threads`: one row per thread with
`rollout_path`, `history_mode`, `cli_version`, `model`, `cwd`, `first_user_message`,
…) and `thread_history_1.sqlite` (tables `thread_turns`, `thread_items` with the
item as camelCase JSON, `thread_history_projection_state` with the next rollout
byte offset and ordinal). `codex migrate-rollouts` reports which files are
`eligible` (legacy) or `already_paginated`; `--apply` would migrate the legacy ones.

**Neither store needs to be written.** On a fresh `CODEX_HOME` holding only
`sessions/2026/11/09/<the real rollout>`, with no `auth.json` and no database,
`codex app-server`'s `thread/list` found the thread and `thread/resume` returned
its turn with both items, after Codex created both databases itself (the
`thread/list` protocol doc says so too: it scans the JSONL rollouts to repair
thread metadata unless `useStateDbOnly` is set). The writer therefore writes the
file and nothing else.

## What a written file must carry to hydrate

Found by resuming synthetic files through `thread/resume` (the probe is
`src/writers/codex.resume.test.ts`):

- `history_mode: "paginated"` with an `ordinal` on every row. A `legacy` file
  written the same way resumed with its turn but **no items** on 0.167.
- `session_meta` with `id`, `session_id`, `timestamp`, `cwd`, `originator`,
  `cli_version`, `source`, `model_provider`; `base_instructions` may be absent (it
  is an `Option`), and Codex injects its own instructions and environment on
  resume, so the writer adds none.
- One `task_started`, one `turn_context` (`cwd`, `approval_policy`,
  `sandbox_policy`, `model` are required fields), the items, then `task_complete`
  or `turn_aborted` per turn.
- Items as `items.rs` serialises them:
  - `UserMessage`: `{ "type": "UserMessage", "id", "content": [{ "type": "text", "text", "text_elements": [] }] }`
  - `AgentMessage`: `{ "type": "AgentMessage", "id", "content": [{ "type": "Text", "text" }], "phase": "commentary" | "final_answer" }`
  - `CommandExecution`: `{ "type": "CommandExecution", "id", "command": [<argv>], "cwd": "file:///…", "parsed_cmd": [], "source": "agent", "status": "completed" | "failed" | "declined" | "in_progress", "aggregated_output"?, "exit_code"?, "duration"?: { "secs", "nanos" } }`. `command` is an **array**, `cwd` a **`file://` URI** (`PathUri`): with a plain path the item is dropped silently.
  - `FileChange`: `{ "type": "FileChange", "id", "changes": { "<path>": { "type": "add", "content" } | { "type": "delete", "content" } | { "type": "update", "unified_diff", "move_path": null } }, "status": "completed" | "failed" | "declined" }`
  - `McpToolCall` (camelCase fields): `{ "type": "McpToolCall", "id", "server", "tool", "arguments": {...}, "status": "completed" | "failed" | "inProgress", "result"?: { "content": [{ "type": "text", "text" }] }, "error"?: { "message" } }`
- `item_completed` payload: `{ "type": "item_completed", "thread_id", "turn_id", "item", "started_at_ms"?, "completed_at_ms" }`.

An item Codex cannot deserialise is dropped from the projection without a word:
the resumed turn simply lacks it. That silence is why the writer is pinned to a
version and proven by a real resume rather than by its own rows.

## A real sample, redacted

`fixtures/codex-rollout-0.167-hello.jsonl` is the real file of a one-turn thread
("Hello", answered) written by codex-cli 0.167.0 on 9 November 2026 from a Clave
chat tab (`originator: "clave_chat"`). The home path, the ChatGPT user and account
ids, the git commit and remote are replaced, and every long instruction text is cut
to its first characters with the omitted length noted; the row types, keys and
ordinals are untouched. Its rows 0, 1, 9, 11, 12, 13, 14 and 17 are the shape the
writer produces; rows 2 to 8 and 10 (tools, instructions, world state, settings)
are Codex's own and are not written.

```json
{"timestamp": "2026-11-09T16:49:34.427Z", "ordinal": 0, "type": "session_meta", "payload": {"creator_user_id": "user-REDACTED", "creator_account_id": "00000000-0000-0000-0000-000000000000", "session_id": "01a1c137-0bc0-7813-80a4-0e81f6fb05c6", "id": "01a1c137-0bc0-7813-80a4-0e81f6fb05c6", "timestamp": "2026-11-09T16:49:32.700Z", "cwd": "/Users/example/.antasphere", "runtime_workspace_roots": ["/Users/example/.antasphere"], "originator": "clave_chat", "cli_version": "0.167.0", "source": "vscode", "model_provider": "openai", "base_instructions": {"text": "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job… (17730 characters omitted)", "provenance": {"type": "model", "model": "gpt-5.6-sol"}}, "history_mode": "paginated", "context_window": {"window_id": "01a1c137-0bd4-7d01-9973-23939d50b952"}, "git": {"commit_hash": "0000000000000000000000000000000000000000", "branch": "main", "repository_url": "git@github.com:example/workspace.git"}}}
{"timestamp": "2026-11-09T16:49:34.430Z", "ordinal": 1, "type": "event_msg", "payload": {"type": "task_started", "turn_attribution": {"turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "turn_trigger": null, "parent_turn_id": null, "initiating_agent_path": null, "root_turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f"}, "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "root_turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "started_at": 1794242974, "model_context_window": 258400, "collaboration_mode_kind": "default"}}
{"timestamp": "2026-11-09T16:49:35.020Z", "ordinal": 9, "type": "turn_context", "payload": {"turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "root_turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "disabled_plugin_ids": [], "cwd": "/Users/example/.antasphere", "approval_policy": "on-request", "approvals_reviewer": "user", "sandbox_policy": {"type": "read-only"}, "permission_profile": {"type": "managed", "file_system": {"type": "restricted", "entries": [{"path": {"type": "special", "value": {"kind": "root"}}, "access": "read"}]}, "network": "restricted"}, "active_permission_profile": {"id": ":read-only"}, "model": "gpt-5.6-sol", "comp_hash": "3000", "collaboration_mode": {"mode": "default", "settings": {"model": "gpt-5.6-sol", "reasoning_effort": "xhigh", "developer_instructions": null}}, "multi_agent_version": "v2", "realtime_active": false, "effort": "xhigh", "summary": "none"}}
{"timestamp": "2026-11-09T16:49:35.045Z", "ordinal": 11, "type": "response_item", "payload": {"type": "message", "id": "msg_01a1c137-1543-7720-9a0c-85cd0a7502e5", "role": "user", "content": [{"type": "input_text", "text": "Hello"}], "internal_chat_message_metadata_passthrough": {"turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "create_time": 1794242975.043144, "content_item_kinds": ["user.text"], "content_item_metadata": [{"provenance": {"type": "user"}}]}}, "metadata": {"retained_source": {"id": {"message_id": "msg_01a1c137-1543-7720-9a0c-85cd0a7502e5", "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "role": "user"}, "revision": "retained_01a1c137-1544-7743-9304-f70602aab014", "complete": true}, "client_authored": false, "user_input_order": 0, "mcp_attribution": {"status": "none"}}}
{"timestamp": "2026-11-09T16:49:35.048Z", "ordinal": 12, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": "01a1c137-0bc0-7813-80a4-0e81f6fb05c6", "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "item": {"type": "UserMessage", "id": "01a1c137-1543-7720-9a0c-85dc1ff93876", "content": [{"type": "text", "text": "Hello", "text_elements": []}]}, "started_at_ms": 1794242975048, "completed_at_ms": 1794242975048}}
{"timestamp": "2026-11-09T16:49:36.958Z", "ordinal": 13, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": "01a1c137-0bc0-7813-80a4-0e81f6fb05c6", "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "item": {"type": "AgentMessage", "id": "msg_0d9d34779afa20ff016af1f9a0b20c87d2a4489cf4f17b4ab3", "content": [{"type": "Text", "text": "Hello! What are we working on today?"}], "phase": "final_answer"}, "started_at_ms": 1794242976639, "completed_at_ms": 1794242976958}}
{"timestamp": "2026-11-09T16:49:36.962Z", "ordinal": 14, "type": "response_item", "payload": {"type": "message", "status": "completed", "id": "msg_0d9d34779afa20ff016af1f9a0b20c87d2a4489cf4f17b4ab3", "role": "assistant", "content": [{"type": "output_text", "text": "Hello! What are we working on today?", "annotations": [], "logprobs": []}], "phase": "final_answer", "internal_chat_message_metadata_passthrough": {"turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "create_time": 1794242976.7008376, "content_item_kinds": ["unknown"]}}, "metadata": {"retained_source": {"id": {"message_id": "msg_0d9d34779afa20ff016af1f9a0b20c87d2a4489cf4f17b4ab3", "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "role": "assistant"}, "revision": "retained_01a1c137-1cc2-7e30-a46e-1d0e10a145a4", "complete": true}, "client_authored": false, "user_input_order": 1}}
{"timestamp": "2026-11-09T16:49:37.040Z", "ordinal": 17, "type": "event_msg", "payload": {"type": "task_complete", "root_turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "turn_id": "01a1c137-127e-7803-9d29-03dabf8fb43f", "last_agent_message": "Hello! What are we working on today?", "started_at": 1794242974, "completed_at": 1794242977, "duration_ms": 2689, "time_to_first_token_ms": 2287}}
```

A tool call in the model tape (from a 0.145 file on the same machine, redacted; the
shape is the Responses API's and unchanged in 0.167):

```json
{"type": "response_item", "payload": {"type": "function_call", "id": "fc_…", "name": "update_plan", "arguments": "{\"plan\":[…]}", "call_id": "call_1J9B…"}}
{"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call_1J9B…", "output": "Plan updated"}}
```

## How a thread is opened again

- `codex resume <thread id>` in the TUI (the picker filters by cwd; `--all` lifts it).
- `codex app-server` over stdio: `initialize`, `initialized`, then `thread/resume
{ threadId, cwd? }`, which answers the thread with its `turns[].items` (a
  deprecation notice says to prefer `excludeTurns: true` and `thread/turns/list` +
  `thread/items/list` for paginated threads; the hydrated answer still comes).
  `thread/read { threadId, includeTurns: true }` reads without resuming.
- Resuming needs no credential: the five probes ran on homes with no `auth.json`.
  Sending a turn does.

## What is not written, and why

- No `base_instructions`, no developer `message` rows, no `additional_tools`, no
  `world_state`, no `# AGENTS.md` or `<environment_context>` user rows: Codex
  injects its own on resume, and a fabricated one would be the file's one lie.
- No `reasoning` rows: Claude's thinking is signed for Claude; Codex's reasoning
  is encrypted for Codex.
- No `token_count`: the source's usage is another provider's accounting.
- No SQLite rows: Codex owns and rebuilds them.

## What could not be checked offline

What the model does with a `function_call` whose `name` is a Claude tool (`Bash`,
`Read`, `mcp__…`) rather than one of Codex's. Codex replays its own history across
its tool renames (0.145 files name `update_plan` and `exec`; 0.167's tools differ),
so a name outside the current tool set is expected to be accepted as history; the
header on the first message says where the calls came from. Checking it means a
paid turn on a converted thread, which the lane did not spend.
