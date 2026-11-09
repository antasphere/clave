---
name: recover-sessions
description: Rebuilds a lost Clave workspace by finding the user's past Claude Code sessions on disk, mapping them to projects, and reopening them as grouped tabs with their full history. Use when the user has lost their tabs or groups (crash, restart, accidental close) and wants their working sessions back, or when they ask what sessions they had recently.
---

# Recover Sessions

Clave tabs are disposable; the conversations behind them are not. Claude Code writes every session to a local transcript file that survives an app crash, a machine reboot, and Clave's own state being wiped. This skill finds those transcripts, works out what each session was about, and rebuilds the user's groups and tabs with the real conversations restored — not empty tabs.

Use it when the user says any of: *"I lost my sessions"*, *"my computer crashed, get my workspace back"*, *"what was I working on?"*, *"recover what I had"*.

## What the user gets back

Their history, verbatim. Clave reopens a past conversation natively: `clave_open_session` with `resume: <conversation-id>` starts a tab that continues it with its full context (a Claude session id, a Codex thread id or a Pi session id), as a chat with `chat: true`, so a recovered tab picks up exactly where it stopped. What is genuinely lost is only Clave's own arrangement — which group a tab sat in and what it was called — and even that is mostly kept: `clave_history` lists every past conversation with its title, directory, workspace and the groups it sat in.

Before rebuilding anything, check what is still there: since Clave 3.0.0-beta.21 a restart keeps every stopped tab in its group, with its title and a Resume button, so a "lost" tab is often a stopped one. `clave_list` shows the tabs; `clave_resume_session` brings a stopped one back under the same id.

## Where the transcripts live

```
~/.claude/projects/<path-encoded-cwd>/<session-uuid>.jsonl
```

One JSONL file per session; the filename stem IS the session id you resume with. The directory name is the session's working directory with `/` replaced by `-`.

Retention is a **local** setting, `cleanupPeriodDays` in `~/.claude/settings.json` (default 30 days). It is not a server-side policy — nothing is fetched from Anthropic and nothing expires in the cloud. If the user's setting is low and they care about recovery, mention raising it; that is the whole fix.

## Step 1 — Ask what they remember, briefly

Before scanning, get the user's own picture in one short exchange: roughly how many groups, what the big ones were about, and when they were last working. Do not interrogate them. Vague answers are fine and normal ("one group for the mobile app, a big one for the API rewrite, and something about billing") — the scan supplies the precision, their memory supplies the grouping and the names.

If they cannot remember anything, skip straight to the scan and present what you find, newest first.

## Step 2 — List the History, then scan the transcripts

Start with Clave's own History, which is what the History dialog shows:

```
clave_history → { query?, workspace?, provider?, open?, limit? }
```

One row per past conversation, newest first: `conversationId` (what `resume` takes), `title`, `cwd`, `provider`, `model`, `workspaceName`, the `groups` it sat in, `lastActivity`, `transcriptExists`, `resumable`, and `open` when a tab already holds it (`{ sessionId, alive }`: alive means it is running, stopped means `clave_resume_session` brings it back). Filter by `query` (title, tab name or directory) and `workspace`. For a session that the History names, this is all you need to reopen it.

For the deeper read (which repository a long session really worked in, the tasks it named, where it stopped), run the bundled script:

```bash
python3 <skill-dir>/scripts/scan-transcripts.py --since 14
```

Useful flags: `--since DAYS` (default 14), `--min-size KB` (default 50, skips stubs), `--json` for machine-readable output, `--all` to include the one-shot helper sessions it filters out by default.

It is read-only, takes a few seconds over a couple of hundred transcripts, and prints one block per session:

```
=== 3f9c1a7e-…  4.3MB  2026-03-11T10:50 -> 2026-03-11T13:33  (31 msgs)
    cwd: /Users/you/work
    repos: api-server(36), api-client(2)
    tasks: ENG-412, ENG-418, …
    ask: <the first thing the user asked>
    end: <the last substantial thing the assistant said>
    note: <Claude Code's own compaction summaries, when present>
```

If the script is unavailable, the same signals can be extracted by hand from the JSONL — see *Reading a transcript directly* below.

## Step 3 — Interpret the signals

Read the blocks in this order of trust:

1. **`repos`** — the reliable project signal. It is derived from the file paths in the session's tool calls, resolved to the git repo containing them. A session with 36 hits in one repo belongs to that project, whatever the rest of the block suggests.
2. **`ask`** — the user's opening message, which usually names the goal outright.
3. **`end`** — where the session actually stopped: shipped, mid-plan, waiting on approval, or blocked. This is what makes the "worth bringing back?" judgment possible.
4. **`tasks`** — issue ids, ranked by how often they appear. Useful for matching a session to a known piece of work.
5. **`note`** — Claude Code's own summaries of long sessions.

⚠️ **Do not trust `cwd`.** Most sessions are started from a workspace root shared by dozens of unrelated sessions, so it separates almost nothing. Two sessions with identical `cwd` are routinely about completely different projects.

⚠️ **Long sessions drift.** A session that ran for days may have started on one topic and ended on another. When `ask` and `end` disagree, the recent end state is what matters for grouping and for deciding whether to resume it.

## Step 4 — Propose the grouping, then build it

Map sessions to the groups the user described, and say what you are doing as you go. Prefer acting over asking: build the groups and report, rather than presenting a plan and waiting. Ask only where evidence genuinely conflicts with what the user remembers, or where two sessions are plausible candidates for one remembered tab.

Naming that has worked well:

- **Groups** get the user's own words for them, not a name you invent.
- **Tabs** get a short description of the actual work, not the transcript's first line. When a group holds a multi-session arc, order them chronologically and number them (`1 · schema design`, `2 · migration`, `3 · rollout`) so the sequence is legible at a glance.

Then create them:

```
clave_create_group  → { name: "<group name>" }
clave_open_session  → { groupId, resume: "<conversation-id>", chat: true,
                        name: "1 · schema design" }
```

`resume` fills the directory, the provider and the model from the conversation itself; pass `cwd` only when the original directory is gone. `chat: true` opens the chat view; without it the conversation reopens in a terminal tab running the CLI with `--resume`. `dangerous`, `model`, `account` and `profile` combine with it as with any open. A conversation a tab already runs is not started twice: the call answers that tab (`alreadyOpen: true`) and focuses it; a stopped tab that still holds it is resumed in place.

Two mechanics that will bite you otherwise:

⚠️ **Never rebuild a conversation as a terminal running `claude --resume` by hand.** That was the only road before native resume existed, and it is how a lost chat came back as a plain terminal tab carrying the chat's title under a new id (9 November 2026). Use `resume`.

⚠️ **Empty groups get pruned.** Creating several groups and then filling them in a later batch silently loses the empty ones. Always create one group and immediately open a session in it, then move to the next group.

## Step 5 — Report, including what you did not restore

Close with a short account of what came back, and — the part users value most — a triage of everything else that was open, in four buckets:

- **Worth bringing back** — still-open work, with one line on why.
- **Maybe** — dormant or personal threads; let them choose.
- **Done, skip** — shipped and closed cleanly.
- **Closed before the crash but resumable** — sessions that had already ended but hold context worth reopening.

Offer to add any of them. Say plainly which tabs were reopened as chats and which as terminals, so nothing about the setup is a surprise later.

## Edge cases

**A prompt that never reached disk.** A session opened moments before a crash may have only its bootstrap context saved, with the user's real question lost. Resuming it restores a conversation that never heard the question. Say so, ask the user to restate the idea, and pass it as the first prompt so the session starts on the right foot:

```
clave_open_session → { resume: "<conversation-id>", chat: true, prompt: "<the restated request>" }
```

**A transcript that is gone.** If retention wiped it, the conversation is unrecoverable — do not pretend otherwise (`clave_history` says `transcriptExists: false`, and `resume` errors). Offer to start a fresh session seeded with what the user remembers, and mention raising `cleanupPeriodDays`.

**Sessions that are noise.** The `~/.claude/projects/-/` directory holds one-shot helpers Claude Code runs for itself (tab-title and commit-message generation). The script filters them; never offer them as recoverable work.

**Forks and duplicates.** Resumed sessions share a prefix with their parent, so two transcripts can look nearly identical. Prefer the one with the later end timestamp and mention the other exists rather than restoring both.

**Sessions spanning several projects.** Put the tab in the group matching its dominant repo, and note the overlap in the report instead of duplicating the tab.

## Reading a transcript directly

If you need to inspect one session without the script: each line is a JSON object. Lines with `"type": "summary"` carry Claude Code's compaction summaries. Lines with `"type": "user"` hold the user's turns — skip ones whose text starts with `<` or `Caveat:`, or contains `system-reminder`, since those are injected context rather than something the user typed. Lines with `"type": "assistant"` hold `message.content` blocks; `type: "text"` blocks are the visible reply and `type: "tool_use"` blocks carry the file paths that reveal the project. Records with `isSidechain: true` belong to subagents, not the main conversation.

## This skill never

- Modifies, moves, or deletes a transcript. Everything here is read-only; the transcripts are the user's record.
- Prints transcript contents beyond the short excerpts needed to identify a session, or quotes anything sensitive it encounters while scanning.
- Claims a session is recoverable without confirming its transcript exists.
- Silently substitutes a fresh session for a resumed one — if history could not be restored, that is stated.
