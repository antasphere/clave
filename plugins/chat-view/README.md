# Chat view

Three bundled first-party native views for the public `events` transport, chosen
per session from the pane header: `chat` (this file's subject), `terminal`
(`src/TerminalView.tsx`, started as a copy of chat and diverging on purpose) and
`lab`, the experimental one ("Folio", below). Each
keeps its own reducer and subscription. A third view, `compact` (one line per
turn), was removed in 2.2: nobody used it. A session that still names it falls
back to the first view the plugin contributes, which is chat.

A resumed conversation opens on its end: both views read its past from main a
page at a time (`sessions:history`, `src/main/sessions/README.md`), the newest
first, and ask for the page before only when the reader is within a screen and a
half of the top (`src/earlier.ts`), so a steady scroll up rarely meets a top that
is still loading. The page goes in front in one dispatch, and the transcript
restores the reader's distance from the bottom in the layout of the same commit
(`useTranscriptEnd`'s `hold`), so nothing moves on screen. Rows are keyed by the
entry's ordinal (`Conversation.first`), never by position, so a page in front
shifts no key; and each row is memoised on its entry, so a streamed delta
re-renders the answer it grows and a keystroke in the composer re-renders no
turn at all. A loader pill (`.chat-earlier`) shows over the transcript's head
only when a page takes longer than a beat. The empty state waits for the first
page, so a long conversation never flashes "Start a conversation" on its way in.

Activation,
grants and disablement use the ordinary plugin host. The renderer registry owns
pane chrome; this plugin owns only the conversation content and the public session
bridge subscription. It does not launch a provider or read provider files.

The reducer preserves arrival order, joins assistant deltas until `final`, pairs
tools by id (including an early result), and retains permission answers. Permission
buttons disable only after an acknowledged write; failures remain visible and can
be retried. Session exit disables the composer.

A turn the reader stopped (the Stop button or Escape) arrives as
`turn_interrupted`, the adapter's word, never a guess read off an error: the
reducer marks the last user entry `interrupted`, the row reads muted with
"Interrupted" under it, an answer still streaming is closed as it stands, and no
error card is raised — Claude closes such a turn with an `is_error` result that
carries no text, which used to read as "Claude turn failed" under the message.

The composer takes the caret the moment it can accept input and this session is
the focused one (`src/focus.ts`, both views): a new tab opens ready to type, the
way a terminal tab focuses its xterm. The gate on "enabled" matters — the field is
disabled until the subscription resolves, and a disabled field swallows a focus
call — and the linked-document panel keeps its editor's caret. The hidden view's
call is a no-op, since a field in a hidden slot cannot be focused. Making the hook
return early turns `chat-view`'s "opens with its composer focused" red.

The pane's header state is the kernel record the session stream carries, never a
tally of what this view answered: a request the adapter no longer holds — it
abandoned it, or another consumer of the same window answered it through
`sessionsWrite` — is closed, so the reducer marks it `answeredElsewhere` on the
first non-blocked `state_change`, the card reads "No longer awaiting an answer",
and its buttons go dead rather than sending an answer the adapter would refuse.
A later `blocked` clears the mark: something is awaited again, and no adapter
tells the view which request, so the cards it closed on the kernel's word come
back rather than one of them staying unanswerable for the session's life. Transcripts currently live for the
mounted view's lifetime; disabling the plugin releases its subscription.

The WORK RUNNING NOW — the subagents, and the commands left running in the
background — is a strip of cards under the composer of both views
(`src/WorkCards.tsx`): one card each, with a drawing of what it is
(`src/WorkDrawing.tsx`, in the hand of the drop card's drawings, breathing
while the work goes on), the type and the task or the command's title, and
the figures (steps, the agent's own context, how long it has run, or how long
it has been quiet). The cards are the one place that says it: the pane
header's "in background" chip and the Terminal view's status-line count are
gone (6 November 2026). Clicking a card opens a window onto its work: an
agent's (`src/SubAgentPeek.tsx`) shows what it was asked, what it says and
what it does, as it happens, rendered with the transcript's own rows
(`src/TerminalEntry.tsx`, the rows moved out of the view for that); a
command's (`src/ShellPeek.tsx`) shows its full command line and what it has
written so far, read again every second from the file Claude names for a
background command (Codex names none; its output lands in the transcript at
completion). Both are views only, with no field and no button that answers
anything; the agent reports to the conversation when it is done. An agent's
log is reduced off the same stream by `src/subagents.ts`: every
message, text, call and result an adapter stamps with a `parent` (Claude the
call that started the agent, Codex its thread) goes to that agent's own
conversation, keyed as the row is (`SubAgent.id`), through the transcript's
reducer; `reduceConversation` drops a parented event, so an agent's hundred
calls no longer count into the run the conversation is on, as they did until
6 November 2026. A page of the past folds in as it arrives; Claude's own
transcript replay carries nothing of a subagent (sidechains are skipped), so a
resumed session's finished agents have no log.

The agent's WORKING NOTES — the short lines it writes between its tool runs on
the way to an answer — fold into ONE CARD once the turn is over (`src/stretches.ts`
decides, `src/WorkStretch.tsx` draws, PRDCT-4212). The rule reads the turn's
SHAPE and never its words (the 5 November lesson above): a note is an assistant
line followed by work in the same turn; a tool run and a permission the agent
asked for a tool (allowed, refused, left by a stop) are work and fold; a question
the agent asked, a form and an error are boundaries that stay in the transcript,
the notes on each side folding into their own cards; the last words of the turn
never fold; nothing folds while the conversation works or waits; three notes at
least. The card's face carries the counts and a title read by a one-shot Haiku
call (`src/shared/work-digest.ts`, run and filed by `src/main/exchange-digest.ts`
beside the exchange digests, asked for the conversation's latest cards only); a
note the read flags as needing the reader is shown verbatim on the face, in
accent, and its step is marked inside. The read may only RAISE visibility, never
hide. Open, the card is a rail of steps drawn with the view's own rows. The
preference (`foldWorkNotes`, Settings → Appearance → Conversation, and the
toolbar button) is the host's; off, the transcript reads as before.
`tests/e2e/chat-work-stretch.spec.mjs` holds it on the real app, in both views.

A RUN of tool calls — everything between two messages — is one row saying what
the agent did, counted by kind ("Read 3 files · Ran 1 command"), with a loader
while any call is in flight and the failure count beside it. It opens to one item
per call, each with an 8-line / 2000-character preview of its output and a raw
input/output toggle. A permission card does NOT break a run: the approval the
agent needed mid-run is part of that step, and only a message ends it. The row is
an uncontrolled `<details>` keyed by the run's first tool id, so the reader's
choice is DOM state a re-render cannot touch — a result arriving neither closes an
open row nor opens a closed one, and a failure, having no way to set `open`, can
never expand the row by itself. The
grouping, the summary and the preview are `src/tools.ts`, pure and unit-tested. A
CLOSED row still summarises itself on every render of the session, so the summary
reads `describeToolHead` and never turns an output into text; `describeTool` builds
the previews, and only an opened item asks for them.

A failure is the ADAPTER's word, carried on `tool_result.error`, never a guess
read off the output: a `Read` of a log file whose first line is "Error:" is not a
failed tool. `claude-adapter` forwards the CLI's `is_error`; `codex-adapter`
derives it from a command's exit status, falling back to the item's `error` when a
command never ran and so has no status. An adapter that cannot tell says nothing, and
an absent flag means "not known to have failed" rather than "succeeded".

Markdown is rendered without raw HTML. Shiki has one lazy highlighter with light /
dark themes chosen from the skin base. Its JavaScript regex engine works within
Clave's CSP without enabling WebAssembly evaluation. Code retains Geist Sans.
Unknown fence languages fall back to plain code. No provider SDK is used.

`fixtures/echo.json` was recorded through `onSessionStream` in the hidden Electron
app with `--dev-echo-adapter`, sending `{type: 'user_message', text: 'hello'}`.
No provider tokens were spent.

Verification:

- `npm test` (reducer checks in `src/renderer/src/views/reducer.test.ts`,
  resolution in `resolution.test.ts`, the host log in `conversation-store.test.ts`,
  the grouping, summary and preview in `chat-tools.test.ts`).
- `node tests/e2e/run.mjs plugin-views` (the picker, the switch in both
  directions, the choice on the record).
- `node tests/e2e/run.mjs chat-view` after building.
- `node tests/e2e/run.mjs chat-tool-groups` (the run row in both views).
- `node tests/visual/chat-view.mjs` (four real skins, token audit and actual Shiki spans).

Mutation proofs: removing the permission-response write fails the IPC assertion;
adding a literal hex color to a conversation class fails the visual token audit;
grouping a run across a message, dropping the adapter's failure flag in the
reducer, opening a failed run by itself, keying a run so it remounts when a call
joins it, and emptying an item's raw input/output block each turn
`chat-tool-groups` red. ⚠️ The token audit in `tests/visual/chat-view.mjs` is two
halves: a static read of the stylesheet at module scope, which catches a literal
colour or size and has always run, and the four-theme pass after it, which needs the
app. Scope every locator in that file to `[data-testid="chat-view"]` — two views are
mounted per session since PRDCT-2610, and an unscoped `.chat-view` killed the second
half of the script for a whole wave without anyone noticing.
Screenshot bytes are temporary and no baselines are committed.

## Files and sessions on a message

A drag over the pane brings up the drop card: a veil, one paper card, and a
drawing in the hand of the products' figures (`src/DropDrawing.tsx`, the
`.chat-drawing` rules in `system.css`: ink at low opacity, boxes filled with
paper, the ringed dot where the thing lands, the accent on the ONE line it
travels along, drawn once as the card comes up; words under the drawing, never
in it). The chips' glyphs are in the same hand, and each chip wears its label
as a tag. `tests/e2e/look/chat-attachments.spec.mjs` screenshots all of it in
two themes, for eyes rather than as a check.

A file dropped anywhere on the pane, pasted into the composer, or picked with
the paperclip becomes a chip above the textarea (`src/Attachments.tsx`): it can
be previewed, removed, or — when it is an image the adapter cannot take as image
content — sent as a file reference instead, on the reader's say-so. An image in
a format no provider takes (HEIC, SVG, AVIF) is a file reference from the
start: the agent gets its path. Chips are attachment records from
`sessions:files`; the bytes are read by main when the message is sent
(`src/main/sessions/README.md`, "Attachments"). A sent turn shows the same
chips as its record.

A folder is a record of its own: main tells it from a file, and the chip
names it with its top-level item count (`Folder · 12 items`), its path on
hover, its listing in the preview, and the marker `[Folder #1]` in the text;
the provider gets its path under that marker, to list. Every chip says what
its record is, from the media type its name says (`@clave/contract/attachments`,
the one table for the Mac, a server and the chips): Image, Video, Audio, PDF,
Document, Sheet, Slides, Text, Code, Archive, Folder or File, each with a
glyph in the drop card's hand, and the one figure that matters, its size or
its item count. The label stays what the record IS to the agent (`Image`,
`File`, `Folder`, `Session`): a video is a File, a path to read. The paths
Clave's own file and git panels drag as text land at the caret, the way the
TUI pastes them. A drop never fails: whatever main refuses that arrived as a
path — a named pipe, a socket, a file it cannot read — lands in the text as
that path with the reason reported beside it, and only bytes with no path (a
pasted image too large) keep the error on their chip.

A sidebar tab dragged onto the pane is a SESSION attachment: the tab's id, name,
agent and folder, delivered to the agent as a line it can act on with
`clave_read_session` and `clave_send_to_session` ("finish when these three
lanes are done"). The sidebar's drag is pointer-based, so the pane does not
listen for `drop`: it marks its root through `lib/session-drag.ts` and the drag
hook (`hooks/use-sidebar-dnd.ts`) dispatches enter, leave and drop events on
it; a group dropped hands over every session it holds.

Every record is labelled as it arrives — `Image #1`, `File #2`, `Session #1`,
numbered per kind by what the record IS to the agent (a HEIC is a File) — and
written into the text at the caret as a marker, `[Image #1]`. The chip and the
marker are one thing: removing the chip takes the marker out of the text, and
editing the marker out of the text (`[Session #1]` to `[Session #1`) removes
the chip. Main appends a legend keyed by the markers for the provider. The cap
is ten attachments per message, files and sessions together. The composer's
side of all this is `src/composer-attachments.ts`, shared by the chat and
terminal views; the pure label and marker helpers are in
`src/shared/attachments.ts`. `tests/e2e/chat-attachments.spec.mjs` drives all
of it through the real write IPC, the desktop's own drop through the devtools
protocol (`Input.dispatchDragEvent`, real File objects with their entries) and
the sidebar's real pointer drag included, and
reads the provider's side off the echo adapter's reply.

## Folio, the experimental view (`lab`)

`clave.chat-view/lab`, titled Folio (`src/lab/`, its name and one-line pitch in
`src/lab/meta.ts`, which the first-run onboarding reads). The conversation is a
book of pages, one per question: the page's title is the reader's message, its
first sentence (`headline`) at once, then the title a helper wrote for it,
rewritten in place over the first sentence (`PageTitle.tsx`, `reveal.ts`; a
title already filed is just shown, and the whole message then sits under it),
and the agent's answer is written on the page as a
document, and what the agent did on the way (calls, approvals) sits in the
margin beside the paragraph it led to; a call in the margin opens to the
transcript's own `ToolPanel`. A message sent before any answer joins the
question it follows. The spine at the top has one tick per page, its height the
length of the answer; the arrows (or Option and the arrows from an empty
composer), the ticks and the contents turn pages, and the page being written is
followed until the reader turns away, with a way back while they are elsewhere.
A finished page can be read aloud: the reading first asks for the page's spoken
rendering, the answer rewritten by a helper to be heard (`spoken.ts`: no
markdown, no code read out, the lists said as sentences, filed so a page read
before is spoken at once), and speaks it; when none comes, it reads the page as
written (`speech.ts` takes the markdown out and cuts the utterances) and the read
control says why. The speaker toggle in the composer's footer reads each new
answer as it finishes.

The reading is a player, by block (PRDCT-4430). One split, `splitBlocks` in
`src/shared/spoken-rendering.ts`, cuts an answer into its top-level blocks (a
paragraph, a heading, a list, a table, a fence, a quote); the page renders
each block on its own (`data-block`, numbered across the page's prose), and
the spoken rendering is asked on those same blocks, numbered, and answered
block by block (a reply whose numbers do not match is asked again, then the
page is read as written, by the same blocks). The voice speaks one part per
block (`audio.ts`, a long block in several parts), so the block being read is
known and washed in the accent, brought into view unless the reader scrolled
in the last three seconds. The control plays and pauses (the ElevenLabs
element and the system voice alike), Stop ends the reading, a click on a block
reads from it, and the bar at the page's foot has one tick per block, a click
or a drag (or the arrows) going to a block, with the time once known
(`progress.ts`). A rendering filed before the blocks plays whole, nothing lit.

It keeps the same reducer, subscription order and composer as the Chat view
(`src/lab/use-conversation.ts` mirrors its effect; the dock, attachments,
menus and work cards are the shared components) and renders only the page on
screen, so the copy mounted hidden behind another view costs a reducer and no
rows. Its stylesheet is its own (`src/lab/folio.css`, imported by the view).
Pages and speech are pure and tested (`src/lab/*.test.ts`). Not yet: the slash
menu and the host's /resume, /mcp and /plugin panels (a typed command goes to
the agent as text), and the pane's Find, which searches no page here.
