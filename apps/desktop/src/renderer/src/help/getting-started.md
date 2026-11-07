# Getting Started

Clave is a desktop app for managing multiple Claude Code terminal sessions side by side. Instead of juggling tabs or tmux panes, you get a visual workspace with integrated tools.

## Your First Session

1. Press **Cmd+N** to create a new Claude Code session
2. Claude starts in the terminal, type a prompt and go
3. The session appears in the left sidebar with a status indicator

## Session Types

- **Claude Code** (Cmd+N): A full Claude Code session with AI assistance
- **Terminal** (Cmd+T): A plain shell, no Claude
- **Dangerous Mode** (Cmd+D): Claude Code with `--dangerously-skip-permissions` (skips approval prompts)
- **Codex YOLO** (Cmd+Y): Codex with `--yolo` (bypasses its sandbox and approval prompts)
- **Antigravity CLI** (Cmd+I): An Antigravity CLI coding session

## What Else Can Clave Do?

- **[Git Panel](clave://navigate/side:git)**: Stage, commit, push, and visualize your git history
- **[File Browser](clave://navigate/side:files)**: Browse, preview, and edit files in your project
- **[Usage Analytics](clave://navigate/usage)**: Track token usage and costs

## Navigation

- **Left sidebar**: Your sessions and groups
- **Right sidebar** (Cmd+E): File browser, git panel, and help
- **Cmd+P**: Quick file search
- **Cmd+B**: Toggle left sidebar
- **Cmd+,**: Settings (theme, profile, workspaces, templates)

## Credits

The interface is set in **Geist**. The **Clave** wordmark beside the traffic
lights is set in **Sentient**, designed by the **Indian Type Foundry** —
Sentient is © 2019–2021 Indian Type Foundry, all rights reserved, used here
under the ITF Free Font Licence. The wordmark ships as outlined artwork, not as
a font file: the licence permits use, including in a logo, but not
redistribution of the font itself.
