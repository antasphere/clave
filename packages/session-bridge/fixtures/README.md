# Fixtures

- `codex-rollout-0.167-hello.jsonl`: a REAL rollout written by codex-cli 0.167.0 on
  9 November 2026 (one turn: "Hello" and the answer), redacted: the home path, the
  ChatGPT user and account ids, the git commit and remote are replaced, and every
  instruction text (base instructions, skills, AGENTS.md, the tool declarations, the
  world state's bodies) is cut to its first characters with the omitted length noted.
  The row types, keys and ordinals are untouched; `docs/formats/codex-0.167.md` reads it.
- `claude-transcript-sample.jsonl`: a SYNTHETIC Claude Code transcript in the shapes of
  a 2.1.319 transcript (checked on 9 November 2026): a prompt as a string, assistant
  rows with `thinking`, `text` and `tool_use` blocks, tool results as string and as
  blocks, a `Write`, a `Read`, a slash command in the CLI's markup, an interruption
  notice, an `isMeta` row, an `isSidechain` row and two bookkeeping rows. No real
  content.
- `claude-stream-*.ndjson`: copies of Clave's Claude Code 2.1.278 stream-json captures
  (`src/main/sessions/fixtures/claude-stream/`, recorded 2026-09-19 and 2026-10-14,
  usernames redacted there): the CLI's stdout frames, whose `user` and `assistant`
  frames the transcript reader also understands.

No fixture holds a credential: Codex's `auth.json` and every token stay out of this
package, its fixtures and its docs.
