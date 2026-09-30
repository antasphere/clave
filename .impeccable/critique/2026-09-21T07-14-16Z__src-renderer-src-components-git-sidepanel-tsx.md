---
target: the side panel (Files / Git)
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/lucaderumier/.antasphere/labs/products/clave/clave-app/src/renderer/src/components/git/SidePanel.tsx"
target_fingerprint: "sha256:203d2c8dd6030e04aa410f299a4b2fa4cf18e55f742168a9fc88962c93473c92"
target_path: /Users/lucaderumier/.antasphere/labs/products/clave/clave-app/src/renderer/src/components/git/SidePanel.tsx
timestamp: 2026-09-21T07-14-16Z
slug: src-renderer-src-components-git-sidepanel-tsx
---
Method: dual-agent (A: design review · B: detector + measured evidence), both on the real hidden Electron app, light theme, panel at 240px.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | "Part of alpha" printed under repo alpha on symlinked roots; disabled Pull hides its own explanation |
| 2 | Match System / Real World | 1 | M / ? / A letters, UNTRACKED, "Publish Branch (1)", "Journey", "Magic sync": every noun is git's |
| 3 | User Control and Freedom | 2 | Discard dialog titled "Discard changes" with a button that says "Delete" |
| 4 | Consistency and Standards | 3 | chrome exemplary; commit bar buttons are inline utilities; Files previews on double-click, Git opens on single click |
| 5 | Error Prevention | 1 | "Discard All" first in each section header, same weight as "Stage All", red only on hover |
| 6 | Recognition Rather Than Recall | 2 | six unlabelled icons in the git bar, three of them state toggles |
| 7 | Flexibility and Efficiency | 1 | Files tree rows are not focusable; Tab from the filter leaves the panel; ⌘⏎ undocumented |
| 8 | Aesthetic and Minimalist Design | 3 | quiet and right; "2 repos" claims a full 28px line |
| 9 | Error Recovery | 2 | raw git messages in a red strip; nothing says what to do |
| 10 | Help and Documentation | 2 | help/files.md promises single-click preview, the tree double-clicks; no route to help from the panel |
| **Total** | | **19/40** | **Needs work** |

## Design Specificity Verdict

Authored in its chrome, generic below it. The tab switch, path bar and git bar share the sidebar's material and rhythm; the root chip (S / W / G) and the sync badges as toggles are ideas no other tool has. Under that, the Git tab is VS Code's Source Control view at 12px, with VS Code's vocabulary and assumptions.

Deterministic scan: 1 finding over 8 files, `bounce-easing` at GitPanelControls.tsx:420, a conditional `animate-bounce` on the Pull arrow while a pull runs. Genuine but scoped to a busy state. Measured evidence added what the review could not see: five text nodes at 2.54:1 (light-theme `--text-tertiary` on `--surface-50`), every focus ring is Chromium's UA default in the OS accent colour, the path chip's hit box is 16px tall inside a 28px bar, and the filter's focused bar border composites to about 2.1:1.

## Priority Issues

- [P1] Discard confirmation button says "Delete" (GitStatusPanel.tsx:945, ConfirmDialog default). Fix: pass a confirmLabel that names the consequence, "Discard changes" or "Delete file" for untracked.
- [P1] "Part of alpha" under alpha on symlinked roots (GitStatusPanel.tsx:1231, SidePanel.tsx:752 compare a resolved repoRoot to an unresolved path). Fix: compare realpaths in main.
- [P1] Git tab speaks git, not the user (status letters, section names, Publish Branch, Magic sync, ↑1 without upstream). Fix: dot + tone with the word in the title, plain section names, badges only with an upstream, "Commit & push all" with a one-line confirm.
- [P1] Destructive actions first and undifferentiated (Discard All before Stage All at the same weight; row ↶ 12px from +). Fix: Discard last or behind the context menu.
- [P2] Tertiary text at 2.54:1 on light (unselected tab, branch, "Part of"). Fix: darken light-theme `--text-tertiary` to reach 4.5:1 or promote these to secondary.
- [P2] Focus rings are the UA default in the OS accent, no :focus-visible rule for panel-tab, panel-icon-btn, git-tree-row, git-sync-badge; the filter's bar-border focus is about 2.1:1. Fix: one themed focus-visible ring on the design system, accent at full alpha.
- [P2] Path bar destroys the current folder name (last breadcrumb segment truncates to "a…"; root path ellipsizes from the right). Fix: last segment flex-shrink 0, ancestors collapse first.
- [P2] Disabled Pull never shows why (native disabled button inside a Radix tooltip trigger). Fix: span wrapper or aria-disabled.

## Persona Red Flags

Alex: tree rows have no tabindex or arrow handling; Tab from the filter lands on the wordmark; scope and path menus are mouse-only.
Jordan: the S chip, six unlabelled icons, a hidden pencil before any commit, Preview vs Edit vs Open in Tab, single vs double click across tabs.
Sam (non-developer told "open Files"): Files is acceptable; one tab right is M / ? / UNTRACKED / Discard All first / a green ↑1 / a Delete button under a Discard title.

## Minor Observations

"2 repos" holds a full 28px line; Discard All / Stage All at 10px; commit bar buttons are inline utilities; the scope chip is explained only in its tooltip; the Dock nested repos control is a hand-rolled hover-only glyph; help/files.md is stale on click behaviour.

## Questions to Consider

1. If most commits are made by agents, why does the Git tab default to a staging UI at all?
2. Who decided Sam can open Git, and what happens the first time Sam presses Discard All?
3. The root chip is the panel's most original idea. Why is it spelled with one capital letter?
