# Plugin runtime

The shared contract and authoring example live in `packages/plugin-sdk/README.md`.
Bundled packages ship through `extraResources/plugins`; local packages live in
`~/.clave/plugins` and installation preferences in `~/.clave/installed.json`.
Tests using `--test-no-activate` use `<userData>/clave-plugins` instead of the real home.

Settings → Plugins discovers packages, reviews grants, links a development folder,
opens contributed surfaces, and runs contributed commands. Linked folders start
disabled. Changes restart plugin code, clear old contributions, and revoke old
surface URLs. Broken manifests and incompatible engine ranges remain visible.
Copied installations can be removed; removing a link never deletes its target.
Bundled plugins can be disabled but not removed.

One utility process per enabled executable plugin imports its bundled `main` and
receives a JSON-RPC MessagePort. Main checks declaration AND persisted grants on
every privileged call. UI registration is restricted to declared contribution IDs.
Crashes clear contributions and retry at 1/2/4/8/16 seconds, then stop until the
user disables/enables the plugin. Pending commands reject on shutdown. Deactivation
gets a one-second grace period before the owned child is terminated.

This is crash isolation, not a Node permission sandbox. Host code can import Node
modules; link only code you trust. Clave strips credential-bearing environment
variables from child launch. Surfaces are a separate sandboxed webview: no preload,
no Node, the existing view permission/navigation policy, a root-scoped preview URL,
and a CSP that denies network fetches unless `net` is granted. Theme CSS variables
are enumerated from the live computed stylesheet and updated on theme/skin changes.

`secrets.request` presents a password input on the Plugins settings page. The
value is sent only to the requesting live utility and is never persisted. Requests
cancel on stop and expire after two minutes. `notify` posts an OS notification and
also appears on the plugin's settings card, including in hidden E2E runs.

Verification: `npm test` covers schema, persistence, bridge permission gates,
crash/backoff, and stale-reply cleanup. After `npx electron-vite build`,
`node tests/e2e/run.mjs plugins` drives the real hidden Electron app. Setting
`CLAVE_PLUGIN_MUTATE_TOKENS=1` replaces the guest's CSS injection boundary with a
no-op and MUST make that check fail. No screenshots are retained.
