# Native session views

The host owns the pane, focus, close and header. Bundled first-party native views
are resolved by `<pluginId>/<viewId>` through the single static import map in
`registry.tsx`, and the resolution itself is `resolution.ts`, which imports no
React and is unit-tested on its own. A plugin may contribute SEVERAL views
(`contributes.views[]`, each with an optional `title` the picker shows): the
session record carries the chosen one in `viewId`, set by the launch profile at
spawn or by the picker in the pane header, and `sessions:set-view` writes it in
main. Resolution never fails — the session's own choice, else the first view
that renders its transport, else the terminal — so disabling a plugin or
dropping a view from a manifest can never strand a session on a dead view.
Only enabled bundled plugins with session read/write grants and a matching
manifest view contribution mount, whether their utility process is active or still
starting: the view is the renderer's own code, and every plugin restarts on a
reload (a plugin linked, a linked plugin's files changed), so requiring `active`
swapped the pane for the terminal for about a hundred milliseconds each time and
unmounted the composer under the reader's keystroke (PRDCT-2620). Disabling the
plugin or failure of its utility process falls back to the terminal. What the
reader has typed and not sent is the host's, per session, in `draft-store.ts`,
so a composer that does come back (the chat plugin switched off and on again)
finds its text. A React render failure is caught by the host error boundary and shows
an error card; it does not switch views. PTY sessions retain their existing
terminal implementation.

The kernel record is the one source of a session's state, for the sidebar and for
the pane alike. `kernel-state.ts` binds `agent:state:<id>` (the main process's
forward of the same `state_change` the view receives on its session stream) and
hydrates from the session record, validating every incoming word against
`AgentStateSchema`; a view never writes sidebar state, and never re-derives its
own header state from the entries it has answered. That second half matters whenever the
adapter stops holding a request this view never answered: it abandoned it (a
`control_cancel_request`, or the end-of-turn `result` that clears the pending
set, `claude-adapter.ts:198-213`), or another consumer of the SAME window
answered it through `sessionsWrite`. Not another window — `sessions/ipc.ts`
refuses a subscribe or a write whose window key is not the session's, and sends
`agent:state` only to the owning window. In each case the kernel leaves
`blocked`, and a pane that trusted its own tally would keep offering an Allow the
adapter would refuse. The reducer marks such a request `answeredElsewhere`, the
card goes dead with a note, and a later `blocked` reopens it — the kernel awaits
something again, and the view cannot tell which request, so it restores what it
closed on the kernel's word.

A SURFACE view is the other kind, and the reason a plugin the user linked can
render a session at all: the plugin's own page, served on its `clave-preview`
URL with the panel CSP, in an iframe whose `sandbox` is `allow-scripts` and
NEVER `allow-same-origin` (`PluginViewSurface.tsx`). The guest has no preload,
no `electronAPI` and no route to the app's document — it is opaque-origin AND on
a different origin, two independent guards. Its only channel is `postMessage` to
the host, accepted solely when `event.source` is that frame's own window.

The authority is a LEASE minted in main (`plugins:view-lease`): it fixes ONE
session id, and every later call names the lease, never a session, so a guest
cannot aim at another session however it shapes its params. Main re-reads the
plugin's grants on every call rather than trusting the mint, and a lease dies
with what held it — the pane unmounting, the plugin being disabled, the window
reloading or closing. `tests/e2e/plugin-surface-view.spec.mjs` asserts all of
that against a linked fixture plugin, negatives included.

Third-party NATIVE views are deliberately still outside this wave: code compiled
into the renderer stays the host's own.
A plugin's code uses the public session preload bridge, installs listeners before
subscribing, awaits subscription before writes and releases both on unmount.
The v1 model has one transport per session, so events sessions have no terminal;
the host's terminal switch remains disabled with an explanation until a dual
transport contract can supply a PTY session id through the host component's optional
`terminalSessionId` prop. Switching keeps the conversation subscribed and mounted.

Every NATIVE view a session can be read in is mounted for the pane's lifetime and
all but one are hidden, so switching finds a view exactly as it was left —
including a transcript a view keeps privately. A SURFACE view is not: it mounts
only while it is the view on screen, because it costs a guest process and a
lease, so it loses what it held on every switch and takes a fresh lease on the
way back; and it gets no backlog, since its lease subscribes from its own birth
and nothing earlier is replayed.

`conversation-store.ts` is the host's own per-session record of what arrived. It
is held while a view is mounted on the session — on the RESOLVED VIEW, never on
the transport: with no view resolved the pane falls back to the terminal, and a
claim kept there would never reach zero, so main would go on streaming into a log
nobody reads. It keeps the event LOG, not a reduction of it, because reducing is
a view's reading of the session and two views of one plugin read the same events
differently. A native view reduces that log with its own reducer (`CompactView`
does) and therefore renders the whole conversation however late it is opened.
A resumed session's past is not in the stream: the log reads its newest page
(`sessions:history`) into `past` once subscribed, and a view reads further back
with `loadEarlierLog` as its reader scrolls up, the same way `ChatView` pages its
own;
`ChatView` still keeps its own reducer and its own subscription, which the
preload's reference count makes safe beside the log, and moves onto it once
PRDCT-2549 has merged (PRDCT-2616).

Native views are compiled into the renderer: `sessions.write` gates mounting,
not the preload IPC itself. The terminal fallback for an events-only session is
currently blank (the adapter lane owns that path).

Markdown HTTP(S) and mailto links use the host's existing `openExternal` path.
Other destinations render as plain text rather than inert clickable links.

One consequence for anyone writing a test against a pane: with several views
mounted on one session, the conversation's text is in the document more than
once — the view on screen and the ones kept alive behind it, which `hidden`
takes out of sight and out of the accessibility tree but not out of the DOM. A
window-wide text or class query therefore resolves to every copy and fails on
strictness. Scope to the pane (`.chat-host[data-session-id=…]`) or to the view
(`[data-view-id=…]`, `[data-testid="chat-view"]`). Two specs learned this the
hard way during PRDCT-2610: the chat view's own, on a shared class, and the
provider lane's, on a shared message.

A known limit, and the one thing here a reader would not assume: `registry.tsx`
refreshes its copy of the session records when the session store changes or a
plugin does, and main broadcasts no record change of its own. The picker
compensates by patching that copy after its IPC, and a session launched from a
profile arrives with the store change that created it — so every path a person
can take is current. A `viewId` written any OTHER way reaches the record but not
the pane until something unrelated refreshes it. Whoever adds the next writer
adds the broadcast with it.
