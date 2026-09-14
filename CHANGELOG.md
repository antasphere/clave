# Changelog

All notable changes to Clave are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions use [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Windows installer, back on every release** — each release now carries `clave-<version>-setup.exe` (x64, unsigned) with its `latest.yml` updater feed, so a Windows install updates itself like a Mac one. The last Windows build was v1.51.2 (June): the install step tried to rebuild node-pty from source on a runner with no Visual Studio, even though node-pty ships prebuilt binaries for Windows, and the workflow that would have shown the failure was waiting on a release event that CI-made releases never raise. The rebuild is skipped on Windows and the installer is a job of the release itself. Windows is early: agent state dots, tmux persistence and Pi sessions remain macOS-only for now.

## [1.86.0] — 2026-09-08

### Fixed
- **Update notes render as formatting, not as tags** — the update card's changelog arrived as `<h3>Added</h3> <ul> <li><strong>…` in plain visible text. The card ran the body through a Markdown renderer, but the source it reads is GitHub's releases *feed*, whose `<content>` carries each body already rendered to HTML — so the renderer escaped what it could not parse and printed the markup at the reader. The body's shape is now decided where it arrives: an HTML one is sanitised in the main process against a fixed tag allowlist (scripts, images and wrappers dropped, links forced to open in the browser) and labelled, a Markdown one is left alone, and the card renders each accordingly. The allowlist is applied a second time at the line that injects the markup, so the guard sits on the operation rather than one process away.

### Changed
- **What's in an update is a mark on the icon, not a fold in the card** — the changelog lived behind a **What's changed** disclosure inside the update card, which put reference material in the same box as the decision it interrupts: opening it grew the card and pushed *Later* and *Update* down the sidebar. The update card is one row now, always, with an ⓘ badge on its icon; hovering opens the notes in a panel beside the card and clicking pins it there, so a link can be followed or three releases scrolled without the panel closing under the pointer. Escape or a click away dismisses it. A release published with no body still shows no badge at all, rather than a control opening onto blank space.

## [1.85.0] — 2026-09-08

### Added
- **Edit beside your agent conversation** — ask Claude Code or Codex to open a linked Markdown file, HTML file or email. The conversation and editor stay together when you switch sessions, with autosaved edits and protection against conflicting changes.
- **Compose emails in Clave** — edit recipients and the rendered body, preview signatures and keep copied attachments with the draft. Set a default signature file for new emails while existing drafts retain their reviewed copy. Ask your agent to send the exact reviewed version through the configured Gmail connection.

## [1.84.0] — 2026-09-07

### Added
- **The changelog is readable before you take the update** — the update card in the sidebar named a version and asked for a 220 MB download and a restart, without saying what was in it. It could not: `help/whats-new.json` is stamped at build time and bundled, so the note describing v1.80 exists only inside the v1.80 binary, and the copy running on the machine has never held a note for the version it is offering. The one source a running app does have is the GitHub release bodies, which `electron-updater` already fetches on the availability check and threw away. `fullChangelog` is on, so a user several versions behind gets every release between theirs and the latest, newest first, rendered as markdown under a **What's changed** disclosure on the card. A release published with an empty body normalises to `null` rather than to an empty array, and the disclosure is then absent rather than opening onto blank space.

### Changed
- **Both sidebar announcements are a headline until asked** — the what's-new card printed its whole entry, which runs to several paragraphs, at a user who had not asked for it; it is a single title now with the note behind the same disclosure the update card grew. The height cap and the scroll that PRDCT's sidebar-overflow fix introduced move with the note into its expanded state, which is the point at which they matter: these cards live in the sidebar's `flex-shrink-0` announcements block, so an unbounded one pushes the session list and the foot panel off the bottom of the window with nothing to scroll.

### Fixed
- **A rendered HTML page keeps its place when you switch tabs** — click away from a rendered `.html` tab and back and the page reloaded from scratch: the scroll was at the top again and anything the page held — an open in-page tab, a filter, a chart's zoom — was back to its initial value. Only the selected file tabs were rendered, so deselecting one unmounted its frame and the whole document with it; a group's or a session's web view had the same gap. The frame is an opaque origin, so its state cannot be read out and restored; what works is never destroying it. Every open file tab now stays mounted and the unselected ones are hidden, exactly as the terminals have always been, and a web view once opened stays mounted behind whatever takes the pane — with its server probe paused while nobody is looking. A hidden pane is `aria-hidden` and takes no clicks.
- **Deleting a group stops its quick-launch terminals, and an ownerless one never comes back as a tab** — deleting a group killed its member tabs and forgot its terminals: the `npm run dev` behind the row kept running in tmux with its record on disk, and the next launch, finding no group to hang it off, adopted it as an ordinary tab. Seven mystery rows from two groups deleted the day before. Delete and Ungroup now both stop the group's terminals (members too on Delete), asking first when one is running and saying what it stops; the keybinding ungroup takes the same path and its dialog renders from the app shell, so it shows with the sidebar closed or Settings open instead of ghosting back later. At boot a hidden record whose owner is gone is discarded rather than surfaced, and every tmux kill by name uses the exact-match form, so an absent name can no longer kill its `-2` sibling.

## [1.83.0] — 2026-09-06

### Added
- **Codex usage panel** — see the account's reported usage windows, remaining capacity, and reset times in Settings → Usage.
- **Codex activity glow** — the OpenAI icon pulses blue while Codex works, including in background tabs and tmux sessions. It clears when Codex is ready, needs input, or exits. Relaunch existing Codex sessions to enable this indicator.

### Changed
- **Usage follows the active agent** — the sidebar footer shows Claude Code or Codex remaining capacity for the selected session, or today's recorded tokens and cost for Pi. Clicking it opens that provider's usage panel.

## [1.81.2] — 2026-09-05

### Fixed
- **A group added to a `.clave` file no longer multiplies by one on every restart** — append a group to a workspace file while Clave is running and the sidebar showed it once, then twice after the next launch, then three times, then four. The file was right the whole time: the pin the file watcher created for the new group carried no workspace stamp, so it landed in the state file's unstamped partition; the boot refresh then re-stamped it and wrote the workspace's partition, but never rewrote the one it had left — boot hydration had not recorded what the file held, so that partition never counted as changed. The stale copy survived, hydrated beside the re-stamped one at the next launch, was re-stamped in its turn, and the workspace partition gained one more copy of the same pin per boot. Three guards now, each sufficient on its own: the watcher stamps a new pin with the file's workspace, boot seeds the persisted-partition map so a partition a pin leaves is written back empty, and main's partition merge lets a pin id live in exactly one partition of the file. A state file already carrying duplicates is cleaned on the first launch of this build.

## [1.81.1] — 2026-09-03

### Fixed
- **Your own shell starts your agents again** — every agent on macOS was launched through `/bin/zsh` regardless of the user's login shell, which looked like a no-op and was not. `path_helper` (run by `/etc/zprofile` and `/etc/profile` alike) reorders `PATH` on every login, system directories first; a bash user's `.bash_profile` puts their own entries back in front, and their absent `.zprofile` does not. So anyone shadowing a system binary from bash — a newer `git`, a `pyenv` shim — got the system one inside every agent session, while the same command in their own terminal resolved correctly. Reproduced with a user `tar` shadowing the system one: `bash -l -c` found the user's, `zsh -l -c` found `/usr/bin/tar`, and the probed env passed to the pty does not save it because zsh reorders that `PATH` again. `resolvePosixShellLaunch` now keeps the user's shell for the wrapper whenever its basename is a POSIX one (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash`) and diverts only the shells that cannot parse it — `/bin/zsh` on macOS, `/bin/sh` elsewhere — with `-l` kept on the fallback so Linux does not lose its login shell either.

## [1.81.0] — 2026-09-01

### Changed
- **Pull all pulls what you can see, and Refresh is what goes looking** — clicking ↓ on a folder of repositories used to fetch every one of them, one after another, before pulling anything. On ninety repos that is a minute of network spent almost entirely on repositories with nothing to bring, and the button said “Fetching” the whole time: one static word, no repository name, no count, second 1 and second 90 identical — indistinguishable from a click that did nothing. The two halves are separate controls now. **↓ pulls the repositories carrying a ↓ badge**, in parallel, and nothing else — it never goes to a remote to look for work, so it finishes in about a second and does exactly what the panel showed you; with nothing badged it disables itself and says so instead of sweeping ninety remotes to find out. **Refresh**, at the foot of the panel, is the sweep: it fetches every repository in the folder in parallel, and its badges are what make the next ↓ complete. Both draw on a new progress row under the bar's controls — a track that fills as repositories finish, `12/38` at its end, and the batch's summary held there for a few seconds afterwards — so a sweep over a large tree shows its own movement instead of a spinner. Magic sync reports on the same row. Underneath, every git call that talks to a remote now carries a 20-second idle timeout (reset by any output, so a large fetch that is progressing is never cut off) and refuses to prompt for credentials, so one unreachable remote costs one repository instead of stalling the whole batch — and a fetch that fails is reported as failed rather than counting as “up to date”, which is the one answer that is certainly wrong.

### Fixed
- **An app restart no longer silently cuts running agent tabs off from Clave's tools** — an agent tab reads its MCP endpoint once at spawn and can never be re-pointed, so when a restart failed to rebind the persisted port (typically the previous instance still draining its long-lived agent connections during an update's relaunch) and silently fell back to a random one, every surviving tmux-backed tab lost `clave_*` for good — while the rewritten config files on disk read as perfectly healthy. Quit now drops those connections so the port is actually released; startup fights for the persisted port (probing the new unauthenticated `GET /health` to tell a live sibling instance — a dev run beside the installed app, which keeps its own port and is left alone — from a draining zombie, which gets up to 5 s of retries); and when the endpoint genuinely must move, the app says so: a native notification names how many running tabs are cut off and that restarting them reconnects. `scripts/mcp-health.mjs` is the companion diagnostic — run from any tab, it distinguishes "server down" from "this tab holds a dead endpoint", reading the tab's own MCP client log rather than the healed config file.

## [1.80.0] — 2026-08-31

### Added
- **Named launch profiles, and Pi as a first-class agent** — how Clave starts an agent used to be a hardcoded binary name, so anyone whose `claude` lives behind a wrapper had no way in. Settings → Agents now holds named launch profiles per family: an argument vector plus extra arguments, so `tokenops run -- env -u ANTHROPIC_API_KEY claude` is a profile like any other, picked as the global default or per workspace, and offered in the launcher's caret beside the agent it belongs to. The built-in profiles are immutable and Clave-managed flags (`--session-id`, `--resume`, `--model`, …) are refused inside a profile, so a profile can never fight the app for the same argument. Pi joins Claude, Antigravity and Codex as a supported CLI on macOS — ⌘⇧P to launch, resume from History, its own lifecycle dots via a bundled extension, its provider/model/thinking level as profile defaults, and its token usage in the Usage pane. Its boundary is written down in `docs/adr/0001`: a Pi tab can be read and messaged like any other, but Pi cannot call Clave's own tools and its exchanges are not captured.
- **Keymaps are editable, live, and can form commands** — Settings → Keymaps lists every Clave-owned shortcut, records up to two bindings per action, supports raw JSON plus import/export, and applies a valid draft to every open window only when Save is pressed. Existing shortcuts remain the defaults. `Cmd+K` is the default command-mode master key: press it and then `C` within 300ms to start a Claude session — a Cmd chord because Clave reads the key before the terminal does, so a Ctrl master would eat tmux's own prefix and the shell's cursor keys inside every session; unmatched keys are consumed and leave command mode. Bindings can be removed or reset individually, the master key can be disabled, and invalid or conflicting configuration never replaces the last valid keymap. Menu accelerators and in-app shortcut labels follow the active configuration.

### Changed
- **A new session lands at the top of the list** — where a launch landed used to depend on where you were standing: a new tab was appended at the bottom of the sidebar and, whenever your whole selection sat in one group, quietly nested into that group. So the thing you had just asked for was the thing you then had to go and find, and the group you were reading in became the group your next session joined. New sessions are now the first row of the sidebar, at the top level, whatever was selected — from the launcher, from ⌘T/⌘N/⌘I/⌘U, from ⌘⇧A. A session joins a group by being launched from that group's own `+`, which puts it at the top of that group; a newly launched pinned group lands at the top too. Two things deliberately unchanged: a **duplicate** still appears right under its original, because it is about that row rather than new work (and it now does that at the top level too, not only inside a group), and **dragging** a tab onto a group still drops it at the bottom — a hand aiming at a group is placing the row itself.
- **The wordmark stands off the traffic lights** — “Clave by Antasphere” started 16px past the last of the three macOS buttons, the same gap as the window's own gutter, so it read as crowded against them rather than as its own thing. It starts at 90px now, 22px clear — a nudge, not a step. Nothing moves in fullscreen, where there are no buttons and the mark already sits in the gutter at 16px — and on Windows and Linux, where the window keeps a native frame and its controls were never over our content, the mark now takes that same 16px instead of holding 90px of clearance for buttons that are not there. Same fix for the toolbar's own clearance with the sidebar closed. And the mark now stays put when you step into **Settings** or **Extensions**: those views replace the sessions sidebar whole and used to open with a bare spacer, so the app's one mark disappeared and the panel under it sat 2px out of step with the list it replaced. All three sidebars open with the same band now.
- **The sidebar's foot wears your own colour** — the foot panel is made of your Antasphere field, and its controls were still lighting up in the app's grey, which over a coloured ground reads as dirt on the picture rather than as a control waking up. Every control in that panel now takes its hover from the palette's own signature hue — one per palette, always a colour already in it — instead of the grey ladder used everywhere else. The panel also takes the system's 3px inset: a row exactly one control tall in a box with no padding had its button sitting ON the card's border, reading as a block cut out of the card rather than as something inside it.

## [1.79.0] — 2026-08-28

### Added
- **The side panel's default root is yours to set** — the panel's root was a fixed ladder (the focused tab's own folder, then its group's, then the workspace), so every tab in a group opened on whichever subfolder it happened to be launched in and the one folder the group is actually about was a click away on every single tab. Settings → General → Side panel → Default root now picks the rung, and it ships set to **the group**. It still falls through: the chosen rung when the tab has that folder, else the next one down, so a tab outside any group — and a window with no tab focused — lands somewhere rather than on nothing. The root chip on the panel still overrides it per tab, as before.

### Changed
- **The terminals button fits its count, and a click just opens it** — the group header's terminals button was a fixed square, so the count plus its glyph had 20px to share and the glyph was what shrank. It takes its height from the class now and grows with the count, with the padding on both edges and only when a count is actually there — which is what had been pushing that lone glyph off centre on a group with no terminals. Clicking it now opens the panel rather than toggling it: hover has usually opened it already by the time the click lands, so the toggle read as the panel refusing to open. It still closes on leaving it, on Escape, and on a click outside.
- **The space under a group header is a seam, not a padding** — a group carrying terminals and no sessions read bottom-heavy: its empty session rail still contributed 6px of dead space under the title and none over it. That rail is shut now for a group with no rows, exactly as it already was for a collapsed one, so the card is its header and nothing else. With rows, the gap over the first session goes from 4px to 2px — the header IS a row, so what sits under it is the seam between two rows rather than a container's padding, and the group reads as one stack. Measured in the app: a terminals-only card 38px → 34px, a card with one session 74px → 72px.
- **The agent caret is a proper button** — the caret beside the launcher's agent name was sized by its padding, 20px wide against the 28px of the folder picker next to it, so its hover fill read as a sliver between two real buttons instead of as a third one. Same box as its neighbours now.

### Fixed
- **The copy button on an open file copies the file** — opening a document and pressing copy put its *path* on the clipboard, on all three file surfaces: the preview sheet, the file tab, and the diff tab. That is the one thing the tree's right-click menu already offers twice, as a relative path and an absolute one, so the one gesture with an obvious meaning on an open document was spending itself on the only thing already covered. Copy now hands over what you are looking at — the file's text in the sheet and the tab, unsaved edits included, since it copies the live buffer rather than the disk, and the patch as git printed it in a diff — and flashes a check to say it happened, because a clipboard write is otherwise invisible. It is off, and says so, for what has no text to give: binaries, images, a file that failed to load.

## [1.78.0] — 2026-08-25

### Added
- **History opens on everything** — the History dialog (⌘⇧H) now lists every conversation the Mac holds: the whole Claude transcript store, whether or not Clave ever ran it, plus the Codex CLI's sessions — each conversation scoped to the current workspace by its own folder, and counted literally in the footer ("285 claude sessions · 2 codex"). Groups became filter chips over that universe rather than the universe itself. The search moved with it: one field filters the rows instantly AND searches inside the transcripts of everything in scope, through independent Human / Agent / Tools toggles (Human and Agent on by default) instead of a mode switch — Codex transcripts answer the same toggles. A Codex row is titled by its first message and searchable, resumable the day a resume exists; the sort chips and the old Titles/Everything switches are gone, leaving one quiet row of controls, and the dialog's header (the group picker's too) joins the panel family — the translucent search field, the panel's own icon buttons. One find along the way: ~80 of the store's "conversations" were Clave's own tab-title helper calls; they are recognized now and never listed again.
- **The message trail — "what was this tab about?"** — with a dozen sessions open, coming back to one meant scrolling a terminal to reconstruct the discussion. Every Claude tab now floats a small box at the top of its terminal carrying the conversation's human messages: the newest by default, chevrons to walk to older ones, a counter for where you are, and under each message the first line of the agent's final answer for that turn — the outcome, not the "let me look at…". Hovering the title reveals a chevron that opens the panel: the five surrounding turns with their times, the current one marked and reading WHOLE — a multi-paragraph prompt unclamps there, capped with its own scrollbar, while its neighbours stay one line. Clicking a message scrolls the terminal to that point in the discussion — a tmux-backed tab through copy-mode's own text search (which highlights the match; scrolling back down returns to live), a plain tab by scanning xterm's scrollback. The trail reads the live transcript itself, so it follows the conversation as it grows and survives restarts and `/clear`; the speech-bubble button in the tab's header hides it (and brings it back) everywhere at once.

### Fixed
- **A gitignored file is drawn grey from the first frame** — a file outside git's account of the folder is drawn at 40%, but the status was filled in by a second pass *after* the rows had been handed to React, so every one of them arrived at full strength and went grey a moment later. Opening a folder of build output flashed the whole listing black. It is resolved with the listing now and the row is painted once — and not asked for at all inside an already-ignored directory, where git does not descend and the parent's answer is already the children's, which is also where the round trip was longest.
- **Folders open and close instantly again** — 1.77.0 gave the file tree an unfold: rows grew in when a folder opened, and (unreleased) shrank out when it closed. It was the wrong instinct. A file tree is a thing you scan and click through dozens of times a minute, and every one of those clicks now had a wait in front of it; native trees do not do this, and the reason is that motion here is decoration, not information. Removed, both directions.


## [1.77.0] — 2026-08-25

### Added
- **Charcoal — a fourth theme, and a softer dark** — the default dark is off-black, which reads as a hole cut out of the screen. Charcoal is the same architecture painted on warm charcoal instead: one hue held at low chroma through the whole ramp so the greys are ash rather than slate, bigger steps between the surfaces because a lifted ground stops letting a 1px border do the separating, and nothing in it pure black — the modal scrim, the overlay shadows, the terminal's own ANSI black and the hairline under a selected row included. It brings its own terminal palette and source-code highlighting rather than borrowing the light theme's. Pick it in Settings → Appearance; nothing changes for anyone who does not.

### Changed
- **The wordmark sits on the middle of its strip** — the lockup's box is 905 frame units deep against Clave's 761 of ink, the rest being descender room the attribution needs and the name never uses, so centring the box put the ink 2.3px above the middle of the band. It is centred on 25px now, the middle of the 50px the launcher panel starts under.
- **The file tree's chevrons step back, and a folder unfolds** — the disclosure chevron wore the same ink as the folder icon and the name beside it, a third mark competing with two, hardest in light mode where that ink is a solid mid grey; it takes 60% of it now, derived from the icon colour so every theme follows. And opening a folder no longer inserts its children between one frame and the next: the rows grow from nothing over 160ms so the list below glides instead of jumping. Closing stays instant, and a reader who asked the OS for less motion gets neither.
- **One button size per bar, and corners that answer the box they sit in** — the chrome had two button sizes on the same row and nothing to say which was right: the toolbar's workspace-declared buttons were 28px while the sidebar toggle, the file search and the file-tree toggle beside them were 24. That is why the two panel toggles sat 4px below the toolbar's top edge but 2px in from its side — the same button with unequal air, because a smaller box cannot reach the space a bigger one does. Underneath it, `.btn-icon`'s sizes were paddings rather than boxes, so a button came out as whatever glyph it happened to hold: one `btn-icon-sm` was 24px, its neighbour 22, the × on a terminal header 20. The three sizes are fixed squares now — 20, 24, 28 — every control in the toolbar is the 28 (the secret-request key included), and a terminal header's save, plan and close are one size for the first time. The side panel's path bar follows: its root chip and collapse-all were a size under the Files/Git tabs directly above them, and are not any more. And every control that sits inside one of the app's 10px panels — the launcher's buttons and caret, the switcher's chips and search field, the panel tabs, the panel's icon buttons — takes a 7px corner instead of a 6px one. That is arithmetic rather than taste: a panel insets its contents by 3px (its 1px border and its 2px of padding), and 10 − 3 = 7 is the radius at which the inner corner is concentric with the outer one. At 6px every hover fill in the app read a shade squarer than the box around it.

### Fixed
- **The git bar's controls stay inside the panel** — six controls beside a branch name never fitted the side panel's 240px default, and the bar was told not to wrap, so the last two ran off the panel's edge and out of the window, where nothing could click them. It kept its promise of a single line by putting half its cluster out of reach. The bar is now two halves: everything that NAMES the repo — the branch glyph, the branch name, the sync badges, the parent-repo notice — is one item that takes the slack on its line and truncates inside itself, so a long branch never claims a line of its own; the controls are the other, and they move to a second line whole rather than squeezing onto the first. Dragged to the panel's 180px minimum, where a full line still cannot hold six end to end, the cluster wraps inside itself — an icon on a second row being the lesser evil next to an icon outside the panel.

## [1.76.0] — 2026-08-25

### Added
- **History: a group's past sessions, back with one click** (PRDCT-1738) — right-click a group → **History** (or ⌘⇧H for everything) and see every Claude conversation that lived in it, open or long closed: Claude Code's own title for the session, the last thing you said in it and when, the group it sat in, sorted by that last message. Click a row and the conversation comes back as a tab in the group, its whole context restored (`claude --resume`); ⌥-click skips permissions; a live one is simply focused. The link between a closed tab and its group is something Clave never kept before — the record went with the tab — so the app now writes its own small ledger the moment a session is placed or moved, whatever moved it (a drag, ⌘G, an agent), and the three days before the ledger existed are read back from the exchange capture. A group relaunched from its pin keeps its history: groups match by name as well as by id. A transcript Claude Code has cleaned up (30 days by default) stays listed, greyed, with nothing to resume. The field filters instantly on titles, last messages, folders and group names; switch its scope to **Human**, **Agent** or **Tools** and it searches *inside* the transcripts of the rows on screen — what you typed, what the agent answered, or the tools it called — streamed, cancellable, with the matching excerpt under each row.

### Changed
- **The side panel chooses its root: workspace, group, or session** — the file tree and the git panel only ever knew the focused tab's folder, so with no tab focused the panel drew nothing, and a tab deep in one repo had no way to look at the workspace around it short of the folder picker. The path bar now opens with a root chip — **W**, **G** or **S**, a letter because no icon reads as "workspace" against "group" at 12px — whose menu offers the workspace root, the group's folder and the session's own, each greyed when there is nothing on that rung (a tab outside any group, an empty window), with the folder picker under a rule since any folder is a root too. The default is a ladder, not a fixed rung: the session's folder when there is one, else its group's, else the workspace — so an empty window shows the workspace's tree and repos instead of a blank panel, and every session keeps what you picked for it until you pick again. Navigating into a subfolder, the breadcrumb and the way home all work under whichever root is chosen.

### Fixed
- **`/clear` no longer strands the tab on the conversation you just cleared** — Claude Code starts a new transcript on `/clear`, and the tab kept the old one's id, so Resume, a restart's re-adoption and now History all pointed at the cleared conversation. The tab follows the rotation, in memory and in its session record.

## [1.75.0] — 2026-08-25

### Changed
- **The group header reads `+` then the terminals** — the two controls swapped places and the count moved in front of the icon it counts, so the row ends on `+ 3 ⌨` instead of `⌨ 3 +`. The terminals panel opens to the **right** of the sidebar now rather than downwards into it: it lists each terminal's command and folder, which is wider than the sidebar and taller than the rows under it, so opening downwards covered the very groups you were choosing between. It opens level with the group's own row and clears the sidebar's edge whatever width you have dragged it to, both measured each time it opens; near the bottom of the window it still slides up to stay on screen. The count also lost the two-digit-wide box it was laid into — a single digit floated a visible gap in from the button's edge while a two-digit one filled it — and keeps 4px of deliberate air instead.
- **Every popover is one of the sidebar's boxes, lifted off the page** — the workspace switcher, the agent menu, every context menu, the file preview and the diff and journey sheets, the file palette, the commit bar's pull menu and the side panel's folder menu all sat on a surface one shade off the boxes they open from (the hover colour of their own rows, in fact), and a few of them still wore corners, borders and shadows of their own. They now share one surface — the toolbar's ground, the boxes' radius, one shadow for menus and a heavier one for the document-sized sheets — and the current row inside (the active workspace, the folder you are in) takes the sidebar's selected fill.
- **No vertical indent guides in the Files tab** — the tree carried one hairline per level down every row, which is a lot of repeated ink to say what the indentation and the chevrons already say. They are gone from the file tree and the remote file tree alike, class and palette token included; the horizontal rules between rows stay, and they are what the eye actually reads a block by.
- **The wordmark is a size up, a weight up, and says who makes it** — "Clave" beside the traffic lights is now outlined from Sentient Regular rather than Light and set on 14px of ink rather than 12.2, with **by Antasphere** beside it: a step smaller, a weight lighter, on the same baseline — and the house's name is a link, opening antasphere.com with the app named as the source. Both words are still outlines rather than type — the face may not be redistributed as a file and this repo ships a packaged app — and they share one drawing frame, which is what puts them on one baseline. Drag the sidebar under about 220px and the attribution steps aside rather than being clipped mid-letter.

### Fixed
- **A hidden session comes back as the half it is, not as a tab** (PRDCT-1756) — the session record is all that survives a quit, and it never said what its session was *for*. Every spawn writes one, so a group's `npm run dev`, a session view's serving process and a toolbar button's dev server all left a record indistinguishable from a tab's, and the boot restore adopted each as a tab: mystery rows beside the groups, while the owner showed "not running" and its start action spawned a second server on the same port. Records now carry what they are attached to — a group terminal, a session view, a toolbar button — stamped at every hidden spawn and carried across adoptions, and the restore sorts them before adopting any: hidden halves re-link to their owner and never enter the top-level order, live toolbar terminals are parked for their button to reattach, and a dead hidden half is discarded rather than resurrected as a bare shell in the same folder. A group also survives on a running quick-launch terminal alone now — a group whose tabs did not come back used to be pruned outright, which un-nested the terminal that had.
- **A group's `+` opens where the group's own tab opened** — every project group in a workspace is declared with `rootSession: true`: its tab starts at the workspace root, with the whole tree in reach, while the group's `cwd` stays the small project dir the brief's `@`-tokens point at. The `+` ignored that half of the declaration and used the `cwd`, so the second tab in a group sat one or more directories deep from the first — same group, same button, same brief, different place, and nothing on screen said so. It now reproduces the declared session whole: the brief and the directory. Groups already running pick the anchor up from the workspace file they came from, so the fix reaches them without relaunching.
- **In fullscreen the chrome stops holding a hole for the traffic lights** — macOS hides them there, so the clearance kept for them is clearance for nothing. The wordmark, which was parked in the middle of its strip behind 84px of it, moves to 16px — the x the first button would have been at. And with the sidebar closed, when it is the toolbar that runs under those buttons, the toolbar drops its own 76px too, so the sidebar toggle sits at the edge instead of a thumb's width in. Both take the clearance back on the way out, and a window restored straight into fullscreen gets it right too, not just one that enters while you watch.
- **The side panel's path box lines up with the content** — the tab bar sits level with the toolbar, and the box under it started four pixels above the terminal card's top edge, one gap short of where the sidebar's launcher lands across the other divide. It now starts on the card's edge.

## [1.74.0] — 2026-08-25

### Changed
- **The side panel's chrome sits where each control belongs** — the top bar carried the tabs *and* the folder picker, collapse-all and a help button; it now carries the tabs and nothing else, in a box the width of the two of them, centred. Everything about *where the panel is pointed* moved one row down and joined the path, which is a box of its own now rather than a bare line of text: the folder picker opens it, the path names it and drops its parents, the back arrow and the way home flank it, and collapse-all closes what it opened. The help button is gone from the panel's corner altogether — ⌘? still opens the help panel.
- **Both trees in the side panel are ruled the same way, all the way down** — the Files tab draws the same hairline between rows that the Git tab's repo tree does, at the depth of the row below it, so the two tabs read as one panel with two views. Every row but the first takes one, a folder and the first thing inside it included: that pairing used to be exempt on the theory that a line there cuts a folder off from its own contents, and in the panel it read as the one place the ruling gave out.
- **The Files tab reads at the Git tab's size** — the file tree ran on an 8px gutter and 8px per level against the git tree's 12px, so beside it the same names came out as a denser, smaller list rather than as the same tree showing different things. One gutter, one indent, one chevron and one gap across both, with the indent guides down the middle of their level's chevron column.

### Fixed
- **The sidebar's list ends on a seam at both ends** — the seam under the group switcher told you the cards scroll *behind* the chrome above them; at the bottom the list simply ran out into the foot panel. It now closes on the same hairline with the same 4px, mirrored — the line first, then the air — and only while the list actually overflows, since with nothing scrolling under the foot there is no edge for a seam to be.

## [1.73.0] — 2026-08-24


### Added
- **A trackpad tick when the drop line moves** — while dragging a session in the sidebar, each time the line snaps to a new row the trackpad gives the subtle "alignment" haptic Finder uses, so the hand feels the target change without watching the line. The tick is bound to the line itself — it fires when the rendered bar moves, never on an internal target change the eye cannot see. Powered by a tiny resident Swift helper (`resources/native/haptic-helper`, built beside the Mission Control one); silent on machines without a Force Touch trackpad.
- **Your own field at the foot of the sidebar** — the feedback card, the work tracker and the bare user button become one panel, cut from the same cloth as the launcher and the switcher at the top, so the list is bracketed by chrome at both ends instead of trailing off. Its ground is the Antasphere generative field, and your avatar is that field at full strength with the glyph knocked out of it; Settings offers a painted swatch per palette and a redraw, because no hex describes a field.
- **The foot answers "can I keep going"** — the second line stops counting minutes worked and shows your tightest usage window as percent left, with a meter that drains. Nothing names a cap: it takes whatever the service returned and shows whichever is closest to stopping you, severity first. One store serves both the foot and the Usage settings pane, so opening the pane no longer fires a second request and the refresh button moves both.

### Changed
- **One terminals button per group, and a panel for the terminals** (PRDCT-1670) — the group header no longer lays every terminal's icon out in a row that ran off the sidebar past a handful (truncating the group's name first). It now carries two controls whatever the count: a terminals button showing how many are attached, lit in a running terminal's colour, that opens a panel on hover or click — each terminal with its icon, command, folder and a running dot; click to start or focus, right-click to edit, **New terminal** at the foot — and a `+` that starts a new session in the group. The per-group "New session" row at the bottom of each card is gone: it read as one more thing to click and got clicked by mistake.
- **Slightly taller sidebar rows** — session rows and group headers went from 30px to 32px, a touch more air above and below each label.
- **Every position in a group is a drop target** — a session dragged from another group can now be dropped as the **first** or the **last** row of a group, with the line showing where it lands: every row offers a top half (before) and a bottom half (after), and the group's "New session" row is a full-height "last position" zone. Previously the first row's top half was silently redirected to "append at the end", and the last row was cut into three 10px bands, so neither edge could be aimed at.
- **Reordering to the top of a group no longer sends the row to the bottom** — dragging a row up past the first one hits the group header, which used to read as "into the group" and *append at the end*, the opposite of where the hand was going. For a row that is already in the group the header now simply means "first position" (with the line above the first row); from outside, the header still means "into the group, at the end".
- **A dragged row can always go back where it came from** — hovering your own faded row, or your group's header when you are its only row, used to fall through to "after the row above → after the group", so changing your mind mid-drag moved the row out of its group (and a single-row group could not take its row back at all — it was deleted instead). The row's own place is now always a valid target and means "stay": no line, no move. The 2px seam between two rows of a group likewise stays inside the group instead of reading as leaving it.
- **The drop line stops flickering between neighbours** — the line used to be a 36px slot *inserted into the list*, so every time it moved the rows lurched under a cursor that had not moved, and the hit-test chased its own layout (drops landing one row off, the line alternating on a midline). The line is now drawn over the seam between rows and takes no space: nothing shifts, ever. It sits centred in the seam — between two cards, never on a card's border, and never inside the card it follows — and the seam between top-level items grew from 2px to 6px to give it air; inside a group the first row's line is no longer clipped by the header. Zone boundaries also have hysteresis, and leaving a group card takes a deliberate 14px past its edge.
- **The Git tab reads like the Files tab** — a repo's files sit on the same 28px rows as the file tree above them instead of packing tighter the moment you open one, and its STAGED / MODIFIED / UNTRACKED blocks have air between them. Modified is no longer painted orange: a file you changed and a commit waiting on the remote are the normal life of a repo, not a warning, so they wear the accent and a plain informational blue. Orange is left for the one row that is genuinely a heads-up — a file an incoming change and your working tree both touch. The tree's vertical indent guides dropped off the structural border weight onto their own token, about a third as strong, so a deep folder no longer reads as a table of gridlines.
- **One chrome over Files and Git** — the bar on top carries what belongs to both tabs (the folder the panel points at, collapse-all, help) instead of one copy per tab, and under it each tab brings its own: the search field for Files, the git controls for Git. The repo tree draws its rules at the head of a block, at the depth of the row that opens it, so a folder holding repos is ruled between its folders rather than under every repo inside them.
- **The search shows you what Enter will do** — typing in the sidebar's group field now pre-selects the first chip left standing, in the state hovering it gives, so the key you are about to press has a visible target instead of being a guess you confirm by pressing it. Cmd+F reaches the field again too: the shortcut had been aiming at an attribute the rebuilt field no longer carried. The chip row also collapses when it holds no chips, instead of holding a line open to say the panel is empty.

### Fixed
- **Dragging one session no longer moves the whole group** — a drag used to carry every *selected* session, and clicking a group header selects all of its sessions (that is how you view its mosaic), so dragging any single row of the group you were looking at emptied the entire group into the drop target and deleted it. A drag now moves exactly the row under the cursor; to move several sessions at once, group them (Cmd+G) and drag the group.
- **A collapsed group no longer swallows drops aimed below it** — its hidden rows stayed in the DOM and still caught the drag hit-test, so a session dropped onto the group underneath silently landed inside the collapsed one. Hidden rows are now ignored while a group is collapsed.
- **Sidebar moves keep the layout consistent** — the move logic is now a pure, unit-tested function that guarantees a session sits in one place only (a corrupted double placement is repaired rather than propagated), a group is never nested inside a group, only a group *emptied by the move* is dropped (an agent's freshly created empty group survives), a no-op drop records no undo step, and re-taking a workspace's layout can no longer produce two groups with the same id.
- **The session list no longer dies against the group switcher** — the cards scroll behind it, and with nothing between them they slid up into its bottom border, which made the panel read as the first row of the list rather than as the chrome the list runs under. There is now the same 4px that holds the launcher and the switcher apart, closed by a hairline: the edge the list disappears at.
- **"N repos — live updates paused" is a footnote, not a warning strip** — a big tree is a fact about the folder, not a fault, so it sits folded at the foot of the panel with the current limit, a refresh and one button that opens the setting, instead of running across the top of the list you came to read.
- **The keychain read behind the usage line no longer blocks the app** — it ran through execFileSync in the main process, where a macOS access prompt would have stalled every window and every terminal behind a dialog sitting out of sight. It is async and bounded now, and a failed read retries on a short ramp instead of leaving the line absent with nothing saying why.

## [1.70.0] — 2026-08-23

### Added
- **Software Update in Settings and the menu bar** — a Software Update pane (Settings → Software Update) showing the running version, whether a newer one exists, when Clave last checked, and a Download & Install button with live progress; plus `Check for Updates…` and `Download Latest Version…` in the application menu, and the updater log under Help. The pane's two escape hatches — install the release by hand, open the updater log — are what a user has left when the updater itself cannot deliver.

### Fixed
- **An available update can no longer go missing** — the update notice was pushed to the renderer once, five seconds after launch and then every 30 minutes, and was lost outright if the window was not listening at that instant (mounting late, a reload, or a check that failed, since check failures were swallowed). Since auto-update is Clave's only distribution channel, that left a stale install with no affordance to upgrade and no way to ask. The updater's state now lives in the main process and is readable on demand, so the answer survives a restart.
- **A failed download retries itself once** before surfacing an error, instead of asking the user to press Retry for what is usually a dropped connection.
- **A failed update *check* no longer hides or over-reports** — it is shown in the Software Update pane rather than discarded, and it can no longer raise the full-screen "Update failed" overlay over an app that is working fine.

## [1.64.0] — 2026-08-09

### Added
- **Server buttons in the toolbar** — a quick-launch terminal that declares a `serverUrl` in its `.clave` file becomes a service button: one click means "make this server exist and take me to it". If the server is already up (even started by hand, or still running from before a Clave restart) the browser opens instantly with no respawn; if it is down, the command is rerun in its terminal and the browser opens the moment the URL appears — following the server if it comes up on a different port. The button shows a live status dot (up / starting / down), and right-click or ⌥-click opens just the terminal popover.

### Changed
- **Workspace auto-discovery is faster and looks deeper** — the scan now stops descending into a project once its workspace file is found (a workspace defines its whole repo), which makes the walk cheap enough to search six levels deep instead of four, and directory reads no longer block the app.

### Fixed
- **Discovery works when the workspace root has its own `.clave/workspaces/`** — a root-level workspace definition used to stop the entire scan at depth zero, so no projects were found.
- **Toolbar terminals reattach and sync reliably** — a persistent terminal whose process died while its popover was closed no longer leaves a stale reattach reference, and editing a pinned group no longer silently drops `cwd`, `autoLaunchLocalhost`, or `persistent` from the backing `.clave` file.

## [1.63.0] — 2026-08-08

### Added
- **Markdown pages are directly editable** — page mode is now a Notion-style writing surface: click anywhere and type. Typing `# `, `- `, `> ` or ` ``` ` converts blocks live, checkboxes toggle with a click, tables edit cell by cell, and code blocks edit inline with syntax highlighting. Edits save back as clean markdown (⌘S or the Save button, exactly like source mode), frontmatter is preserved untouched, and Preview keeps its read-only render. Files the editor can't represent fall back to the read-only page with a hint to use Source.

### Fixed
- **No stale content when switching files** — the file preview and file tabs now clear the previous file's content immediately when switching to another file, instead of briefly showing the old file while the new one loads.

## [1.62.0] — 2026-08-04

### Added
- **Markdown opens as a page** — markdown files now render as a document-style page by default: a centered reading column with generous margins and a real typographic scale, with YAML frontmatter hidden and its title shown as the document title. The compact preview and the raw source editor remain one click away via a new Page / Preview / Source switcher, in both file tabs and the floating file preview.

### Changed
- **One header row for file tabs** — the file tab header now fits everything in a single row: file name, full path, the view switcher, save state, and actions. Previously these were spread across three stacked rows.

## [1.61.2] — 2026-08-03

### Fixed
- **Edits to `.clave` workspace files are picked up reliably** — the file watcher went silent after the first change when an editor or agent saved the file by replacing it (the common case), so later edits never reached the app until a restart. Clave now watches the containing folder instead, which survives those saves.
- **Adding or removing a group in a `.clave` file updates your pinned groups live** — a group added to the file now appears as a pin without restarting Clave, and pins whose group was removed from the file are dropped (running sessions are never touched). Previously only existing groups were refreshed.
- **Unloading one group of a multi-group workspace file no longer stops updates for its siblings** — removing a single pin used to detach the file watcher shared by every group in that file.

## [1.61.1] — 2026-07-30

### Fixed
- **Renamed sessions keep their name after a crash or reboot** — a tab you renamed used to come back labelled with its folder name if Clave went down without quitting cleanly. Names (yours and the auto-generated ones) are now saved to disk the moment they change and restored with the session.

## [1.61.0] — 2026-07-21

### Added
- **Agents can show you files and notify you** — two new MCP tools for the agents running in your tabs. `clave_open_file` lets an agent open a file (a plan, report, or document it produced) as a regular file tab so you can read or edit it right away; opening the same file twice just refocuses the existing tab. `clave_notify` lets an agent fire a native macOS notification when long-running work finishes in a tab you are not looking at — clicking the notification jumps you to that tab, and nothing is shown if you are already there.

## [1.60.2] — 2026-07-08

### Fixed
- **"Give us feedback" now sits directly above your profile** — the collapsed feedback link moved into the sidebar footer, so it follows the same spacing as every other row there instead of hovering above it.

## [1.60.1] — 2026-07-08

### Fixed
- **The "Give us feedback" line no longer floats above your profile** — once the feedback prompt is collapsed, the remaining one-line link now sits flush against the sidebar footer instead of leaving an odd gap below it.

## [1.60.0] — 2026-07-08

### Added
- **Talk to us** — Clave has no accounts, so we have no idea who uses it or how. A prompt in the sidebar now invites you to book a 30 minute call or leave your email, so we can learn what to build next. It collapses to a single "Give us feedback" line that stays available whenever you want to reach us, and never expands again. Nothing you send is linked to the anonymous usage ping: we still cannot tell which install is yours.

### Fixed
- **Activating your first workspace no longer leaves stale pins behind** — if you already had pinned groups before adding a workspace, Clave snapshots them into an "Init" workspace. That snapshot is now correctly unloaded when you activate another workspace, instead of leaving the old pins on top of the new ones with no way to unload them. The Init workspace also stops disappearing from Settings → Workspaces right after it is created.

## [1.59.0] — 2026-07-03

### Added
- **Mission Control overlay** — when you open macOS Mission Control or App Exposé, Clave now covers its window with a blurred overlay bearing a large Clave mark, so you can spot it instantly among all the thumbnails. It needs no Accessibility or Screen Recording permission, and you can turn it off under Settings → Appearance.
- **Primed sessions in `.clave` workspaces** — a session in a `.clave` file can now carry a `prompt` that Clave types and submits to the agent automatically the moment the session launches, plus a `rootSession` flag that starts the session at the workspace root while still targeting the project folder. Prompts understand `@root_path`, `@project_path`, and `@project_abs` tokens that expand to the right paths at launch, and duplicating a primed session replays it as-is.

## [1.58.0] — 2026-06-28

### Changed
- **Antigravity CLI replaces Gemini CLI** — Google retired the standalone Gemini CLI on June 18, 2026 and folded it into the new **Antigravity CLI**. Clave's **Cmd+I** shortcut, the **New session** menu, and the **Usage** panel now launch and show **Antigravity CLI** (the `agy` binary) with its brand mark instead of Gemini. Your existing Gemini sessions, pinned groups, and `.clave` files keep working and reopen as Antigravity automatically.

## [1.57.0] — 2026-06-16

### Added
- **Manage plugins from Extensions** — the Extensions view can now install and uninstall plugins, enable or disable them, and add or remove marketplaces directly, instead of being read-only. Open a marketplace to **Install** any plugin it offers (or **Remove** the marketplace), open an installed plugin to **Enable / Disable** or **Uninstall** it, and use **Add marketplace** to register a new one from a GitHub repo, git URL, or local path. Disabled plugins are flagged so you can tell them apart at a glance. Changes apply the next time you start a Claude session.

## [1.56.1] — 2026-06-15

### Fixed
- File previews no longer get stuck — opening a longer file (`.json`, `.sh`, `.clave`, and other code files) from the file panel is scrollable again instead of clipping the content below the fold.
- Opening a template from the template picker now always spawns a fresh group. Previously, deleting a template-spawned session from the sidebar could leave the template stuck — clicking it again only flashed its colour dot and never reopened it.

## [1.56.0] — 2026-06-15

### Added
- **Trusted workspace folders** — adding a workspace folder now trusts it as a root, so every `.clave` file discovered inside it opens without re-prompting. No more repeated warning dialogs when you run many workspaces or when Clave (or a `git pull`) rewrites a `.clave` file. A new **Trusted workspace folders** card in Settings lists your trusted roots and lets you revoke any of them, and existing workspaces are trusted automatically on upgrade. Files opened from outside any trusted folder still ask for confirmation as before.

### Changed
- The group terminal folder picker now opens at the group's root folder instead of your home directory.

## [1.55.0] — 2026-06-13

### Added
- **Extensions** — a new view (under New Session in the sidebar) that shows everything installed for a Claude Code profile. Browse your **Marketplaces** as cards, drill into one to see its **Plugins**, then open a plugin to see its **Skills, Agents, Commands, and MCP servers**. A separate **MCP Servers** tab lists every server across all sources, and a **Standalone** card surfaces skills and commands that don't belong to any plugin. With multiple Claude accounts, a profile dropdown scopes the whole view to that account.

### Removed
- **Task Queue** — the Queue view for staging prompts and running them later as Claude sessions has been removed.

## [1.54.0] — 2026-06-12

### Added
- **Anonymous daily usage ping** — Clave now sends one anonymous ping a day (a random ID, the app version, and your platform — nothing else) so we know how many people use it. A first-run notice explains it with a one-click "Turn off", and a new **Privacy** section in Settings → General lets you toggle the ping at any time. The README's "Privacy & network" section documents the exact payload.

## [1.53.0] — 2026-06-12

### Changed
- **Settings is now a full page with its own sidebar.** Opening Settings swaps the session list for a dedicated navigation — General, Appearance, and Usage — with a back button to return to your sessions. Usage moved inside Settings, and options are presented in grouped cards with slim, compact controls for a cleaner, denser look.
- The sidebar footer is a slimmer single row: clicking it (or its gear icon) opens Settings directly instead of showing a popup menu, and the separator line above it is gone.

## [1.52.0] — 2026-06-12

### Added
- **Agents can now drive Clave through an in-app MCP server.** A Claude session can open new agent tabs (with an initial prompt) and launch your pinned workspace groups directly, so a coordinating agent can set up and hand off work across tabs without you wiring it up by hand.
- **Private secret injection** — an agent can ask for a secret (an API key, a token) without it ever appearing in the chat. The request shows up in the toolbar, you review the exact action and paste the value into a masked field, and Clave injects it scoped to that one action. The agent never sees the secret.

### Security
- Hardened remote connections: OpenClaw connections can now use encrypted transport, the OpenClaw access token is stored encrypted on disk instead of in plain text, and SSH connections now verify the server's identity (pinned on first connect) to guard against machine-in-the-middle attacks.
- Workspace (`.clave`) files that try to run commands automatically or start an agent with permission prompts disabled now ask for your confirmation before doing so — unless you created or already trusted that file — so opening a workspace shared by someone else can't silently run code.
- Links opened from terminal output and previews are now restricted to web and email addresses, closing a trick where a link could be made to display one destination but open another.

### Changed
- Smoother, snappier session list and agent chat: the sidebar and streaming responses do far less redundant work, so they stay responsive with many sessions open and during long agent replies.
- The toolbar's open-URL tags no longer show a scrollbar when scrolled horizontally on a trackpad.

## [1.51.3] — 2026-06-09

### Fixed
- The Files panel now shows files that were added while a folder was collapsed. After the recent change to watch only the folders you can see, a folder you had expanded and then collapsed kept showing its old contents — anything added inside it while it was collapsed (for example by a long-running agent) didn't appear when you expanded it again. Expanding a folder now re-reads it from disk, so its contents are always up to date.

## [1.51.2] — 2026-06-09

### Fixed
- You can now select and copy text from a terminal's scrollback. Previously, scrolling up and then pressing the mouse to highlight text snapped the view straight back to the bottom, so the selection never started. Pressing no longer jumps to the bottom — drag to highlight, and releasing copies the selection to your clipboard. The fix also applies to sessions that were already running, without needing to restart them.

## [1.51.1] — 2026-06-08

### Added
- In folders with many repositories, you can now control when the Git panel pauses live updates. A new **Git** section in Settings lets you raise the "pause above N repos" threshold or turn pausing off entirely so live updates always run.

### Fixed
- The Git panel no longer feels frozen in large folders where live updates are paused. Committing in a subfolder used to leave the panel unchanged until you manually refreshed, which made it look like nothing had happened. The panel now refreshes itself automatically when an agent finishes a turn and when the window regains focus, and the paused banner shows the last update time plus a spinner while refreshing — so you can always tell it's current.

## [1.51.0] — 2026-06-08

### Fixed
- The Files panel no longer spikes CPU when opened on a very large folder (e.g. your home directory or the filesystem root). It previously watched the entire folder tree recursively for changes — on a huge tree that means reacting to every file change anywhere on disk. It now watches only the directories you can actually see (the current folder plus the ones you've expanded), adding and removing watches as you expand and collapse, so the cost scales with what's on screen rather than what's on disk.
- The Git panel no longer spikes CPU when opened on a very large folder (e.g. your home directory or the filesystem root). Repo discovery is now bounded and cached: it skips system and dependency directories, finds repos breadth-first so shallow repos surface quickly, stops cleanly on huge trees instead of crawling everything, and reuses earlier scans — opening a subfolder of an already-scanned folder costs nothing, and scanning a parent reuses what it already knows about its children. Status and fetch updates run with a capped number of parallel git calls, and in folders with many repos (50+) live polling is paused in favor of a manual Refresh, shown in a small banner. The Git panel only does this work while it's open.
- Sessions now come back after a reboot, not just after quitting and reopening. Persistent (tmux) sessions live in a background process that a shutdown or restart kills, so previously they were lost on the next launch. Clave now keeps each session's details on disk and, when it finds the tmux process gone, re-opens the tabs in their original folders automatically. Claude Code sessions also resume their previous conversation.

## [1.50.1] — 2026-06-06

### Fixed
- Groups now survive quitting and reopening Clave. Previously, when persistent (tmux) sessions reattached on launch, the sessions came back but their groups were lost — a group's sessions and attached terminals reappeared loose in the sidebar. Groups (with their names, colors, terminals, and ordering) are now saved to disk and restored around the reattached sessions, surviving a crash or force-quit as well as a normal quit.

## [1.50.0] — 2026-06-06

### Added
- **Claude Code accounts** — run sessions under different Claude accounts side by side. Define named accounts in Settings → Claude Code accounts, each pointing at its own config directory, and once you have more than one a picker appears when you start a Claude session (hover Claude Code / Claude Agents in the New Session menu). The keyboard shortcuts use your selected default account, and each session's header shows which account it's running under. New accounts start signed out — the first session on one runs Claude's normal login. With a single account, nothing changes.

## [1.49.0] — 2026-06-05

### Added
- **Persistent sessions (tmux)** — sessions now run inside a tmux session, so your agents keep running after you quit Clave, survive crashes, and reattach automatically on the next launch. They're also reachable from any terminal with `tmux -L clave attach`. On by default when tmux is installed (sessions fall back to normal otherwise); you can turn it off in Settings → Sessions.

## [1.48.0] — 2026-06-05

### Added
- Claude Code session tabs now show their live status at a glance: the icon turns blue and pulses while Claude is **working**, an amber dot appears when Claude is **blocked** waiting for your input (a permission or selection prompt), and a green dot marks a session that **finished while you were away** — clearing as soon as you open the tab. Idle and freshly-started sessions stay clean. Status is driven by Claude Code's own lifecycle signals, so it's accurate rather than guessed. Gemini and Codex sessions stay neutral for now (see ROADMAP.md).

## [1.47.1] — 2026-06-04

### Fixed
- Screenshots dragged into a session straight from the macOS preview thumbnail are now copied into stable storage on drop, so the agent can still read them after macOS removes the original temporary file. Old copies are cleaned up automatically after 7 days.

## [1.47.0] — 2026-06-04

### Added
- New **Claude Agents** session type that launches `claude agents` instead of plain Claude Code — available from the New Session menu and with the **⌘⇧A** shortcut
- The three Claude session types are now distinguishable at a glance in the sidebar: a faint trailing glyph marks **Claude Agents** (bolt) and **skip-permissions** (shield) sessions, while plain **Claude Code** stays unmarked — the Claude logo itself is left clean

## [1.46.0] — 2026-06-04

### Changed
- Redesigned the remote agent conversation view: your messages now sit in a clean rounded bubble, the agent's replies flow as plain text for easier reading, and the whole thread is centered in a comfortable reading column
- New message composer with a rounded input and a circular send button that blends into the conversation background for a calmer, more focused look

## [1.45.1] — 2026-06-04

### Changed
- Remote sessions now show their provider's logo in the sidebar (Claude Code, Gemini, Codex, or terminal) instead of a generic globe — the server-name badge already marks them as remote, so they now read just like local sessions
- The remote file tree now matches the local file tree's design — same row height, spacing, icons, and font size
- Refreshed the remote folder picker (shown when opening a session on a remote server) with a cleaner layout, Up and Home shortcuts, an editable breadcrumb path, keyboard navigation, and polished folder rows

### Fixed
- The remote server-name badge in the sidebar no longer crops longer names at a fixed width — it now grows to fit and truncates with an ellipsis, with the full name on hover

## [1.45.0] — 2026-06-03

### Changed
- Sidebar sessions now show their provider's actual logo — Claude Code, Gemini, and Codex sessions each display their brand mark instead of a generic icon. Claude sessions use the Claude logo whether or not permissions are skipped, and plain terminals keep the terminal icon

## [1.44.0] — 2026-06-03

### Changed
- The **Settings** page is now centered for a more balanced layout that matches the rest of the app
- Polished the **Settings** page to match the rest of the app — consistent buttons, fonts, inputs, and list rows (the **Add Location** and **Add Workspace** buttons now look identical)

### Fixed
- The **Git** panel now names the parent repository when the folder you opened isn't itself a git repository, so it's clear why changes from outside that folder appear
- Opening the **Add Location** dialog now dims the whole window, including the **Git** panel, instead of leaving it bright

### Removed
- Removed the **App Icon** picker from Settings (only one icon was ever applied)
- Removed the **Launch Templates** feature — use `.clave` workspace files and session templates instead

## [1.43.1] — 2026-06-02

### Changed
- The **Sessions** header's templates button now uses a tiles-with-plus icon instead of a folder-plus icon, so it reads as "launch from a template" rather than "add a folder"

## [1.43.0] — 2026-06-02

### Added
- Files now open in a real code editor — syntax-highlighted **and** editable the moment they open, with no separate "Edit" step. Just click into the code, type, and press ⌘S to save. Highlighting now follows your theme (dark, light, and coffee), so code looks at home instead of washed out
- Markdown files open rendered, with a **Preview / Source** toggle to edit the raw text

### Changed
- The file preview panel and the file tab now share one editor, so they look and behave the same everywhere
- When a file is open in a tab, the path row shows a live save-status indicator — a **Save** button (with the ⌘S hint) while you have unsaved edits, and **Saved** once it's up to date — instead of a separate Save button above the file
- Closing the preview panel while you have unsaved edits now asks before discarding them, instead of silently dropping the changes

## [1.42.2] — 2026-06-01

### Fixed
- Right-clicking an open file in the sidebar now shows icons next to **Copy Path** and **Reveal in Finder**, matching the other items in the menu and the rest of the app

## [1.42.1] — 2026-05-29

### Fixed
- The session templates grid no longer randomly reappears in the sidebar after dragging a file in and out — the file-drop target now reliably disappears once a drag ends

## [1.42.0] — 2026-05-27

### Added
- Session templates (your `.clave` workspaces) now open from a **folder-plus icon** next to the **Sessions** header, in a searchable popover — so having lots of templates no longer pushes your session list down the sidebar. Click a template to launch it; active ones stay highlighted. You can still drag a group or drop a `.clave` file onto the sidebar to pin a new one

### Changed
- The templates popover, the **New session** menu, and the user menu now open just to the right of the sidebar divider, and the Sessions header's action icon lines up with the row icons below it

## [1.41.1] — 2026-05-26

### Changed
- The file action buttons in the preview panel (open in tab, open externally, edit, copy path, close) and every option in the file right-click menu now use the same Heroicons as the rest of the app, so the file panels look consistent with the session menus

### Fixed
- Right-click menus no longer get cropped near the screen edge — they now open leftward when close to the right edge and upward when close to the bottom

## [1.41.0] — 2026-05-26

### Added
- **Codex CLI** sessions — launch OpenAI's Codex CLI straight from the New session menu (or press Cmd+U), the same way you start Claude Code or Gemini CLI. Codex sessions get their own OpenAI mark in the menu and a chip-style icon in the sidebar, and they're remembered in pinned groups, templates, and `.clave` workspace files
- The file tree now shows distinct icons for more file types: spreadsheets and tables (`.csv`, `.tsv`, `.xls`, `.xlsx`), `LICENSE`, `.gitignore`, `.json`, `.yml`/`.yaml`, `README.md`, and files with no extension each get their own icon instead of the generic document

### Changed
- The **New session** menu now opens to the right of the New session tab instead of dropping straight down, matching how the user menu in the sidebar footer opens

## [1.40.0] — 2026-05-25

### Added
- When you select a session, group, or file tab in the sidebar, the unselected rows now fade back so your active selection stands out by contrast. Dragging still takes visual priority over the fade
- The help docs now cover **Gemini CLI** sessions (Cmd+I) — the shortcut, the session type, and its star icon are documented alongside Claude Code, Terminal, and Dangerous mode

### Removed
- Dropped the stale **Cmd+F "Focus sidebar search"** entry from the shortcuts help — the sidebar search box was removed in 1.39.0, so the shortcut no longer exists

## [1.39.0] — 2026-05-25

### Changed
- The sidebar has been reorganized for a cleaner, more consistent layout. **New session** (now a pencil-square tab) and **Queue** sit at the top as permanent tabs, your sessions live under a single **Sessions** header, and pinned groups appear inline beneath it. Tab heights, row spacing, leading/trailing icon padding, and corner roundness are now driven by shared design tokens, so rows line up and the whole app feels a touch tighter and less round. Group and pinned cards align to the same width as normal tabs, and a selected tab inside a group no longer looks like it touches the card border
- The sidebar search box and the reset button were removed from the top of the sidebar

### Removed
- The **model-info pill** and the **context-inventory pill** in the terminal header have been removed. These started as a community contribution, and we're grateful for it — the removal is not a judgment on the work. Claude Code now reports the same information natively in its own statusline (active model, reasoning effort, thinking, context-window size and the live context-fill percentage), so the pills duplicated what CC already shows. The context-inventory pill in particular could mislead: it estimated a static footprint of your config files against a guessed context window (often 200k even on 1M-context models), whereas CC's statusline reports true live usage against the real window. To let CC's native statusline show through, Clave no longer injects its own `statusLine` hook into sessions — your configured statusline (or CC's default) now appears directly, unmodified
- The **Daily Log** sidebar widget (the per-project session journal with daily/AI summaries) has been removed, along with its Settings toggles and the background session-summarization it ran. It watched every session lifecycle change and summarized completed sessions, costing CPU for a feature that did not work reliably. The matching Settings options and help docs are gone too
- The **History** sidebar section and panel (browse/search past Claude Code conversations) has been removed, along with the underlying transcript reader and IPC. It overlapped with browsing your sessions directly, and the conversation transcripts remain on disk under `~/.claude` for any external tooling that wants them

## [1.38.1] — 2026-05-22

### Fixed
- Gemini CLI session tabs now use a clean star icon that matches the other tab icons, instead of the previous heavy custom glyph that looked out of place and garbled at small sizes

## [1.38.0] — 2026-05-15

### Added
- The Git panel now shows a **Publish Branch** button when you're on a branch that has no upstream — committing on a new local branch used to look silent because the Push button only appeared when `ahead > 0` relative to a remote, which an unpublished branch never has. The Publish Branch button replaces Push in that state, shows the unpublished commit count, and runs `git push -u origin <branch>` so the branch is tracked from then on

## [1.37.3] — 2026-05-15

### Fixed
- Claude Code's welcome banner now renders at full width when you spawn a session, instead of appearing as a mangled sliver. The PTY used to be born at a fixed 80×24, so the welcome banner was laid out for 80 columns and then garbled when xterm reflowed to your actual terminal width. The PTY now waits until the terminal has measured itself before starting Claude, so the banner is laid out for the real width from the start
- Your custom `statusLine` from `~/.claude/settings.json` is now preserved inside Clave sessions — Clave's own status hook used to override it entirely, hiding the context-fill bar and any other bottom-bar metadata you'd configured. Clave now chains the user's statusLine command through its hook so both Clave's pills and your own bottom-bar appear
- The bash interactive prompt, macOS "default shell is now zsh" notice, and the echoed `claude …` command no longer flash on screen at session start — Claude is now exec'd directly by a non-interactive shell

## [1.37.2] — 2026-05-11

### Fixed
- Terminal text no longer gets duplicated, truncated, or mojibaked when you toggle the sidebar / file tree or view sessions side-by-side — Framer Motion's panel animation used to fire dozens of SIGWINCH signals to the PTY during a single resize, causing Claude Code to repaint the conversation into the scrollback over and over. The PTY now receives exactly one resize at the settled size, so the conversation stays readable and scrollback isn't bloated with duplicates

## [1.37.1] — 2026-05-04

### Added
- Cmd+Z in the sidebar now undoes the last group/move/rename/recolor action — accidentally disbanding a group or dragging a session into the wrong place is no longer permanent

## [1.37.0] — 2026-05-03

### Added
- Windows installer is now built and attached to every GitHub Release automatically — Windows users can download a `.exe` setup alongside the macOS `.dmg`/`.zip`

## [1.36.1] — 2026-04-24

### Fixed
- Model / effort / context pills now appear in the packaged app — the statusLine hook script was looked up at the wrong path inside the bundle, so the hook never registered and the pills stayed empty (they only worked in `npm run dev`)

## [1.36.0] — 2026-04-24

### Added
- Model pill in the terminal header surfaces the active Claude Code model (e.g. "Opus 4.7") at a glance — click it to open a popover with the full session config: raw model id, reasoning effort, thinking on/off, fast mode, context window size, output style, agent, and live session cost
- All values stay live via Claude Code's documented `statusLine` hook, so running `/model`, `/effort`, or `/fast` inside the session updates the pill on the next status refresh

### Fixed
- Context Inventory now reports usage against the real 1M context window on extended-context sessions instead of clipping at 200k

## [1.35.7] — 2026-04-23

### Fixed
- File tree no longer collapses all open folders when you switch to the Git tab and back — expansion and filter state now survive the round-trip
- Terminal no longer gets left in a cramped or mis-sized state when opening or closing the file tree, git panel, or sidebar — the final fit now waits for the panel animation to settle and refreshes the viewport to clear any leftover glyphs

## [1.35.6] — 2026-04-22

### Fixed
- Save discussion now finds the right transcript even after `/clear`, `/compact`, or `/resume` rotates Claude's session UUID — it falls back to matching by the session id recorded inside the JSONL, then to the most recently modified JSONL in the project folder
- Save discussion and Save plan now show a clear error dialog when the transcript can't be found, instead of silently doing nothing
- Save discussion and Save plan now work for remote Claude sessions — the transcript is fetched from the remote host over SFTP instead of being looked up only on the local disk

## [1.35.5] — 2026-04-20

### Added
- Multi-repo git panel: hovering a repo name for ~2 seconds reveals a tooltip with the shortened full path, making it easy to tell apart repos with the same name

## [1.35.4] — 2026-04-17

### Fixed
- Generate commit message now retries once on transient failures and falls back to Sonnet when Haiku is overloaded, so the "Command failed" error that appeared ~50% of the time should be much rarer
- Commit message generator now surfaces the real underlying error (including stderr) when the Claude CLI fails, instead of a truncated generic message
- Bumped the commit message generation timeout from 30s to 60s to cover slower Haiku responses

## [1.35.1] — 2026-04-16

### Fixed
- Generate commit message no longer fails when changes are already staged — previously it tried to re-stage all files including already-staged ones, causing pathspec errors on renamed or moved files

## [1.35.0] — 2026-04-14

### Fixed
- Context Inventory popover no longer flashes to the top-left corner when you open a new session (Cmd+T / Cmd+D) with the popover open — it now vanishes cleanly as the session hides

## [1.34.3] — 2026-04-14

### Fixed
- Context Inventory popover no longer closes when you click inside it (e.g. expanding Skills or Agents) — removed an over-eager window-blur handler that was firing on focus transitions between the terminal and the popover

## [1.34.2] — 2026-04-14

### Fixed
- Context Inventory no longer shows the same plugin, skill, or command multiple times — it now reads the active install list from `~/.claude/plugins/installed_plugins.json` instead of walking every cached version on disk, and honours `enabledPlugins` plus local-scope `projectPath` so only plugins Claude Code would actually load for the current session are counted

## [1.34.1] — 2026-04-14

### Fixed
- Context Inventory popover no longer drifts to the top-left of the screen when switching sessions or opening a new Clave window — it now closes automatically when its session is hidden or the window loses focus
- Close (×) button on the Context Inventory popover now reliably dismisses it

## [1.34.0] — 2026-04-14

### Added
- **Context Inventory popover** per session — click the database icon in the terminal header to see what Claude Code loads at session start (CLAUDE.md chain, skills, plugins, commands, agents, MCP servers, hooks, project memory) with estimated token cost and percentage of the context window
- Always-on percentage badge next to the inventory icon so you can see your context fill at a glance without opening the popover (subtle under 40%, amber at 40–70%, red at 70%+)
- Stacked category bar and colored legend at the top of the popover, making it instantly obvious which bucket is dominating your context
- Per-row proportional fill bars inside each category so the heaviest entries stand out without having to read numbers
- Info tooltip in the popover with quick tips for reducing context (`/plugin`, `/clear`, `/compact`, `~/.claude/settings.json`)
- In-app help page (Help → "Context Inventory") explaining what's measured, what isn't (e.g. MCP runtime tool schemas), and the read-only design philosophy
- Addresses [issue #9](https://github.com/codika-io/clave/issues/9)

## [1.33.0] — 2026-04-14

### Changed
- Daily Log redesigned for at-a-glance readability: 7-day week strip with heatmap intensity, stat cards for time/sessions/projects, and a timeline view of entries coloured by project
- Entry cards get a unified card layout with clearer hierarchy — project chip, entry name, time range, and parsed summary with bullets
- New Timeline / By project toggle lets you switch between a flat chronological feed and the project-grouped view

## [1.32.6] — 2026-04-13

### Added
- Open git diffs as document tabs from the git panel — "Open as tab" button in the diff preview header, and a right-click "Open as tab" option on any changed file in the git tree
- Diff tabs live-update on stage/unstage and git refresh, and keep Stage/Unstage actions inline
- Same file can coexist as multiple tabs: file content, unstaged diff, staged diff, and per-commit diff

## [1.32.5] — 2026-04-11

### Fixed
- Announcements container (What's New / Update banners) no longer adds bottom padding when empty

## [1.32.4] — 2026-04-11

### Added
- Daily cost bar chart on the Usage page with Day, Week, and Month views
- Day view shows hourly cost breakdown (24 bars), replacing the old Activity by Hour grid
- Week and Month views show daily cost with navigation between periods
- Hover reveals exact cost per bar with smooth fade animation

### Changed
- Usage data now computes accurate daily cost from per-category token breakdowns (input, output, cache read, cache creation) instead of a single total
- Model breakdown component is now full-width

## [1.32.3] — 2026-04-10

### Changed
- Moved What's New and Update banners above the sidebar footer, appearing on top of sessions and the divider bar

## [1.32.2] — 2026-04-10

### Changed
- Usage panel: replaced 30-day bar chart with a GitHub-style contribution heatmap showing a full year of activity
- Heatmap uses percentile-based intensity levels with theme-aware accent colors

## [1.32.1] — 2026-04-10

### Changed
- Light theme refreshed with Linear-inspired warm grays instead of pure neutral grays
- Accent color updated from bright blue to Linear's indigo-violet (#5e6ad2)
- Color palette (profile avatars and group colors) replaced with muted, desaturated tones matching Linear's aesthetic

## [1.32.0] — 2026-04-10

### Changed
- Work tracker redesigned: merged into unified sidebar footer section as a single clickable line instead of a floating card
- Clicking the work tracker now navigates directly to the full Usage page
- Time tracking now shows wall-clock time instead of summing concurrent sessions independently

### Fixed
- Work tracker could show impossible values like "18 hours yesterday" due to a heuristic that multiplied message counts by 2 minutes
- Concurrent sessions inflated today's total (3 sessions for 1 hour showed 3h instead of 1h)

### Removed
- Yesterday summary, weekly chart, and token costs from the work tracker widget (available in the Usage page instead)

## [1.31.0] — 2026-04-10

### Added
- Design system: semantic CSS tokens for sidebar items, buttons, inputs, badges, and icon buttons in main.css
- History conversation view: chat bubble layout with user messages right-aligned and assistant messages left-aligned
- Conversation turn grouping: assistant messages and tool results merged into single visual blocks

### Changed
- Queue panel redesigned to match History list layout (centered content, hover rows, no dividers)
- Sidebar spacing tightened (4px gaps) and count badges removed from History and Daily Log tabs
- All buttons, inputs, badges, and icon buttons across 35 components now use shared design tokens
- Border radius standardized (icon buttons use rounded-md, dialogs use rounded-xl)
- Dialog footer buttons unified with btn-dialog class
- What's New banner relocated to sidebar

### Fixed
- Inconsistent spacing between sidebar items (session tabs vs activity tabs)
- Arbitrary shadow values replaced with design system tokens
- AddLocationDialog used rounded-2xl instead of rounded-xl like other dialogs

## [1.30.0] — 2026-04-10

### Added
- AI Journal: daily work tracker with smart session summaries powered by Claude Haiku
- Journal accessible from Activity section in sidebar, renders in full-width main content area

### Changed
- Help moved from side panel tab to standalone ? toggle button
- Side panel tabs (Files/Git) use consistent active state via effectiveTab

### Fixed
- WhatsNewBanner dismiss stored wrong version, causing banner to re-show
- will-navigate dev fallback matched all URLs when ELECTRON_RENDERER_URL unset
- setWindowOpenHandler now blocks non-HTTP schemes from shell.openExternal
- Toggle knob asymmetric padding on settings switches

## [1.29.0] — 2026-04-10

### Added
- Work Tracker widget with daily session stats, streaks, and weekly trends
- In-app help panel with searchable documentation (10 help topics)
- What's New banner for post-update feature announcements
- `clave://navigate` deep links in help docs to jump to features
- App version exposed to renderer via IPC

## [1.26.2] — 2026-04-03

### Added
- i18n with first-launch language picker
- History session browser with sidebar expansion
- Windows support

### Fixed
- History panel CJK copy bug, scroll-to-search, and markdown rendering
- Search bar placeholder text cleanup

## [1.26.0] — 2026-04-02

### Added
- History session browser with sidebar expansion

## [1.25.0] — 2026-04-02

### Added
- History viewer with full conversation display, markdown rendering, and search

## [1.24.0] — 2026-04-01

### Added
- Git Journey panel — visualize commit history grouped by push
- Improved git diff preview UX — single-click switching, arrow navigation, active highlight

### Changed
- Preserve folder expansion state on navigation, add back button

## [1.23.0] — 2026-03-31

### Fixed
- Show folder name instead of group name in toolbar server button

### Changed
- Reduced resource consumption for hidden terminals and fixed polling loops

## [1.22.0] — 2026-03-27

### Added
- Auto-discovery of `.clave` files from repos
- Category support for pinned groups
- Per-terminal cwd support for group terminals
- `workspaceId` for per-user `.clave` file override
- Save discussion and save plan buttons to session header

### Changed
- Rewrote session auto-naming to read Claude's JSONL transcript

## [1.21.0] — 2026-03-25

### Added
- Magic sync button in git panel
- Redesigned right sidebar layout and git panel structure
- Icon toggle buttons replacing segmented controls
- IconButton abstraction with harmonized tooltips
- Auto-remove localhost URL indicators when server stops
- Workspace discovery from root folder with rootDir path resolution

### Fixed
- Default AppIcon fill gradient corrected

## [1.20.0] — 2026-03-25

### Added
- Toolbar active URLs with darkened quick-action icons
- Pin buttons show logo with tooltip
- Logo and autoLaunchLocalhost support in `.clave` group config
- Toolbar quick-action buttons and workspace title
- Workspace management in Settings with auto-save
- Drag-drop `.clave` files into pin area with export dialog
- `.clave` file format — IPC handlers for read, write, watch, and path resolution

## [1.19.8] — 2026-03-24

### Added
- Smarter session auto-titles from extracted user messages
- Enhanced group terminals with folder picker, optional command, icon selection, right-click menu
- Keyboard shortcuts for sidebar, settings, search, and session navigation
