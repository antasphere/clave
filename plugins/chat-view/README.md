# Chat view

Two bundled first-party native views for the public `events` transport, chosen
per session from the pane header: `chat` (this file's subject) and `compact`
(`src/CompactView.tsx`, one line per turn, no markdown, no tool bodies). Compact
reads the host's per-session event log (`src/renderer/src/views/conversation-store.ts`)
and reduces it with the same `reducer.ts`, so it shows the whole conversation
however late it is opened; chat still keeps its own reducer and subscription, and
moves onto the log once PRDCT-2549 has merged (PRDCT-2616).

The compact composer deliberately does NOT wear the `chat-composer` class: both
views are mounted at once, and one class on two elements is a strict locator
resolving to two — which is exactly how this plugin's own end-to-end spec went
red during PRDCT-2610. Activation,
grants and disablement use the ordinary plugin host. The renderer registry owns
pane chrome; this plugin owns only the conversation content and the public session
bridge subscription. It does not launch a provider or read provider files.

The reducer preserves arrival order, joins assistant deltas until `final`, pairs
tools by id (including an early result), and retains permission answers. Permission
buttons disable only after an acknowledged write; failures remain visible and can
be retried. Session exit disables the composer.

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

A RUN of tool calls — everything between two messages — is one row saying what
the agent did, counted by kind ("Read 3 files · Ran 1 command"), with a loader
while any call is in flight and the failure count beside it. It opens to one item
per call, each with an 8-line / 2000-character preview of its output and a raw
input/output toggle. A permission card does NOT break a run: the approval the
agent needed mid-run is part of that step, and only a message ends it. The row is
an uncontrolled `<details>` keyed by the run's first tool id, so the reader's
choice is DOM state a re-render cannot touch — a result arriving neither closes an
open row nor opens a closed one, and a failure, having no way to set `open`, can
never expand the row by itself. `CompactView` groups the same runs with the same
function, one line each and no bodies, which is that view's whole contract. The
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

## Files on a message

A file dropped anywhere on the pane, pasted into the composer, or picked with
the paperclip becomes a chip above the textarea (`src/Attachments.tsx`): it can
be previewed, removed, or — when it is an image the adapter cannot take as image
content — sent as a file reference instead, on the reader's say-so. Chips are
attachment records from `sessions:files`; the bytes are read by main when the
message is sent (`src/main/sessions/README.md`, "Attachments"). A sent turn
shows the same chips as its record. The paths Clave's own file and git panels
drag as text still land at the caret, since a dragged folder is a path to talk
about, not a file to attach. `tests/e2e/chat-attachments.spec.mjs` drives all
of it through the real write IPC and reads the provider's side off the echo
adapter's reply.
