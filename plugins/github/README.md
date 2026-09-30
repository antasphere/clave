# GitHub pull request panel

A bundled native plugin (`clave.github`) contributing one side-panel tab,
"GitHub", beside Files and Git. A link to a pull request on github.com
clicked in a chat opens the pull request there instead of in the browser:
title, state, branches, checks, the description, the files with their diff,
the conversation, and a composer to comment, approve, request changes or merge.
Hold ⌘ (or Ctrl, or Shift) on the link to get the browser anyway; the panel's
own "Open on GitHub" button does the same. The empty state takes a pasted link
and lists what was opened before.

It ships enabled (`BUNDLED_ON_FIRST_INSTALL` in `src/main/plugins/plugin-store.ts`),
because it is a feature of the app rather than a demo of the contract: with it
off, a pull request link is a link to the browser again, and nothing else changes.

## How it is wired

- **The panel is native.** Like the chat view, the component is compiled into
  the renderer (`src/PullRequestPanel.tsx`) and resolved by
  `src/renderer/src/components/plugins/native-panels.tsx`, keyed
  `clave.github/pull-request`; `PluginPanelHost` mounts it instead of asking
  main for a surface URL. The manifest still declares the panel and `main.mjs`
  still registers it, so enabling, disabling, the tab in the side panel and the
  Settings card are all the ordinary plugin host's. A linked plugin cannot do
  this; it contributes surfaces only, for the reason `src/renderer/src/views/README.md` gives.
- **The link click is the host's.** `src/renderer/src/lib/open-link.ts` is the
  one place a rendered link is opened from: a pull request URL goes to
  `openPullRequestFromLink` (`src/open.ts`) when the plugin is running, and
  everything else — or anything with a modifier held — to main's
  `openExternal`. The chat view calls it for every markdown link. The decision
  is synchronous, off the plugin records the plugin UI store keeps current.
- **`gh` is the process.** Main runs the user's own GitHub CLI
  (`src/main/github-cli.ts`) with the login shell's environment, so the
  packaged app finds it and the user's own sign-in is used — minus the
  shell's `GH_TOKEN` / `GITHUB_TOKEN`, which `gh` would take over the login it
  stored at `gh auth login` (`ghSpawnEnv`): a token exported for something
  else cannot see what the login can, and `gh` then reports the repository as
  not found. That token is tried once, after, only when no login is stored.
  Clave holds no token of its own. Every call answers a `GithubResult` naming the failure kind — `gh`
  missing, not signed in, or `gh`'s own words — rather than throwing, and the
  panel says which. The arguments are built in `src/shared/github-pull.ts`
  (`ghArgs`): the number and repository are validated by schema in the IPC
  handler before they reach `gh`, and every body travels on stdin
  (`--body-file -`), so a comment can never become a flag.
- **The record is `gh pr view --json`** with the field list `GH_PULL_FIELDS`,
  mapped onto `PullRequestView` by `pullRequestFromGh`; the diff is
  `gh pr diff`, split per file by `splitUnifiedDiff` and drawn with the git
  panel's own `DiffLinesView`. It is fetched only when the Files section is
  opened. Only github.com is recognised; a GitHub Enterprise host is left to the browser.

## Verification

- `npm test` — `src/shared/github-pull.test.ts` (URL recognition, the record
  mapping, the checks summary, the diff split, the `gh` argument lists) and
  the plugin store's bundled-list test.
- `node tests/e2e/run.mjs github-pull-panel` after `npx electron-vite build` —
  the real app with a stub `gh` on the PATH: the link opens the panel through
  `gh pr view`, the record is drawn, the diff is fetched on demand, a comment
  and an approval go out with the right arguments and the body on stdin, a
  merge runs behind its confirmation, other links and modifier clicks stay
  external, a `gh` refusal is shown in its own words, and a disabled plugin
  leaves the link to the browser.
