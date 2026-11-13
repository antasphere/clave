# Clave Plugin (`clave`)

The companion agent plugin for [Clave](https://github.com/antasphere/clave) — a multi-session Claude Code desktop app. It ships **inside the app repo**, in this folder, so the skills and the `.clave` file format they describe always move together.

Two skills: `create-workspace`, which generates `.clave` workspace files from a natural-language description, and `recover-sessions`, which rebuilds a lost workspace from the Claude Code transcripts already on your disk.

Conforms to the [Open Plugin Specification v1.0](https://github.com/vercel-labs/open-plugin-spec).

## Install

### Any Open-Plugin-compatible host (Claude Code, Cursor, …)

```bash
npx plugins add antasphere/clave
```

The `plugins` CLI auto-detects which agent tools are installed and installs into all of them.

### Claude Code (native)

```
/plugin marketplace add antasphere/clave
/plugin install clave@clave
```

Both paths produce the same `/clave:<skill>` commands.

## What's Inside

| Skill | What it does |
|---|---|
| `clave:create-workspace` | Scaffold a `.clave` workspace file from a description. Handles groups, session configs, terminal commands, icons, colors, group and session views, and toolbar actions. |
| `clave:recover-sessions` | Rebuild a lost workspace after a crash. Finds your past sessions in `~/.claude/projects`, works out what each was about, and reopens them as grouped tabs with their full history. |

## Usage

Once installed, ask your agent things like:

- *"Create a clave workspace for my web-app project — 3 sessions: frontend, functions, docs."*
- *"Scaffold a workspace for the slideless repo with separate terminal tabs for the app, CLI, and docs."*
- *"Add a toolbar action to my existing workspace that runs `npm test`."*

The agent invokes `clave:create-workspace`, writes a valid `.clave` file to your chosen path, and you open it in Clave.

### Recovering after a crash

- *"My computer crashed and I lost all my sessions — recover what I had."*
- *"I had a group for the API rewrite and one for the mobile app. Bring them back."*
- *"What was I working on yesterday?"*

The agent invokes `clave:recover-sessions`, scans your local transcripts, maps each session to the project it worked on, and rebuilds your groups with the conversations resumed. Your history survives crashes because Claude Code stores every session on disk — only Clave's arrangement of tabs is lost, and that is what gets reconstructed.

Retention is a local setting: `cleanupPeriodDays` in `~/.claude/settings.json` (default 30 days). Raise it if you want a longer recovery window.

## About Clave

Clave is a macOS desktop app for running many coding-agent CLI sessions in parallel with shared layouts, git panels, and daily logs. Download at [github.com/antasphere/clave](https://github.com/antasphere/clave).

## License

MIT — see `LICENSE`.
