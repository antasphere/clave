# Native session views

The host owns the pane, focus, close and header. Bundled first-party native views
are resolved by plugin id through the single static import map in `registry.tsx`.
Only active, enabled bundled plugins with session read/write grants and a matching
manifest view contribution mount. Disable or runtime failure falls back to the
terminal. PTY sessions retain their existing terminal implementation.

Third-party native views and surface views are deliberately outside wave 2.
A plugin's code uses the public session preload bridge, installs listeners before
subscribing, awaits subscription before writes and releases both on unmount.
The v1 model has one transport per session, so events sessions have no terminal;
the host's terminal switch remains disabled with an explanation until a dual
transport contract can supply a PTY session id.
