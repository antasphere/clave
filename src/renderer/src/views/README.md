# Native session views

The host owns the pane, focus, close and header. Bundled first-party native views
are resolved by plugin id through the single static import map in `registry.tsx`.
Only active, enabled bundled plugins with session read/write grants and a matching
manifest view contribution mount. Disabling the plugin or failure of its utility
process falls back to the terminal. A React render failure is caught by the host error boundary and shows
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

Third-party native views and surface views are deliberately outside wave 2.
A plugin's code uses the public session preload bridge, installs listeners before
subscribing, awaits subscription before writes and releases both on unmount.
The v1 model has one transport per session, so events sessions have no terminal;
the host's terminal switch remains disabled with an explanation until a dual
transport contract can supply a PTY session id through the host component's optional
`terminalSessionId` prop. Switching keeps the conversation subscribed and mounted.

Native views are compiled into the renderer: `sessions.write` gates mounting,
not the preload IPC itself. The terminal fallback for an events-only session is
currently blank (the adapter lane owns that path).

Markdown HTTP(S) and mailto links use the host's existing `openExternal` path.
Other destinations render as plain text rather than inert clickable links.
