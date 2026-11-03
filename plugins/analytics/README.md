# Analytics (`clave.analytics`)

A bundled plugin that measures the Claude Code sessions Clave shows: what each one cost at list prices, how long it was active, the tokens it read and wrote, its tool calls and prompts, per session, per group and per workspace.

The data comes from the transcripts on disk. A Claude tab (`claude`, `claude-agents`) with a provider session id reads `~/.claude/projects/<slug>/<id>.jsonl`, where the slug is the cwd with every character that is not a letter or a digit replaced by `-`. Its subagents read `<id>/subagents/agent-<n>.jsonl` with their `.meta.json` beside them. Files are read incrementally, from a byte offset. One streamed assistant message is written once per content block, and each row repeats the same `usage`, so usage is counted once per message id. Tool calls are counted by distinct `tool_use` id. `<synthetic>` rows count nothing. A prompt is a user row a person typed (no tool result, no harness injection, no sidechain).

The data folder (`CLAVE_PLUGIN_DATA_DIR`, else `clave-analytics` under the temp folder) holds `ledger.json` (one row per session with its tallies, file cursors and state spans), `server.json` (port and URL token) and, optionally, `prices.json`, an override of the shipped `prices.json` (USD per million tokens). Models without a price are reported as unpriced and never guessed.

The server listens on 127.0.0.1 only. Every route sits under `/<token>/`: `session/<id>`, `group/<id>` and `workspace?ws=<id>` (pages, with `range=today|7d|30d|all` and `theme=`), `data/session/<id>.json`, `data/group/<id>.json` and `data/workspace.json` (the same views as JSON), `events?scope=...` (server-sent `data` events on every change) and `assets/deck.css|deck.js`. Anything else answers an empty 404. The `deck` action (session, group) and the `home` action (workspace) answer those page URLs, and `deck` also answers a six-row preview.

The pages are built by `scripts/build-plugins.mjs`: `src/main.ts` → `main.mjs`, `page/deck.ts` → `dist/deck.js`, and `dist/deck.css` = embedded Geist Sans + `packages/ui/src/tokens.css` + `page/deck.css`. `electron-vite dev` and `build` run it, and so does `npm run plugins:build`. The outputs are git-ignored.

Tests: `npx vitest run plugins/analytics`; types: `npm run typecheck:plugins`.
