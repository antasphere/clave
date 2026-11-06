# ADR 0004: routines

Status: proposed, 2026-11-05 (the design gate of lane `2026-11-05-routines`, PRDCT-4102; amended the same day by Romain's two scope amendments: the scheduler on the server, the report as a Slideless deck, the injected contract skill, the report and discussion toggle; then every launch parameter a tab takes, resolved as `clave_open_session` resolves them, an invalid value failing the run)

## Context

Nothing in Clave runs an agent unattended. Every session is a tab a person opened, or a tab an agent inside such a session opened for it. The workspace cleanup of 5 November 2026 found every drift of the Antasphere workspace by hand (checkouts behind their branch, secrets not pulled, tools out of date, a missing clone), each one silent until someone asked. The ask is a **routine**: a prompt a `.clave` file schedules, that Clave runs by itself in a fresh agent session, whose result shows in the toolbar the way an agent's copy offer does, and that opens into a floating report with the history, run again, and the conversation continued.

What exists and is reused: the `.clave` file and its six-place schema mirror (the toolbar terminals are the model for a declaration with an icon and a colour); the trust boundary that reviews a file nobody trusted; the server (ADR 0003) that owns sessions in-process, as the packaged app's child, or as a daemon with no client attached, with its per-domain pattern (a contract module, the handlers, the API group, the events, the client); the events-transport chat sessions the server starts as children of its own process; the per-session MCP token that binds a tool call to the session that made it, in main's MCP server and in the standalone one; the account pool (ADR 0002); the Slideless deck mechanism of the Analytics plugin (`plugins/analytics/README.md`: deck folders served on the loopback by the CLI's own viewer, nothing leaving the Mac); the bundled native view plugins (`plugins/chat-view` as the model); and the copy-offer indicator with its store pushed to every window.

## Decision

### The declaration: `routines[]` on a group

A routine is declared on a group, beside `terminals`, in any `.clave` file. It renders in the toolbar whatever the group's `toolbar` flag: a routine is a recurring job of the workspace and the toolbar is the one always-visible place; its button sits after the group's terminals, inside the group's divider.

```json
"routines": [{
  "name": "Workspace health",
  "schedule": "30 8 * * 1-5",
  "prompt": "Check this machine against the workspace's desired state and fix what is safe. {{extra}}",
  "params": { "extra": "" },
  "skill": "steward:workspace-health",
  "cwd": ".",
  "agent": "claude",
  "form": "chat",
  "model": "claude-opus-5-5",
  "effort": "high",
  "profile": "Work",
  "account": "any",
  "dangerousMode": true,
  "permissionMode": "default",
  "icon": "shield",
  "color": "teal",
  "catchUp": true,
  "timeoutMinutes": 30,
  "scope": "machine",
  "report": {
    "template": ".clave/routines/workspace-health",
    "schema": ".clave/routines/workspace-health/schema.json",
    "width": 560,
    "height": 640
  }
}]
```

- `name` (required) is the routine's identity: unique within its file, and the key of its history (`<file path>::<name>`). Renaming a routine starts a new history.
- `schedule` (required) is a five-field cron expression evaluated in the server machine's local time: minute, hour, day of month, month, day of week; `*`, lists, ranges, steps, month and weekday names. No `@daily` aliases, no seconds field.
- `prompt` (required) is the routine's job, after `{{name}}` substitution from `params` and the `@root_path` / `@project_path` tokens every `.clave` prompt takes. An unknown `{{x}}` stays as written. A personal copy of the file changes `params` without touching the prompt.
- `skill` (optional) names the routine's own skill, loaded on top of the contract skill Clave injects (below).
- `cwd` (optional, default the group's) resolves against the file's root like a terminal's.
- **The launch parameters** are every choice a person makes when opening a tab, and a run starts exactly as declared: `agent` (`claude`, `codex`, `pi`, `antigravity`), `form` (`chat` or `terminal`), `model`, `effort` (Claude's reasoning effort) or `thinking` (Pi's level) where the agent takes one, `provider` (Pi's), `profile` (a launch profile by id or name, ADR 0001), `account` (an id, a label, or `any` for the pool, ADR 0002), `dangerousMode` (permissions off: Claude's skip flag, Codex's yolo) and `permissionMode` (`default`, `acceptEdits`, `plan`, the mode a Claude run without `dangerousMode` asks under). Every one is optional. **A missing field falls back to the workspace's launch defaults exactly as `clave_open_session` resolves them, through the same functions and not a copy**: `resolveSpawnModes` for the agent, the model and the skip flag; `resolveProfileRef` with the workspace's `chatDefault` for the form and the profile (so a chat run lands on the chat the launcher would open in that workspace); the served tool's account resolution for the account (a named account honoured, `any` or nothing the pool's pick with exhausted accounts skipped); the chat's remembered effort when none is declared. **An invalid value fails the run with the reason** (an unknown profile, an unknown account, a model the CLI refuses (the model is passed through and the CLI's own refusal is the reason: no list of models exists before a session starts), an effort the model does not take, `form: chat` on an agent with no chat view, `dangerousMode` on an agent whose CLI has no such flag): recorded before any agent starts, shown on the badge and in the panel, never a silent fallback. The defaults in the example above are the task's; a file that names nothing but `name`, `schedule`, `prompt` and `report` runs on the workspace's defaults.
- Which agents can report: Claude in both forms and Codex in the chat form reach Clave's MCP tools, so they can call the report tool; Pi and Antigravity have no in-agent Clave tools (ADR 0001), so a routine on them is accepted, runs as declared, and is recorded as failed, "this agent cannot report", until a tool bridge exists. The contract skill (below) travels as a Claude plugin for Claude and in the first message for the others.
- `icon` and `color` take the terminals' enums; an unknown icon falls back to `clock`.
- `catchUp` (optional, default true): an occurrence missed while the server was down fires once at its next start. Off, the miss is recorded and nothing runs.
- `timeoutMinutes` (optional, default 30): a run still going is ended and recorded as failed.
- `scope` (optional, default `machine`): where "once" is counted. `machine` runs once per machine, which is the occurrence claim under `~/.clave/routines` (a workspace health check is one per machine). `team` is one run for the whole team (an inbox triage), which needs a shared claim held elsewhere, the Steward server or the team hub, later. Only `machine` is built: a `team` routine parses, shows in the toolbar, and every occurrence is recorded as failed with "team scope is not built yet", never run.
- `report` (required): the deck **template** folder, by path inside the `.clave` file's folder (resolved against the file's root like `cwd`, refused when it escapes that root); the JSON **schema** of the run's data (default `<template>/schema.json`); the panel's ideal **width** and **height** in CSS pixels (default 560 by 640, clamped to the window). A routine whose template or schema is missing or unreadable at run time is recorded as failed with the reason, before any agent starts.

### Trust

A routine acts unattended, so the whole declaration is elevated. `describeElevated` lists each routine's prompt among the prompts (prefixed with the routine's name) and raises `dangerous` when one has `dangerousMode`; the review dialog adds the line "N routine(s) will run on a schedule". `sanitizeElevated` ("Open safely") **drops the routines** of an untrusted file: an untrusted file may not schedule anything, and a routine that is listed but never runs would read as a bug. The scheduler itself never asks for a review: it reads with no reviewer, so an elevated file nobody trusted contributes nothing. `trust.test.ts` grows with both.

### The six mirrors

The schema moves in the six places the app's `AGENTS.md` names, in one change: the renderer types (`PinnedGroupRoutine`, `PinnedGroup.routines`), the trust boundary, the contract (`ClaveRoutine` in `packages/contract/src/workspace-files/model.ts`) with the parser and the writer in `files.ts`, the preload declarations, the MCP tool schemas (routines are file-only in v1: `clave_create_group`, `clave_launch_group` and `clave_add_group_terminal` neither take nor return them, and their descriptions say so), and the create-workspace skill, which gains a "Routines" section with the deck template's shape. The round-trip too: `createPinnedFromGroup`, `pinGroupFromCurrent`, both single-group normalisations of `pinned-store.ts`, `exportClaveFile`, and the `PinnedBlueprint` main reads.

### The scheduler is the server's

Routines are a **domain of the server**, through the per-domain pattern: `packages/contract/src/routines.ts` (the routine as the scheduler sees it, the run record, the queries `ListRoutines` and `GetRoutineRun`, the commands `RunRoutineNow`, `DismissRoutineRun`, `ReportRoutineRun`, `OpenRoutineDiscussion`; `RoutineRefused` in the words the window shows), `packages/server/src/routines/` (the `Routines` port, the handlers, the API group, the events `routines.changed`), `packages/client/src/routines.ts`. The implementation is one object built in whichever process runs the server: in-process inside Electron main (`npm run dev`, the harness), the packaged app's separate child, or the daemon. A daemon runs its routines with no client attached, so a routine fires on time when the app is closed; an in-process server stops with the app and catches up once at the next start.

**Where the routines come from.** The server reads them itself, from the `.clave` files of the workspaces in its own registry, through the `WorkspaceFiles` it already owns: each workspace's profile file (else its discovered `default`, else its sole file, the renderer's rule), and with `autoDiscover` on, the project files the recursive walk finds, preferring a same-named profile inside each project (`romain.clave` over `default.clave` for the `romain` profile). Every file is read trusted-or-nothing (no reviewer), the routines of every group collected, and the files watched: a change on disk, a workspace added or removed, re-resolves the set. No window is involved, which is what lets a daemon schedule with nobody attached; the window reads the same set back from its server for the toolbar.

**The rules**, in `packages/server/src/routines/scheduler.ts`, pure over an injectable clock:

- **The tick.** Every 30 seconds, and whenever the routines change, the scheduler computes for each routine the occurrences of its schedule in `(lastConsideredAt, now]`. One or more → **one** run, then `lastConsideredAt = now`. The run's trigger is `scheduled` when the latest occurrence is under 90 seconds old, `catch-up` otherwise; with `catchUp: false` the misses are recorded as skipped and nothing runs. N misses are one run, never N. A sleep needs no power event: the machine wakes, the next tick finds the gap, and the same rule applies.
- **First sighting and changes.** A routine never seen starts its clock at now: nothing from before its declaration is caught up. A changed `schedule` resets the clock the same way.
- **One run at a time.** A routine with a run in flight skips its occurrence, recorded as skipped. "Run now" is refused while a run is in flight, with the state shown.
- **Never twice across servers, windows or instances.** Windows do not schedule. Two servers can read the same `.clave` file (the installed app's child server and a dev app's in-process server on the same Mac, or two user data directories), so the unit of exclusion is the **occurrence**: before a run starts for occurrence T, the server claims it by creating `~/.clave/routines/claims/<hash of the routine key>/<T>.json` exclusively (`O_EXCL`); a claim that already exists means another server took it and the occurrence is skipped as taken. A manual run claims `manual-<run id>`. Claims older than seven days are pruned. The claim folder is per user, outside every server's data directory, so it holds across data directories; a server that cannot write it (a read-only home) does not run routines and says so in its log and on the panel.
- **Persistence.** `routines.json` under the server's data directory, written atomically through the storage port: per routine key, `lastConsideredAt`, `seenAt`, the `schedule` last seen, and the last **20 runs**: id, trigger, `startedAt`, `endedAt`, `status`, `headline`, the reason when failed, the session id, the Claude session id (the transcript), the discussion session id when one was opened, the account label and the model, the deck folder, and whether the person has seen it. Routines absent from the files for 30 days are pruned, their deck folders with them.
- **Quit during a run.** The session dies with the server. At the next start a run with no end is recorded as failed, "the server stopped during the run". Its occurrence was claimed and considered, and is not caught up.

### The run: a hidden chat session on the server

A run is a session the server starts through its own session host (`StartSession`, the same path every start takes), with the spawn options the launch parameters resolve to (the modes, the launch profile, the model, the effort or the thinking level, the account fields, the skip flag or the permission mode) and a new session link `{ kind: 'routine', routineKey, runId }`. A session with that link is **not a sidebar row**: the windows never place it, the boot restore never adopts it (the way toolbar survivors are parked), and its record carries `viewId: 'clave.routine-report/report'`. A **chat** run is an events-transport session: the server binds an in-process consumer and marks it ready, which is what starts the process (the chat adapter starts at ready). A **terminal** run is a PTY session started at the hidden size, its prompt auto-submitted as a pinned session's is, and ended by its process's exit. No window is needed for either.

**The contract skill.** Clave ships a Claude Code plugin folder with the app, `resources/claude-plugins/clave-routine/` (`.claude-plugin/plugin.json`, `skills/run/SKILL.md`), and starts every Claude routine run with `--plugin-dir` on it, a Clave-managed flag for routine runs. The run's first message is the skill's invocation, `/clave-routine:run`, followed by the run's facts (the routine's name, the run id, the absolute path of the schema file, the routine's own skill when it names one) and the job, the routine's prompt after substitution. For an agent with no plugin mechanism (Codex, Pi, Antigravity) the same skill text is the preamble of the first message, the facts and the job after it. The skill explains the contract: do the job; load the routine's own skill first when one is named; end by calling `clave_routine_report` with `data` matching the schema at the given path (read it first); how to write the `headline` (one line, what the person needs to know) and the `summary` (the account of the run, markdown, what was done, what is proposed); that nobody is watching the session and that a question waits on nobody; that a run without a report counts as failed. One line is also appended to the system prompt (`--append-system-prompt`): that this is an unattended Clave routine run and that the `clave-routine:run` skill is the contract. The routine's own skill comes on top of it.

**The watch.** The server's runner watches the stream: a `blocked` state (a permission the agent asks for, a question) puts the run in **waiting**, shown amber and pulsing on the badge with "waiting on you", until the person answers it in the panel's discussion or the timeout ends it as failed; `done` or an exit ends the run; the timeout ends it. When the run ends, the process is **stopped**: the transcript stays on disk under its Claude session id, and the discussion resumes it on demand.

### The report: data validated against the schema, written into a deck

The run ends with the agent calling the report tool:

```
clave_routine_report {
  status: "ok" | "attention" | "failed",
  headline: string,     // one line, 120 characters at most
  summary: string,      // markdown, 4000 characters at most
  data: object          // the deck's data, validated against the routine's schema
}
```

The tool is identity-gated like the cross-tab tools: the caller's per-session token names its session, which must be a routine run in flight; any other session, or the anonymous shared token, is refused with the reason. It is registered in both MCP servers (main's `mcp-server.ts`, the standalone's `standalone-mcp.ts`), each a thin arm over the server's `ReportRoutineRun` command, so a run started by a daemon reports to the daemon. A call after the run ended is refused; a second call while it is in flight replaces the first. The MCP `INSTRUCTIONS` block does not change: the skill names the tool, so the instructions budget is untouched.

**Validation.** The server validates `data` against the routine's schema (JSON Schema, draft 2020-12, through `ajv` with `ajv-formats`, a new dependency of the server package; the schema itself is compiled once per run and a schema that does not compile fails the run with its error). Invalid data is refused to the agent **with the validation errors**, so the agent can correct and call again within the same run; a run that ends with no valid report is **failed**, the reason shown ("ended without a report", or the last validation errors). Nothing of an invalid report is written.

**The deck.** On a valid report the server copies the routine's template folder (bounded at 5 MiB, symlinks not followed) into the run's deck folder, `<data dir>/routines/decks/<hash of the routine key>/<run id>/`, writes `data.json` there, and fills the template's `<script type="application/json" id="slideless-data">` block in `index.html` with the same content: an envelope (`routine`, `run` with its id, trigger, start and end, `status`, `headline`, `summary`, `reportedAt`) and the agent's `data` under `data`. The template's `AGENT.md` is kept as it is. A root `index.html` under `decks/` names the folders, as the Analytics decks do. One `slideless dev <decks root> --port <n> --no-open --json` child per server process serves the root on the loopback (the Analytics plugin's own viewer module, `plugins/analytics/src/viewer.ts`, imported rather than copied, over the login shell's environment the entry hands it: the CLI found on that path, the port read from its JSON line and kept in `routines.json`, a backoff on exit, stopped with the server). The viewer's URL of a run's deck is what the panel renders. Without the CLI, the panel shows the envelope (status, headline, summary) as a plain card with the one-line reason, the way the Analytics pages fall back; the data is still on disk. A daemon on another machine serves its viewer on its own loopback, unreachable from the Mac: named as a limit of v1, the panel showing the envelope card for such a server.

### The indicator and the floating panel

In the toolbar, one button per routine after its group's terminals: the icon in the routine's colour, with a dot where the server buttons carry theirs. The dot is the **unseen last run**: green for `ok`, amber for `attention`, red for `failed`, the accent colour pulsing while a run is in flight, amber pulsing while a run waits on the person; no dot once the person dismissed the run or when nothing ran yet. The tooltip says the name, the last run (time and status) and the next one. The toolbar shows the routines of the active workspace, read from the server the window is attached to; the store is pushed to every window on `routines.changed`.

Clicking opens a **floating panel** anchored on the button (the popover the toolbar terminals use), sized to the routine's declared width and height, clamped to the window. Its header: the routine's name, the schedule in words ("weekdays at 08:30"), the next run, and a **toggle between Report and Discussion**. Its foot: the buttons **Run again**, **Open as a tab**, **Dismiss**, and the history, one row per kept run (status dot, headline, time, duration, trigger), selectable; the body follows the selected run.

- **Report** renders the selected run's deck through the Slideless viewer in a web view (the hardened guest every page in Clave renders into, `PageGuest`, its links policed in main), or the envelope card when there is no deck.
- **Discussion** is the run's session continued inside the panel, without a tab: the chat view component on a chat run's session, the terminal pane on a terminal run's. A run in flight or waiting is the live session, so the person answers what it waits on right there; an ended run is resumed when the toggle is first switched: the server starts a new hidden chat session on the run's Claude session id (`OpenRoutineDiscussion`), linked to the run as its discussion session, and the panel mounts that. The conversation goes on from the report.
- **Open as a tab** places the discussion session in the asking window's sidebar as an ordinary tab, on the chat view, for a conversation that outgrows the panel.

### The view plugin: `clave.routine-report`

A new bundled native plugin, `plugins/routine-report/`, the chat plugin as its model: a manifest contributing one view (`report`, "Routine report", rendering the `events` transport) with the `sessions.read` grant, a `main.mjs` that activates nothing, and `src/RoutineReportView.tsx` registered in `native-views.ts`. The view renders the deck of the run whose session it is given, so a run opened as a tab can be read as **Routine report**, **Chat** or **Terminal** from the pane's picker. The panel renders the same report component directly, outside the pane registry, because the panel is not a pane. The contract skill folder ships beside it.

### The first consumer's template

The lane's report proposes, for the Antasphere workspace files, the routine above and its template at `.clave/routines/workspace-health/`: `index.html` (a deck with the envelope's headline and status, then one card per check, `steward status`, `steward sync`, `steward secrets status`, `team tools outdated`, `steward doctor`, each with its verdict, what was fixed and what is proposed), `schema.json` (the checks as an array of `{ name, verdict: ok | fixed | attention | failed, fixed: string[], proposed: string[], detail }`) and `AGENT.md`. Applying it to the workspace repository is Romain's, after the merge.

### Tests

Unit: the cron parser (each field, names, steps, invalid expressions, the next occurrence across the Brussels clock changes); the scheduler's rules (an on-time tick, N misses as one catch-up run, `catchUp: false`, the first sighting, a schedule change, a run in flight, a stop during a run, a gap in the ticks read as a wake); the claims (taken, already taken, pruned, an unwritable folder); the file resolution (the profile file, the discovered default, the sole file, the auto-discovered project files, an untrusted file contributing nothing); the store (20 runs kept, 30-day pruning); the report (valid data written, invalid data refused with its errors, a schema that does not compile, a template escaping the root refused, the deck filled and the envelope's shape); the trust boundary (routine prompts disclosed, `dangerous` raised, routines dropped by "Open safely"); the parser and writer round-trip; the prompt substitution and the first message's shape. End-to-end, on the built app with a fixture `claude` that reads its `--mcp-config` and calls the tool: a routine runs at its minute and its run is recorded with its deck written from the fixture's data; a report with invalid data is refused and the run is failed with the errors; a run without a report is failed; two windows produce one run; two servers on one file produce one run (the claim); a relaunch with a missed occurrence produces one catch-up run; "Run now" from the panel; the Discussion toggle mounts the chat on the run's session; "Open as a tab" places it. In-process and separate server modes both.

## Consequences

A `.clave` file can now make Clave act with nobody at the keyboard, which is why the whole declaration is elevated and why an untrusted file loses it. The scheduler is the server's, one per server process, and the occurrence claim makes it one per user across servers. A routine's report is a deck the routine's author designs, validated against a schema the author writes, so the panel shows exactly what the routine measured and nothing Clave guessed. The first consumer, a weekday "Workspace health" routine for the Antasphere workspace files with its deck template, is proposed in the lane's report and applied by its owner after the merge. Codex routines, routines declared by an agent at runtime, a notification on `attention` and `failed`, a daemon's deck served to a remote Mac, and a routine's own page in Settings are left for later and named in the lane's report.

## Round 1 of the verification (2026-11-06)

The independent verifier ruled the first build not merge-safe (`verifier-1.md` in the workstream bundle). What changed because of it: a run waits for the agent tools' address before it starts, bounded at ninety seconds, and is failed unstarted with the reason rather than started with no way to report (the packaged app's separate server announced its address after the first tick); a chat-form run's record carries its `routine` link like a terminal's, so it is never adopted as a sidebar tab; "Open as a tab" is the window taking the started session in, the way it takes in a tab an agent opened through the server; every `<` of the deck's data block is written as `\u003c`; a `timeoutMinutes` above a week is clamped to a week; the cron parser takes digits and names only; a catch-up deeper than a thousand occurrences is named by the latest; the schema path is confined to the file's folder like the template; the service has unit tests of its own.

Accepted as they are, with the reason: the pin of a live group carries no routines (a live group has none, a routine is the file's alone); the HTTP `ReportRoutineRun` command trusts its payload's session id, as every command of the server's surface does behind the bearer token, the identity gate living in both MCP arms, which are the only callers.
