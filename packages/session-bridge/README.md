# @clave/session-bridge

Carry a coding-agent conversation from one CLI to another, whole. A model's working
context is the whole tape (what was said, every tool call, every tool result), not
the prose, so a Markdown export is a lossy handoff. This package reads a CLI's own
storage into one intermediate representation and writes another CLI's storage from
it, so the conversation **resumes natively** there: `codex resume <id>` opens a
conversation that started in Claude Code.

Today: readers for **Claude Code** transcripts and **Codex** rollouts, a writer for
**Codex 0.167** threads, proven by resuming the written file through the real
Codex. The Claude writer has its place and its format notes, not its code.

Born in [Clave](https://github.com/antasphere/clave) (the Mac app that runs
coding-agent sessions as tabs) on 9 November 2026, where a tab out of Claude
accounts could not carry its conversation to Codex, and the open-source converters
around were unmaintained and written for a Codex storage the CLI had left behind.
MIT.

## Use

```sh
# a Claude Code conversation by id (looked up under ~/.claude/projects for the cwd), or by transcript path
session-bridge convert --from claude --to codex <session id or transcript.jsonl> [--cwd <dir>]
# then
codex resume <the thread id it printed>

session-bridge inspect <transcript or rollout>       # what the file is, what its tape holds
session-bridge verify <thread id> [--codex-home <dir>] # read it back through the real Codex (a resume once if Codex never loaded it, keeping its cwd)
```

Options of `convert`: `--codex-home <dir>` (default `$CODEX_HOME` or `~/.codex`),
`--cwd <dir>` (resolved to an absolute path; the transcript's own by default),
`--claude-config-dir <dir>`, `--model <codex model>` named in the thread's context (the
home's `config.toml` `model` by default, `gpt-5` last), `--no-header`, `--json`. Exit codes: 0 done, 1 an error, 2 usage, 3 a refusal
(a Codex version outside the pin, a file the readers do not recognise).

The CLI runs the TypeScript source directly on Node 22.6+ (type stripping), no
build step. In the Clave monorepo: `node packages/session-bridge/bin/session-bridge.mjs …`.

```ts
import { readClaude, writeCodex, resumeThread } from '@clave/session-bridge'

const session = readClaude('/Users/me/.claude/projects/-Users-me-app/<id>.jsonl')
const written = await writeCodex(session, { codexHome: '/Users/me/.codex' })
// written.threadId, written.path, written.turns, written.dropped
const thread = await resumeThread(written.threadId, {
  codexHome: '/Users/me/.codex',
  cwd: session.head.cwd
})
```

## What is written

One rollout file, `<codexHome>/sessions/YYYY/MM/DD/rollout-<started>-<thread id>.jsonl`,
in Codex 0.167's paginated history mode, holding both tapes Codex keeps: the
`response_item` rows the model is shown again (the person's messages, the agent's
messages, every tool call paired with its output) and the `event_msg item_completed`
rows the person sees as history. Nothing else: Codex rebuilds its SQLite indexes
from a scan of `sessions/` by itself, which was proven on a fresh home with no
credential. `docs/formats/codex-0.167.md` has the whole story and a redacted real sample.

A tool call made in Claude Code becomes, for the person, the Codex item that matches
the gesture: `Bash` a **command execution**, `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
a **file change**, everything else (`Read`, `Grep`, `Glob`, `Agent`, `WebFetch`, an
`mcp__server__tool`, …) an **MCP tool call** under the server name `claude-code` (or
the MCP server's own), so Codex renders it as history without a tool of its own
matching. For the model, every call stays a `function_call` under its Claude name
(letters, digits, `_` and `-`, 64 characters at most, as the API takes it), paired
with its output, or with a note when the transcript never answered it; a result that
landed after the person's next message is written beside its call. The first message
is prefixed with a header saying the conversation was converted from Claude Code,
with the model and the date of the conversion, so the agent and the reader both know.

Every message of the person is carried, including one that opens with `<` or with
`Caveat:` (Clave's own chat view drops those as injected context; the reader's
`injected: 'drop'` option restores that rule), and an image reads as `[Image]`.
Left out, and counted in `written.dropped`: a subagent's own events (another
thread's), a result whose call was never seen, and events before the first message.
Left out by the reader: a subagent's rows (`isSidechain`) and the CLI's injected
skill and context rows (`isMeta`). Not written at all: instructions, environment,
reasoning, usage (Codex injects its own on resume; the rest is the source's own
accounting).

## Refuses what it has not seen

`writeCodex` runs `codex --version` first and refuses, before touching the disk, a
version outside `SUPPORTED.codex` (`0.167.x` today) with an `UnsupportedVersionError`
naming the version and the pin. A file the readers do not recognise is an
`UnrecognisedTranscriptError`. A relative cwd is refused (Codex cannot restore it).
An existing thread file is never overwritten: the file is written whole beside its
name and linked into place, which refuses an existing target.

## Layout

```
src/ir.ts               the intermediate representation, field by field
src/readers/claude.ts   Claude Code transcripts (a copy of Clave's replay)
src/readers/codex.ts    Codex rollouts (a copy of Clave's history reader)
src/writers/codex.ts    the Codex 0.167 writer
src/writers/claude.ts   the Claude writer's place and notes
src/codex/version.ts    the pin and the version check
src/codex/app-server.ts a small client of `codex app-server` (resume, read back)
src/cli.ts              convert · inspect · verify
docs/formats/           how each CLI stores a conversation, with samples
fixtures/               a redacted real Codex 0.167 rollout, a synthetic Claude transcript, Clave's stream captures
```

## Tests

`npx vitest run packages/session-bridge` from the monorepo root (or `npm test` in
the package). The integration test `src/writers/codex.resume.test.ts` runs the
**real `codex`** when one in the supported range is on `PATH`, on a Codex home of
its own under the system temp dir, never the machine's `~/.codex`; it is skipped
cleanly otherwise.

## Not yet

- The Claude writer (Codex → Claude Code).
- Images and attachments: a message's text is carried, its files are not.
- Codex versions outside 0.167: the pin is the promise.
- The first paid turn on a converted thread is unverified: whether the model's API
  takes the Claude tool names in its history, and whether a long Claude context fits
  Codex's window, can only be seen by spending a turn (`docs/formats/codex-0.167.md`,
  last section).
