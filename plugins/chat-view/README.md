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

Markdown is rendered without raw HTML. Shiki has one lazy highlighter with light /
dark themes chosen from the skin base. Its JavaScript regex engine works within
Clave's CSP without enabling WebAssembly evaluation. Code retains Geist Sans.
Unknown fence languages fall back to plain code. No provider SDK is used.

`fixtures/echo.json` was recorded through `onSessionStream` in the hidden Electron
app with `--dev-echo-adapter`, sending `{type: 'user_message', text: 'hello'}`.
No provider tokens were spent.

Verification:

- `npm test` (reducer checks in `src/renderer/src/views/reducer.test.ts`,
  resolution in `resolution.test.ts`, the host log in `conversation-store.test.ts`).
- `node tests/e2e/run.mjs plugin-views` (the picker, the switch in both
  directions, the choice on the record).
- `node tests/e2e/run.mjs chat-view` after building.
- `node tests/visual/chat-view.mjs` (four real skins, token audit and actual Shiki spans).

Mutation proofs: removing the permission-response write fails the IPC assertion;
adding a literal hex color to a conversation class fails the visual token audit.
Screenshot bytes are temporary and no baselines are committed.
