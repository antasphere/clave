# Chat view

A bundled first-party native view for the public `events` transport. Activation,
grants and disablement use the ordinary plugin host. The renderer registry owns
pane chrome; this plugin owns only the conversation content and the public session
bridge subscription. It does not launch a provider or read provider files.

The reducer preserves arrival order, joins assistant deltas until `final`, pairs
tools by id (including an early result), and retains permission answers. Permission
buttons disable only after an acknowledged write; failures remain visible and can
be retried. Session exit disables the composer. Transcripts currently live for the
mounted view's lifetime; disabling the plugin releases its subscription.

Markdown is rendered without raw HTML. Shiki has one lazy highlighter with light /
dark themes chosen from the skin base. Its JavaScript regex engine works within
Clave's CSP without enabling WebAssembly evaluation. Code retains Geist Sans.
Unknown fence languages fall back to plain code. No provider SDK is used.

`fixtures/echo.json` was recorded through `onSessionStream` in the hidden Electron
app with `--dev-echo-adapter`, sending `{type: 'user_message', text: 'hello'}`.
No provider tokens were spent.

Verification:

- `npm test` (reducer checks in `src/renderer/src/views/reducer.test.ts`).
- `node tests/e2e/run.mjs chat-view` after building.
- `node tests/visual/chat-view.mjs` (four real skins, token audit and actual Shiki spans).

Mutation proofs: removing the permission-response write fails the IPC assertion;
adding a literal hex color to a conversation class fails the visual token audit.
Screenshot bytes are temporary and no baselines are committed.
