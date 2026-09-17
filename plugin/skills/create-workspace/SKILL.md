---
name: create-workspace
description: Creates a .clave workspace file that defines groups, sessions, terminals, toolbar actions, and icons for the Clave desktop app. Use when the user wants to create, edit, or understand .clave workspace files.
---

# Create Workspace

This skill helps you create and configure `.clave` workspace files for the Clave desktop app — a multi-session terminal manager built on Electron.

## What is a `.clave` file?

A `.clave` file is a JSON file that defines one or more **groups**. Each group contains **sessions** (terminal instances) and **terminals** (quick-action buttons with pre-configured commands). When dropped into Clave or loaded via the Workspaces settings, these groups become **launchable templates**.

Templates live in the **group picker** — a full-screen dialog opened from the grid icon beside the Sessions heading in the sidebar. Clicking a group stamps out a fresh one every time; it never links back to the running group. The picker shows one card per group, with a search field, and:

- Groups templates under their `category` as section headers. Uncategorized templates render first, then categories **alphabetically**. There is no manual ordering — if you need a specific order, name the categories so they sort that way.
- Hides groups marked `"toolbar": true` (those render as icon buttons in the top toolbar instead).
- Shows a search box once there are more than 5 templates.

(The old inline pinned-groups grid in the sidebar is now only a drop target for dragging groups and `.clave` files.)

### Single-group vs multi-group

A `.clave` file can define either a single group or multiple groups:

**Single-group** (e.g. `my-project.clave`):
```json
{
  "$schema": "clave/1.0",
  "name": "My Project",
  "cwd": ".",
  "color": "blue",
  "sessions": [...],
  "terminals": [...]
}
```

**Multi-group / workspace** (e.g. `workspace.clave`):
```json
{
  "$schema": "clave/1.0",
  "groups": [
    { "name": "Group A", "cwd": ".", ... },
    { "name": "Group B", "cwd": "../other", ... }
  ]
}
```

The format is auto-detected: if the top level has a `groups` array, it's multi-group. Otherwise, it's single-group.

## Path resolution

All `cwd` and `logo` paths in a `.clave` file are relative to a **root directory**, which is *not always the file's own folder*:

| How the file was loaded | Root for relative paths |
|---|---|
| Dropped onto Clave / `workspace.clave` in a folder | The file's parent directory |
| Discovered under a workspace (`.clave/workspaces/*.clave`) | **The repo directory that contains the `.clave/` folder** |
| Registered via Settings → Workspaces | The folder you selected |

This distinction matters. In `my-repo/.clave/workspaces/default.clave`, `cwd: "."` means `my-repo/`, **not** `my-repo/.clave/workspaces/`. A file written for auto-discovery will therefore resolve paths incorrectly if someone drag-drops it standalone. Write repo files for discovery and load them that way.

| Relative path | Meaning |
|---|---|
| `.` | The root directory (see table above) |
| `src/backend` | Subdirectory |
| `../other-repo` | Sibling directory |

## Group definition

Each group has these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Display name shown on the template row |
| `cwd` | string | Yes | Working directory for the group (relative path) |
| `color` | string | No | Group accent color (see Colors below) |
| `category` | string | No | Section header in the group picker (e.g. `"Platform"`, `"Clients"`). Sections sort alphabetically; uncategorized groups come first. Has no effect anywhere else in the UI |
| `logo` | string | No | Small icon shown on the template row. Either a path relative to the root dir (`.png`, `.svg`, `.jpg`, `.gif`, `.webp`, `.ico`) or an inline `data:` URI. Path form is read and inlined as a data URI at load |
| `toolbar` | boolean | No | If `true`, this group's terminals appear as quick-action buttons in the top toolbar and the group is **hidden from the group picker** |
| `prompt` | string | No | The group's **default prompt**. Sessions launched from the group's own `+` button in the sidebar start on it, so a whole lane shares one starting brief. A session's own `prompt` still wins for that session. Same path tokens as a session prompt, and elevated the same way (see below). Does **not** apply when the remembered agent is `claude agents` — that subcommand rejects a positional prompt, and the `+` says so rather than promising one |
| `view` | string | No | The group's **web view**: the page shown in the main pane when the group is clicked, instead of the tiled sessions. An `http(s)` URL, or a path to an `.html` file relative to the root dir — a page that needs no process. A terminal's `groupView` wins over it (see Group views below) |
| `sessions` | array | Yes | Terminal sessions to spawn (see Sessions below) |
| `terminals` | array | Yes | Command buttons shown on the group (see Terminals below) |

## Sessions

Each session spawns a terminal process in a specific directory. A session runs one agent CLI, or a plain shell if no agent mode is set.

```json
{
  "cwd": ".",
  "name": "Backend",
  "claudeMode": true,
  "dangerousMode": false
}
```

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Working directory (relative to the root dir) |
| `name` | string | Display name of the tab |
| `claudeMode` | boolean | `true` = starts Claude Code, `false` = plain terminal |
| `antigravityMode` | boolean | `true` = starts the Antigravity CLI (`agy`) |
| `codexMode` | boolean | `true` = starts the Codex CLI |
| `piMode` | boolean | `true` = starts the Pi coding agent. The workspace's current Pi launch profile supplies the command, provider, model, and thinking level |
| `claudeAgentsMode` | boolean | `true` = starts Claude via the `claude agents` subcommand. Never receives a `prompt` — the subcommand rejects a positional prompt |
| `dangerousMode` | boolean | `true` = Claude runs with `--dangerously-skip-permissions`; Codex runs with `--yolo` |

Set at most one agent mode. If `antigravityMode`, `codexMode`, `piMode`, or `claudeAgentsMode` is `true`, `claudeMode` is forced to `false` at spawn.

> **Deprecated:** `geminiMode` is the retired name for `antigravityMode`. Files using it still load (it is read as an alias), but Clave writes `antigravityMode` whenever it saves the file back. Don't emit `geminiMode` in new files.
| `prompt` | string | Optional. A one-shot message auto-submitted to the agent the moment the session launches, so it starts already primed. Agent modes only (claude / antigravity / codex / pi) — ignored for plain terminals and `claude agents`. Free text; supports the path tokens below. |
| `rootSession` | boolean | Optional. `true` = spawn the session at the **workspace root** (the folder whose `.clave/workspaces/` the umbrella auto-discovered), instead of at `cwd`. `cwd` still names the project dir that feeds the prompt tokens. It also anchors the group's `+`: a tab opened there later starts at the root too, so every tab in the group sits where the declared one does. No effect when the file is opened standalone (no umbrella root known). |

**Prompt path tokens** (substituted at launch, only useful with `rootSession: true`):

| Token | Expands to |
|---|---|
| `@root_path` | Absolute workspace root, e.g. `/Users/you/.codika` |
| `@project_path` | Project dir **relative to root**, e.g. `clients/acme` (derived from the file's location + its `cwd`) |
| `@project_abs` | Project dir absolute path |

**Tips:**
- For development groups, create two sessions: one `claudeMode: true` for AI work, one `claudeMode: false` for running dev servers
- Session names should be short and descriptive
- An empty `sessions` array is valid (useful for toolbar-only groups)
- The DRY way to open a deep project's session at the umbrella root: set `rootSession: true`, leave `cwd` as the tiny relative path to the project (`.` or `..`), and reference the project in the prompt with `@project_path` — no `../../..` climbs, no hardcoded paths. See "Priming a session" below.
- A `prompt` on an untrusted `.clave` file is treated as elevated — the group-level `prompt` exactly as much as a session's, since it auto-submits to every session the group's `+` launches: Clave shows the review dialog (like auto-run commands) before it will auto-submit. Files under a trusted workspace root, or that you authored in Clave, skip the dialog. (`rootSession` alone is not elevated.)

## Terminals

Terminals are command buttons that appear as colored icons on the group. Clicking a terminal icon spawns a new session that runs or pre-fills the command.

```json
{
  "command": "npm run dev",
  "commandMode": "auto",
  "color": "green",
  "icon": "bolt"
}
```

| Field | Type | Description |
|---|---|---|
| `command` | string | Shell command to execute. Can be empty for a blank shell |
| `commandMode` | `"prefill"` or `"auto"` | `"prefill"` = types the command but waits for Enter. `"auto"` = executes immediately |
| `color` | string | Button color (see Colors below) |
| `icon` | string | Button icon (see Icons below) |
| `cwd` | string | Optional. Working directory for this terminal (relative path). If omitted, uses the group's `cwd` |
| `autoLaunchLocalhost` | boolean | Optional. Open the detected `localhost` URL in the browser once the command serves one. Use for dev servers **in sidebar groups** — for toolbar buttons use `serverUrl` instead |
| `persistent` | boolean | Optional, **toolbar groups only**. Keep the spawned session alive when the toolbar popover closes, and reattach to it next time instead of respawning |
| `serverUrl` | string | Optional, honored on **toolbar buttons**. Declared server URL (e.g. `"http://localhost:3000"`) — turns the button into a **server button**: click probes the URL and either opens it or starts the command first (see Server buttons below). Implies `persistent` |
| `groupView` | boolean | Optional, **sidebar groups only**, requires `serverUrl`. Makes this terminal's page the group's **web view**: clicking the group shows the served page in the main pane instead of the tiled sessions, with this terminal as its start action — run unasked the first time the view finds the server down when `commandMode` is `auto`, offered as a Start button when it is `prefill` (see Group views below) |

**Tips:**
- Use `"auto"` for dev servers (`npm run dev`) that should start immediately
- Use `"prefill"` for dangerous or one-time commands (`firebase deploy`, `npm publish`) so the user can review before executing
- By default, terminals run in the group's `cwd`. Use per-terminal `cwd` when a group contains apps in different directories (e.g. a monorepo with `client/` and `dashboard/` sub-apps)

## Toolbar groups

When a group has `"toolbar": true`, its terminals appear as quick-action buttons in the top toolbar bar of the Clave window instead of the sidebar. This is ideal for utility commands that should always be accessible regardless of which group is active.

**Rules:**
- Toolbar groups do NOT appear in the sidebar pinned area
- Toolbar groups typically have an empty `sessions` array (they're just button collections)
- If multiple groups have `toolbar: true`, they're separated by subtle vertical dividers
- Toolbar buttons show the terminal's icon in its color, with a tooltip showing the command on hover

**Example — Auth toolbar group:**
```json
{
  "name": "Auth",
  "cwd": ".",
  "color": "yellow",
  "toolbar": true,
  "sessions": [],
  "terminals": [
    { "command": "firebase login --reauth", "commandMode": "prefill", "color": "yellow", "icon": "fire" },
    { "command": "gcloud auth login", "commandMode": "prefill", "color": "blue", "icon": "shield" }
  ]
}
```

## Server buttons: launch local apps from the toolbar

Add `serverUrl` to a toolbar terminal and it stops being a "run this command" button and becomes an **app launcher**: one always-visible button per local web app (docs site, website, dashboard, admin UI) that means *"make this app exist and take me to it."* This is the most powerful toolbar pattern — a row of server buttons turns Clave's toolbar into a launcher for your whole local stack.

```json
{
  "name": "Toolbar",
  "cwd": ".",
  "toolbar": true,
  "sessions": [],
  "terminals": [
    {
      "command": "mint dev --port 4711",
      "commandMode": "auto",
      "color": "teal",
      "icon": "eye",
      "cwd": "docs",
      "serverUrl": "http://localhost:4711"
    },
    {
      "command": "npm run dev --port 4712",
      "commandMode": "auto",
      "color": "green",
      "icon": "globe",
      "cwd": "apps/web",
      "serverUrl": "http://localhost:4712"
    }
  ]
}
```

**What a click does** (probe-first — the HTTP probe is the only source of truth, never session state):

1. **Probe** `serverUrl` (~500ms HTTP request).
2. **Reachable** → opens the URL in your browser. No terminal popover, no second server — this covers a server started by a previous click, one surviving a Clave restart, or one you started by hand.
3. **Not reachable** → opens the terminal popover, runs `command` (reusing the persistent session if its shell is still alive), and opens the browser as soon as the server announces its URL — including when it lands on a *different* port (e.g. 3000 was taken and the dev server hopped to 3001: the detected URL wins).

**Status dot.** The button carries a live dot so you can see the state before clicking: **green** = server up, **amber (pulsing)** = starting, **grey** = not running. Clave re-probes periodically and on window focus, so killing the server in some other terminal flips the dot without any interaction.

**Terminal access.** A plain click never shows the terminal when the server is already up — **right-click** (or ⌥-click) the button to open the popover with the server's logs without touching the browser. The popover header also shows a port chip (`:3000`) colored by server state; click it to open the browser.

**Rules of thumb:**

- **Pin the port in the command, and give each app its own uncommon one.** Write `"mint dev --port 4711"` + `"serverUrl": "http://localhost:4711"`, not a bare command relying on a default. The declared URL should be a promise, not a guess. Default ports (3000, 5173, 8080) are the ones another project is most likely to already be sitting on — and the probe cannot tell someone else's server from yours, so a hijacked default sends you to the wrong app. An unusual port makes that practically impossible.
- `serverUrl` implies `persistent` — you never need to write both.
- Declare the URL the command actually serves, scheme included: `"http://localhost:4711"`, not `"localhost:4711"`.
- Use `commandMode: "auto"` — a server button's whole point is that the click starts the server unattended.
- `serverUrl` supersedes `autoLaunchLocalhost` for toolbar buttons (that flag is only honored in sidebar groups); don't combine them.
- Session liveness is **not** server liveness: Ctrl-C'ing the server inside the popover leaves the shell alive. The probe is what decides — the next click sees the dead server and restarts it in the same shell, keeping the scrollback.
- Known residual: if an unrelated process answers on the declared port, the probe can't tell — the button will open it.

## Group views

A sidebar group normally shows its sessions tiled in the main pane. Give one of its
terminals `"groupView": true` and the group shows **that terminal's page** instead — a
dashboard, a docs site, a project board — with the sessions one click away in the view's
header. The terminal keeps working as a terminal; the flag only says "this is the page
the group is about." With `"commandMode": "auto"` the terminal is **started by the view
itself** the first time it finds the server down (a group clicked open shows its page, not
a dead page and a button); with `prefill` the view offers a Start button. A start is
patient: the view stays on "Starting server…" for as long as the command runs, counting
the seconds, and after a while adds "Show terminal" and an explicit Restart — a board's
`exos board refresh` alone can take a minute or two before the port answers.

```json
{
  "command": "exos board refresh; exos board open --port 4713 --no-browser",
  "commandMode": "auto",
  "cwd": "..",
  "color": "purple",
  "icon": "bolt",
  "serverUrl": "http://127.0.0.1:4713",
  "groupView": true
}
```

- **`serverUrl` is required** — a view needs a page, and it must be declared, not
  detected. Clave scans a terminal's output for a `localhost` URL only while its pane is
  visible, and the whole point of a group view is that nobody is looking at the terminal.
  A `groupView` without `serverUrl` is ignored.
- **Pin the port** and give each project its own, for the same reason server buttons do:
  the probe cannot tell your server from someone else's on a shared port, and a hijacked
  port shows the wrong app inside your group.
- The view **probes** the URL: a server that is down renders a start action wired to this
  terminal, never a broken frame. `commandMode: "auto"` so that click starts it unattended.
- An **untrusted** file's `groupView` is stripped by "Open safely" (the terminal itself
  survives) — see Trust below.
- An agent can attach the same view at runtime with `clave_set_group_view`, or declare it
  when it adds the terminal (`clave_add_group_terminal` takes `groupView`).

### A page with no server behind it

Not every view needs a process. A frozen snapshot, a generated report, a published
status page — those are just a file or a URL, and a group names one directly:

```json
{
  "name": "Syndicable",
  "cwd": "..",
  "view": "./syndicable-os/knowledge/board/snapshots/2026-08-23.html",
  "sessions": [ … ]
}
```

- A **path** resolves against the root dir exactly like `cwd`, and must end in `.html`
  or `.htm` — Clave renders it in-app, with no probe and no start action, because there
  is nothing to start. An **`http(s)` URL** is kept verbatim and probed like any server.
- Anything else is ignored and the group keeps its sessions: a `.clave` file is
  hand-written and unvalidated, and a permanently failing pane is worse than no view.
- **`groupView` wins.** If a terminal in the same group declares one, the served page is
  what the group shows — it is the live one, and it carries the start action. Declaring
  both is a mistake, not a fallback chain.
- Like `groupView`, an untrusted file's `view` is stripped by "Open safely".

## Trust: elevated files

A `.clave` file can run shell commands and drive an agent on your behalf, so Clave gates that behavior. A file is **elevated** if any of these is true:

- a terminal has `"commandMode": "auto"` with a non-empty `command`
- a session has a non-empty `prompt`
- a session has `"dangerousMode": true`

Opening an elevated file that the user has not trusted shows a review dialog listing what would run, with three outcomes:

| Choice | Result |
|---|---|
| **Trust and run** | Loads as authored. Trusts this exact file content (by SHA-256 hash) |
| **Open safely** | Loads **sanitized**: `auto` → `prefill`, `dangerousMode` → `false`, every `prompt` is **dropped**, and both view declarations (`groupView`, `view`) are **dropped** (no page renders itself inside Clave) |
| **Cancel** | Nothing loads |

A checkbox additionally trusts the whole containing folder as a **workspace root**, so every `.clave` under it skips the dialog from then on. Files Clave itself writes are trusted automatically.

Trust is resolved as: file lives under a trusted root → its supplied root dir is trusted → its exact content hash was trusted before. Note that trusting by content hash is per-content: **any edit to the file re-triggers the dialog.** Folder trust is the durable option.

Practical consequence: if a user reports that their prompts never fire or their dev servers only prefill, they opened the file with "Open safely". `rootSession` alone is not elevated.

## Colors

Available named colors for groups and terminals:

| Color | Hex | Best for |
|---|---|---|
| `black` | `#3A3A3C` | Neutral / infrastructure |
| `green` | `#34C759` | Dev servers, success actions |
| `teal` | `#5AC8FA` | Backend / API |
| `blue` | `#007AFF` | Primary projects |
| `purple` | `#AF52DE` | AI / agents / creative |
| `yellow` | `#FFD60A` | Auth / warnings / utilities |
| `pink` | `#FF6482` | Secondary products |
| `red` | `#FF3B30` | Deploy / danger / critical |

Custom hex colors (e.g. `"#FF9500"`) are also supported — the string must start with `#`.

> ⚠️ **These eight names are the only valid names.** A color is resolved as: known name → its hex; string starting with `#` → itself; **anything else → no color at all**. So `"orange"`, `"cyan"`, or `"lightblue"` do not fail loudly — the group or button just renders colorless. If you want a shade outside the palette, write it as hex.

## Icons

Available icons for terminal buttons (18 options):

| Icon | Heroicon | Best for |
|---|---|---|
| `terminal` | CommandLineIcon | Default / generic shell |
| `fire` | FireIcon | Firebase, hot reload |
| `bolt` | BoltIcon | Dev servers, fast actions |
| `rocket` | RocketLaunchIcon | Deploy, publish, launch |
| `eye` | EyeIcon | Watch, inspect, status |
| `globe` | GlobeAltIcon | Auth, cloud, web |
| `cube` | CubeIcon | Build, package, container |
| `heart` | HeartIcon | Health checks, favorites |
| `star` | StarIcon | Important, featured |
| `user` | UserIcon | Auth, login, identity |
| `shield` | ShieldCheckIcon | Security, credentials |
| `wrench` | WrenchIcon | Fix, repair, config |
| `beaker` | BeakerIcon | Test, experiment |
| `cpu` | CpuChipIcon | Processing, compute |
| `signal` | SignalIcon | Network, sync, status |
| `bug` | BugAntIcon | Debug, troubleshoot |
| `sparkles` | SparklesIcon | AI, generate, magic |
| `cloud` | CloudIcon | Cloud services, hosting |

If no icon is specified, `terminal` (CommandLineIcon) is used as the default.

> ⚠️ **This list is exhaustive.** Any other string — including plausible Heroicon names like `device-phone-mobile` or `computer-desktop` — is not recognised and silently falls back to the default icon. To distinguish terminals, pick two names from the table above (e.g. `bolt` and `globe`).

## Complete workspace example

```json
{
  "$schema": "clave/1.0",
  "groups": [
    {
      "name": "Auth",
      "cwd": ".",
      "color": "yellow",
      "toolbar": true,
      "sessions": [],
      "terminals": [
        { "command": "firebase login --reauth", "commandMode": "prefill", "color": "yellow", "icon": "fire" },
        { "command": "gcloud auth login", "commandMode": "prefill", "color": "blue", "icon": "shield" }
      ]
    },
    {
      "name": "Frontend",
      "cwd": "apps/web",
      "category": "Apps",
      "color": "blue",
      "sessions": [
        { "cwd": "apps/web", "name": "Web", "claudeMode": true, "dangerousMode": false },
        { "cwd": "apps/web", "name": "Web Dev", "claudeMode": false, "dangerousMode": false }
      ],
      "terminals": [
        { "command": "npm run dev", "commandMode": "auto", "color": "green", "icon": "bolt" },
        { "command": "npm run build", "commandMode": "prefill", "color": "purple", "icon": "cube" }
      ]
    },
    {
      "name": "API",
      "cwd": "apps/api",
      "category": "Apps",
      "color": "teal",
      "sessions": [
        { "cwd": "apps/api", "name": "API", "claudeMode": true, "dangerousMode": false }
      ],
      "terminals": [
        { "command": "npm run dev", "commandMode": "auto", "color": "green", "icon": "bolt" },
        { "command": "npm run deploy", "commandMode": "prefill", "color": "red", "icon": "rocket" }
      ]
    }
  ]
}
```

## Per-terminal working directory

When a single group contains apps in different subdirectories (e.g. a monorepo), use per-terminal `cwd` to run each terminal in the right location without splitting into separate groups:

```json
{
  "name": "Acme",
  "cwd": "products/acme",
  "color": "#10b981",
  "sessions": [
    { "cwd": "products/acme", "name": "Acme", "claudeMode": true, "dangerousMode": true }
  ],
  "terminals": [
    { "command": "npm run dev", "commandMode": "auto", "cwd": "products/acme/acme-app", "color": "#10b981", "icon": "bolt" },
    { "command": "npm run dev", "commandMode": "auto", "cwd": "products/acme/acme-dashboard", "color": "#3b82f6", "icon": "cube" }
  ]
}
```

The `cwd` priority when spawning a terminal is: **terminal `cwd`** → **group `cwd`** → **first session's `cwd`**.

## Priming a session with an initial prompt

Use a session `prompt` to launch an agent already focused on a specific project. Combine it with `rootSession: true` to open the session at the **workspace root** (full workspace access) while the prompt points at the project via `@project_path` — no `../../..` climbs, no hardcoded paths.

This is a per-project `.clave` living at `clients/acme/acme-app/.clave/workspaces/default.clave`. Its `cwd: ".."` names the project dir (one level up from the file), which becomes `@project_path` → `clients/acme`. The session itself spawns at the umbrella root:

```json
{
  "name": "Acme",
  "cwd": "..",
  "category": "Clients",
  "color": "blue",
  "sessions": [
    {
      "cwd": "..",
      "name": "Acme",
      "claudeMode": true,
      "dangerousMode": true,
      "rootSession": true,
      "prompt": "We're working on Acme. The project lives at @project_path and spans acme-app, acme-cli, acme-os, acme-website. When we start, read @project_path/acme-app/CLAUDE.md first. You're at the workspace root (@root_path), so you have full access. Don't explore yet, just reply that you're ready and wait for my request."
    }
  ],
  "terminals": []
}
```

The prompt is a one-shot: it fires once on launch (and again when you Duplicate the tab), but a session re-adopted after quitting and reopening Clave is not re-primed — the resumed conversation already contains it.

The group's `+` reproduces this session — both halves of it. It starts on the same brief (a group-level `prompt` overrides the text, never the directory), and it opens in the same directory: at the workspace root when the session declares `rootSession: true`, in the group's `cwd` otherwise. The `@`-tokens still expand against the group's `cwd`, so the second tab is briefed exactly like the first.

## File placement

`.clave` files can be placed in three locations (checked in this order per directory):

| Location | Use case |
|---|---|
| `workspace.clave` | Simple single-file setup in project root |
| `.clave/workspace.clave` | Cleaner — keeps the root tidy |
| `.clave/workspaces/default.clave` | **Recommended for repos.** Supports per-user overrides |

For repos in a multi-repo workspace, always use `.clave/workspaces/default.clave`. This is the standard convention and enables the auto-discovery and per-user override features below.

## Auto-discovery

A workspace `.clave` file can automatically discover and load `.clave` files from repos nested under its root directory. Add `"autoDiscover": true` at the top level:

```json
{
  "$schema": "clave/1.0",
  "autoDiscover": true,
  "groups": [
    { "name": "Auth", "toolbar": true, "..." : "..." }
  ]
}
```

When the workspace is activated, Clave recursively scans the root directory for `.clave` files in repos and merges them as additional pinned groups alongside the workspace's own groups.

**How it works:**
- Scans up to 4 levels deep (configurable)
- Skips `node_modules`, `.git`, `references`, `build`, `dist`, `.next`, `.turbo` — **and every directory whose name starts with `.`**, so nested `.claude/worktrees/…` copies are never picked up
- **At most one `.clave` per directory** is ever used. The candidates are tried in order and the first hit wins — a repo's files do not merge
- Each discovered file is independently tracked and watched for changes
- Groups from the workspace file load first, discovered groups load after (sorted alphabetically by directory name)
- On workspace deactivation, all discovered pins are cleaned up

Anything deeper than `maxDepth` is simply invisible — no warning. Count from the workspace root, and raise `maxDepth` if your repos nest deeper.

**Advanced configuration:**
```json
{
  "autoDiscover": {
    "enabled": true,
    "patterns": ["workspace.clave", ".clave/workspace.clave"],
    "exclude": ["node_modules", ".git", "references"],
    "maxDepth": 4
  }
}
```

**Example setup — multi-repo workspace:**

Root workspace (`.clave/workspaces/default.clave`):
```json
{
  "$schema": "clave/1.0",
  "autoDiscover": true,
  "groups": [
    { "name": "Auth", "cwd": ".", "toolbar": true, "sessions": [], "terminals": [...] },
    { "name": "Platform", "cwd": "platform/app", "category": "Platform", "..." : "..." }
  ]
}
```

Repo-level file (`products/my-product/.clave/workspaces/default.clave`):
```json
{
  "$schema": "clave/1.0",
  "name": "My Product",
  "cwd": ".",
  "category": "Products",
  "color": "blue",
  "sessions": [{ "cwd": ".", "name": "My Product", "claudeMode": true, "dangerousMode": true }],
  "terminals": [{ "command": "npm run dev", "commandMode": "auto", "color": "green", "icon": "bolt" }]
}
```

The repo's group is auto-discovered and appears in the sidebar under "Products" — no need to add it to the root workspace file.

## Per-user workspace overrides

When a workspace file is named after a person (e.g. `alex.clave`), the auto-discovery scanner uses that name as a **workspace ID** to look for per-user overrides in repos.

**Resolution order in each repo's `.clave/workspaces/` folder:**
1. `{workspaceId}.clave` (e.g. `alex.clave`) — personal override
2. `default.clave` — shared team default
3. First `.clave` file found — fallback

**Example:** If the root workspace is `alex.clave`, and a repo has:
```
.clave/workspaces/
  default.clave      ← shared config (used by everyone)
  alex.clave       ← Alex's override (different sessions, colors, etc.)
```

Alex's Clave app picks `alex.clave`. Another team member using `default.clave` as their workspace gets the shared config.

This allows personal customization (extra debug sessions, different colors, additional terminals) without affecting the team's default configuration.

**It shadows, it does not merge.** `alex.clave` *replaces* that repo's `default.clave` entirely, so it must be a complete definition, not a delta. And because Clave only writes back to the file a template was loaded from, one person's edits can never touch a teammate's file.

Two gotchas:
- A workspace file literally named `default.clave` yields **no** workspace ID, so it always resolves to each repo's `default.clave`. To get per-user overrides, your umbrella file must be named after you.
- Fully personal setups are often simpler as a **single multi-group umbrella file with `autoDiscover: false`**, defining every group and `category` inline. You lose automatic pickup of new repos and per-repo `logo` locality, but you gain complete control over the sections and touch nobody else's files.

## How to use

1. **Create the file** — Save as `.clave/workspaces/default.clave` in your project (or `workspace.clave` in the root)
2. **Import into Clave** — Either:
   - Drag-drop the file from Finder onto the Clave pin area
   - Or go to Settings → Workspaces → Add Workspace (select the folder containing the `.clave` file)
   - Or rely on **auto-discovery** if the parent workspace has `"autoDiscover": true`
3. **Activate** — Click the workspace in Settings to load its groups. **Adding a workspace does not activate it** — you must click it
4. **Launch** — Open the template picker from the Sessions header and click a template to spawn its sessions and terminals

Clave watches loaded `.clave` files and reloads on change, but only refreshes templates that already exist. **Adding or removing groups requires deactivating and reactivating the workspace** (or restarting Clave); editing an existing group applies live.

Exporting a group back out to a `.clave` file (right-click → Export as .clave) is **lossy**: it drops `prompt`, `rootSession`, `logo`, and `autoLaunchLocalhost` (it keeps `cwd`, `persistent`, `serverUrl`, `groupView`, and the group's `view`). Hand-edit the dropped fields back in, or keep the source file as the source of truth.

## Best practices

- **Use `.clave/workspaces/default.clave` for repos** — Standard convention, supports auto-discovery and per-user overrides
- **Use `autoDiscover: true` for multi-repo workspaces** — New repos automatically appear when they add a `.clave` file
- **Keep workspace-level groups minimal** — Only toolbar actions and cross-repo groups belong in the root workspace
- **Use categories** — Group related pins under labels like `"Platform"`, `"Products"`, `"Tools"`
- **Use toolbar for utilities** — Auth commands, CLI tools, and status checks work great as toolbar buttons
- **Use server buttons for local apps** — Any command that serves a URL (docs, websites, dashboards) belongs in the toolbar with a `serverUrl`, so one click reaches the running app without ever spawning a duplicate
- **Separate Claude and dev sessions** — Create one `claudeMode: true` session for AI work and one `claudeMode: false` for dev servers
- **Use `prefill` for dangerous commands** — Deploy, publish, and destructive commands should require manual confirmation
- **Use `auto` for dev servers** — `npm run dev` and watch commands should start immediately
- **Keep group names short** — They appear as small pin buttons in the sidebar
