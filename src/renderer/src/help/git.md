# Git Panel

The git panel gives you staging, committing, diffing, and push/pull without leaving Clave.

[Open Git Panel](clave://navigate/side:git)

## Opening the Panel

- **Cmd+Shift+G**: Open right sidebar on the Git tab
- Or click the **Git** tab in the right sidebar

## Panel Modes

Toggle between two modes in the panel header:

- **Changes**: Working tree view with staged, unstaged, and untracked files
- **Log**: Commit history with the Git Journey visualization

## View Modes

Switch between **list** (flat file list) and **tree** (directory tree) views using the toggle in the header.

## Staging and Committing

The commit bar (message input, Commit, Push/Pull) is **hidden by default** — most commits are made by your agents. Click the pencil icon in the git toolbar to show it; the choice is remembered.

1. Files appear in three sections: **Ready to commit**, **Changed**, and **New files**. The dot beside a file says which: hover it for the word.
2. Click the **+** icon on a file to include it in the commit (or **−** to exclude it); **Include all** / **Exclude all** on a section does the same for the section
3. Write a commit message in the input at the bottom
4. Click **Commit** (or use the AI-generated message)

## AI Commit Messages

Click the sparkle icon next to the commit input to generate a commit message based on your staged changes.

## Diff Preview

Click any file in the git panel to see a side-by-side diff with syntax highlighting.

## Incoming and Outgoing

The ↓ and ↑ counters on a repo are buttons: ↓ unfolds an **Incoming** section showing every file a pull will bring (all remote commits rolled into one list), ↑ an **Outgoing** section with what a push will send. Rows are read-only — click one to see the net diff — and a ⚠ marks files you also changed locally, your conflict heads-up before pulling. The sections are a pure viewing surface: syncing stays in the toolbar's pull and sync buttons.

## Push and Pull

- **Push**: Send your commits to the remote
- **Pull**: Fetch and merge remote changes

## MagicSync

One-click automated workflow that pulls, stages all changes, generates a commit message, commits, and pushes. The steps run in sequence: pulling, staging, generating, committing, pushing.

## Git Journey

Click the journey icon in the git panel toolbar to visualize your commit history. Commits appear as dots grouped by push batch. Green dots are local (not yet pushed), blue dots are pushed. Click a dot to view its diff and changed files.

## Multi-Repo Support

If your workspace contains multiple git repos (e.g., a monorepo with nested repositories), the panel auto-detects them and shows each repo as a collapsible section.

Repos are arranged as your real folder structure, not an alphabetical list: each repo sits under its parent directories, so you find it exactly where you know it lives on disk. Folder chains with nothing else in them are merged into one row (e.g. `labs/products`) to keep the panel compact.

- Click a folder row to fold or unfold that whole area — the fold state is remembered per folder.
- A folded folder rolls up what's inside it: total modified files, plus commits ahead (↑) and behind (↓) across its repos, so nothing hides while folded.
- **Collapse all** in the toolbar folds every folder and repo at once.
