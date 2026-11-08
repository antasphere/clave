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

## Ongoing Conversations

Some conversations are not work: a situation you handle over weeks, like an exchange with your accountant or an email thread to sort out. Keep them out of the sidebar without closing them:

- Right-click a Claude or Pi tab (or a selection of tabs) and choose **Move to Ongoing**. The row leaves the sidebar; it keeps its place in its group, which says "Kept in Ongoing" if nothing else is left in it.
- An **Ongoing** card appears at the foot of the sidebar while the workspace keeps at least one. It counts them, and shows in the accent how many wait for your answer or hold a reply you have not read.
- Click it to open the Ongoing page: one card per conversation, with where it stands, your own note (click "Add a note" on a card), the last exchange, and the group it came from. Click a card to continue the conversation in the pane. Escape goes back to your tabs.
- An ongoing conversation survives a quit and a restart of the Mac. If no tab runs it any more, opening its card picks the same conversation up from its transcript; it is never offered in the restore prompt.
- From a card's menu (the `…` button or a right-click): **Back to the sidebar** puts the tab back where it was, and **End conversation** closes it. The conversation stays in the session history either way.

## Closing Sessions

- **Cmd+Backspace**: Kill the focused session
- Right-click a session in the sidebar and close it

## Auto-Naming

Sessions are automatically named based on your first message to Claude. The name updates as the conversation progresses.
