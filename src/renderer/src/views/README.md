# Native session views

The host owns the pane, focus, close and header. Bundled first-party native views
are resolved by plugin id through the single static import map in `registry.tsx`.
Only active, enabled bundled plugins with session read/write grants and a matching
manifest view contribution mount. Disabling the plugin or failure of its utility
process falls back to the terminal. A React render failure is caught by the host error boundary and shows
an error card; it does not switch views. PTY sessions retain their existing
terminal implementation.

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
