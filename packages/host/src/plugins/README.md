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

## Actions, and the fuller account of a session

A plugin's `contributes.actions[]` are the verbs it offers on a tab, a group or the workspace
(`packages/plugin-sdk/README.md`). The host keeps the registered ids on the record (`actions`,
runtime state like `panels`), asks the plugin over the same JSON-RPC channel (`actions.invoke`,
`actions.preview`, with the timeouts and the answer limits `plugin-host.ts` enforces and never
trusts from the plugin), and the renderer draws the entries and the page pane
(`apps/desktop/src/renderer/src/components/plugins/plugin-actions.tsx`, `PluginMainPanel.tsx`). The session
payload a plugin reads (`plugin-sessions.ts`) joins the registry's session with its record (the
provider's own session id, the model, the workspace) and with the sidebar group holding it: the
shell reports every window's groups to the service (`plugin-groups.ts`, from the shell's
`SidebarLayouts` instance, in-process and attached alike), since the groups are the windows' and
the service may run in the server's process. Each plugin process gets `CLAVE_PLUGIN_DATA_DIR`, a
folder under the plugin root created at spawn. `apps/plugins/analytics` (on by default) is the first
plugin on this contract: it reads the transcripts of the sessions it is told about and serves its
pages on loopback; its README says what it keeps and where.

## Two execution models, and they are not equally contained

A plugin's code can run in two places, and what it can reach differs completely.

Its `main` runs in **its own utility process**: one per enabled plugin, reached over
JSON-RPC, launched with a trimmed environment that carries no credentials, and
killed and restarted on a crash without taking the app with it.

An adapter it contributes through `contributes.adapters[]` runs in **Clave's own
main process**. It is loaded with `createRequire` when a session starts, so it has
the app's pid, the app's full environment including any credentials in it, `require`
of anything on the machine, and the ability to start other programs. There is no
utility process, no trimmed environment and no crash isolation for that code, and
granting an adapter plugin `sessions.write` is in practice granting it everything
Clave itself can reach. The review dialog says so in those words before it is
enabled. `packages/host/src/sessions/README.md` describes the contract it implements.

Link only code you trust, and for an adapter read that sentence as written.

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
