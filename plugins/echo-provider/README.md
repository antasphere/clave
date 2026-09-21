# Echo provider

The bundled example of a **plugin-supplied agent provider**: a plugin whose
`contributes.adapters[]` entry becomes a launch profile beside Claude (chat) and
Codex (chat), and whose `provider.cjs` answers the session.

It calls no model, opens no socket and starts no process. Its answer is built
from the message and from `launch.command`, which is the manifest's `command`
verbatim — a real provider would spawn that.

It ships **disabled**: only the plugins named in `BUNDLED_ON_FIRST_INSTALL`
(`src/main/plugins/plugin-store.ts`) start enabled, and this one is deliberately
not among them — a launcher must not offer a provider nobody asked for. Enable it
in Settings → Plugins, which grants `sessions.write`.

What it demonstrates, and what the tests assert:

| Ask it        | What it proves                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any text      | the manifest's `command` reaches the adapter and comes back in the answer; a `tool_call` and its `tool_result` are correlated, and both ids arrive prefixed with `clave.echo-provider:` |
| `!permission` | a `permission_request` naming a tool, answered through the real `sessions:write` IPC, with the prefix stripped again before the plugin sees it                                          |
| `!invalid`    | an event that fails `SessionEventSchema` is dropped with a logged error, and the valid event after it still arrives                                                                     |

The contract it implements is described in `src/main/sessions/README.md`.
