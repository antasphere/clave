# Sessions

Sessions are the core of Clave. Each session is an independent terminal running in its own tab.

## Creating Sessions

| Shortcut | Type | Description |
|---|---|---|
| Cmd+N | Claude Code | AI-assisted coding session |
| Cmd+T | Terminal | Plain shell session |
| Cmd+D | Dangerous | Claude Code without permission prompts |
| Cmd+I | Antigravity CLI | Antigravity CLI coding session |
| Cmd+U | Codex CLI | Codex coding session |
| Cmd+Y | Codex CLI (YOLO) | Codex session without sandbox or approval prompts |
| Cmd+Shift+P | Pi | Pi coding-agent session |

You can also create sessions from the **+** button in the sidebar.

## Session Status

Each session shows a colored dot in the sidebar:

- **Pulsing** (active): Claude is generating a response or running tools
- **Solid green** (idle): Waiting for your input
- **Gray** (ended): Session has finished or was closed

Sessions with unseen activity highlight their icon in the accent color so you know which tabs need attention.

## Session Modes

Session icons in the sidebar reflect their type:

- **Sparkles**: Claude Code session
- **Fire**: Dangerous mode session
- **Antigravity logo**: Antigravity CLI session
- **Pi logo**: Pi session
- **Bolt**: Agent session
- **Globe**: Remote session
- **Terminal**: Plain shell session

## Session Groups

Drag sessions together in the sidebar to create groups. Groups let you organize related sessions (e.g., "Frontend + API + Tests"), collapse them to reduce clutter, and color-code for visual distinction.

See the **Session Groups** doc for more on pinned groups and .clave files.

## Closing Sessions

- **Cmd+Backspace**: Kill the focused session
- Right-click a session in the sidebar and close it

## Auto-Naming

Sessions are automatically named based on your first message to Claude. The name updates as the conversation progresses.
