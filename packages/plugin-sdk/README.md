# @clave/plugin-sdk

Version 1 of Clave's local plugin contract. This workspace exports TypeScript source;
bundle it with your plugin's host entry. The Clave host bundles it into its Electron
main and utility-process entries as well.

```json
{
  "id": "example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "kind": "plugin",
  "engines": { "clave": ">=1.90.0 <2" },
  "ui": "surface",
  "uiEntry": "ui/index.html",
  "main": "main.cjs",
  "contributes": {
    "panels": [{ "id": "hello", "title": "Hello", "icon": "SparklesIcon", "placement": "side" }],
    "commands": [{ "id": "greet", "title": "Say hello" }]
  },
  "permissions": []
}
```

The brief calls the surface entry `ui.entry` while also requiring `ui` to be a
string enum. JSON cannot represent both on the same property: v1 preserves the
enum and names the optional entry `uiEntry`. The host defaults it to
`ui/index.html`. Entry paths are relative to the plugin root, without traversal.
Unknown fields (including nested fields), invalid versions/ranges, and duplicate
contribution IDs are errors. Semver build metadata (`+build`) is refused by design. Icons use the exported Heroicon name, e.g.
`SparklesIcon`.

```ts
import { definePlugin } from '@clave/plugin-sdk'

export default definePlugin({
  async activate(api) {
    await api.ui.registerPanel('hello')
    await api.ui.registerCommand('greet', () => api.notify({ title: 'Hello from a plugin' }))
  },
  async deactivate() {
    // Dispose plugin-owned resources here.
  }
})
```

The host checks both requested and granted permissions for every API request.
Session reads and subscriptions require `sessions.read`; sending text requires
`sessions.write`; secret prompts require `secrets`. Registering UI requires an
exact contribution ID from the validated manifest. `notify` and `log` are baseline
capabilities: v1's closed permission enum contains no separate grants for them.
The other declared permissions reserve future host APIs; they do not expose
filesystem, network, or shell methods in v1. Utility processes provide crash
isolation, not an OS security sandbox for arbitrary Node.js plugin code. Only
install host-side code you trust.

`sessions.subscribe` resolves to a disposer and supplies session-list snapshots.
`secrets.request({title, description?})` prompts the user and resolves to the
entered value or `null` on cancellation. `log(level, message)` is asynchronous.

The transport-independent bridge uses JSON-RPC 2.0 with correlated requests,
typed errors, and notifications. `createPluginAPI(transport)` wraps any object
with `postMessage` and `subscribe`; disposal rejects pending calls. Requests time
out after 30 seconds by default. Hosts send session snapshots through
`sessions.changed` notifications and invoke command handlers with a
`commands.execute` request carrying `{id, args?}`. Permission failures use
`PluginPermissionError` (`code: -32001`, `data.permission`).

Skins may additionally declare `skin: { tokens: "skin.json", css?: "skin.css", base: "dark" | "light" }`.
For `kind: "skin"`, omitted `ui` normalizes to `none`; executable entries,
privileged permissions and contributions are refused. The skin loader owns token/CSS
validation and activation; the plugin runtime does not execute skins.

The content seal covers the plugin's own files (including root `package-lock.json`,
`pnpm-lock.yaml`, and `yarn.lock` files), file modes, and internal symlink targets.
It excludes `node_modules` and `.git`; dependency contents are not sealed by a
lockfile alone. Bundle your dependencies into `main` for a sealed plugin.
