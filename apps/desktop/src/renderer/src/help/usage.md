# Usage Analytics

View Claude Code and Codex account limits, and local Pi token and cost totals.

[Open Usage](clave://navigate/usage)

## What It Shows

- **Claude Code and Codex**: Each reported quota window, its percentage used, and time until reset. Codex windows follow your account's limits, including any separately named model allowances.
- **Pi**: Input, output, cache read, cache write, total tokens, and recorded cost for Today, 7 days, 30 days, or all retained sessions. These are local totals, not account quota.
- **Sidebar footer**: Follows the focused Claude Code, Codex, or Pi session. Claude and Codex show the tightest reported limit as a percentage **left**. Pi shows today's tokens and recorded cost. Click the reading to open the corresponding Usage tab.

Refresh in the panel updates the footer too. Viewed providers refresh periodically and when you return to the app. Plain terminals and remote sessions do not show a local account's quota.

## Data Source

Claude Code uses its signed-in account's usage service. Codex uses the installed Codex CLI and its current sign-in to read account limits; API billing does not expose ChatGPT subscription quotas here.

Pi totals come from `~/.pi/agent/sessions/**/*.jsonl`. No Pi session data leaves the machine.
