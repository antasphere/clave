# Runtime plugins

Clave has two extension points: conversation providers and conversation views.
The built-in Claude, Codex, OpenCode, and Pi integrations use the provider contract.
Views enhance a stored tool result or artifact. They cannot replace the composer,
edit history, or approve provider permission requests.

This is an internal API, version 1. There is no compatibility promise across API
versions. Unsupported versions fail explicitly. These are separate from the
Claude companion plugins under `plugin/`.

## Try a local plugin

1. Start `npm run dev:ui` for an isolated app profile.
2. Open Settings → Runtime plugins → Install local folder.
3. Select `examples/runtime-plugins/echo-report`.
4. Review the native-code and view-capability disclosure, then approve.
5. Choose Example echo in the session launcher and send a message.
6. Its artifact offers Interactive report. The example can read conversation
   context and prepare a follow-up draft, but cannot execute commands or send
   messages.

The example makes no model calls and starts no external commands. Existing
drafts are not overwritten by its Prepare a follow-up action.

Only install trusted code. A provider module runs native JavaScript in the
conversation service with your account's filesystem and process privileges.
It is not an OS sandbox. UI code runs in a separate sandboxed frame.

## Package format

A local build directory contains `clave-plugin.json`, self-contained `.cjs`
provider modules, and self-contained `.html` view documents. No dependency install
or network download occurs. Source repositories, dependency folders, dotfiles,
symlinks, and paths outside the package are rejected.

```json
{
  "apiVersion": 1,
  "id": "internal.reports",
  "name": "Internal reports",
  "version": "1.0.0",
  "views": [
    {
      "id": "test-results",
      "name": "Test results",
      "entry": "results.html",
      "mimeTypes": ["application/json"],
      "toolNames": ["Run tests"],
      "capabilities": ["conversation.read", "composer.setDraft"]
    }
  ]
}
```

Provider contributions additionally declare `id`, `name`, `entry`, `command`,
and `capabilities`. Their CommonJS entry exports
`createAdapter(launch, emit)` returning the interface in
`src/main/conversations/adapter.ts`. Modules load only when a session starts,
not during inspection, installation, or listing. Plugins must bundle code into
their built entries; they do not import Clave's stores or internal modules.

Every provider has a default launch profile in Settings → Agents. Its command
comes from the provider manifest. Custom profiles can replace that command and
add arguments; global and workspace defaults use the same selection rules as
built-in agents. A conversation using the provider default keeps the command
from its pinned revision, even after an update or disablement.

The host validates emitted events and prefixes external provider entry IDs to
keep them separate from core-authored user messages. Provider modules must emit
assistant messages, tools, requests, artifacts, and lifecycle events through the
contract, not edit the host transcript.

Packages are limited to 16 MiB and 256 files. Installation previews capture the
actual bytes subsequently installed, preventing a source-folder edit from
changing code after the trust dialog was accepted.

Plugin, provider, and view IDs begin with a lowercase letter and contain only
lowercase letters, digits, dots, and hyphens. A view ID is local to its plugin;
provider IDs are unique across installed plugins.

## Revisions and updates

Code is copied into content-addressed directories beneath
`<userData>/runtime-plugins/`. The active registry changes atomically.

- Providers are pinned when a conversation is created.
- View plugins are pinned on first use in each conversation. A newly installed
  enhancer can be selected in an older conversation, but updating an enhancer
  already used there does not silently replace its code.
- Update from folder installs another immutable revision from the remembered
  source directory. New bindings use it without restarting Clave.
- Disabling a plugin prevents new bindings and privileged view calls. Existing
  provider sessions retain their pinned code; disabling does not kill them.
- Older revisions remain available for pinned sessions. Automatic revision
  garbage collection is not implemented.

Built-in revisions are hashes of the host implementation. Running daemons keep
their loaded implementation. A missing built-in revision after a core upgrade
fails clearly rather than quietly changing an existing session's provider.
Local plugin updates and core application upgrades are different operations.

## Artifacts and original content

An artifact is a Clave-owned conversation entry with an ID, title, content type,
content, and mandatory plain-text fallback. Supported types are HTML, Markdown,
plain text, and JSON. `sourceUrl` is attribution, not an instruction to fetch or
execute remote content.

Provider plugins can emit an `artifact` event. Agents in conversation sessions
can call `clave_publish_artifact` with a stable `commandId`; retrying the same
publication does not duplicate the entry. A service that generates a report
should return its content for publication rather than relying on an expiring URL.

The core can render original content without any plugin. View original and
Close expanded view remain outside plugin-controlled content. Missing, disabled,
or failed enhancers return to the original representation. Artifacts are saved
with history and remain readable when plugin code is unavailable.

Artifact envelopes are bounded to 192 KiB of serialized UTF-8. They count toward
the existing 4 MiB conversation capacity. HTML views and provider modules are
not allowed to grow that history without limit.

## View bridge

Views run in an iframe with `sandbox="allow-scripts"`, never `allow-same-origin`.
The host's private protocol supplies an enforced response CSP. External
resources, fetches, forms, objects, nested frames, and navigation escapes are
denied. Views cannot access Node, Electron's preload, the parent DOM, or stores.
Documents must inline their scripts and styles.

The frame gets a MessagePort tied to one lease, one host window, one conversation,
one entry, and one plugin revision. It does not choose those scopes.

```html
<button id="prepare">Prepare follow-up</button>
<script>
  window.clave.ready.then(({ entry, capabilities }) => {
    // Render entry content using safe DOM APIs such as textContent.
  })
  document.getElementById('prepare').onclick = async () => {
    await window.clave.request('composer.setDraft', {
      text: 'Explain these test failures.'
    })
  }
</script>
```

The host starts the channel with a `clave:init` message and transferred port.
Requests use `{type:"clave:request", id, method, params}`; responses use
`{type:"clave:response", id, result}` or an error. `window.clave` is a convenience
client for this protocol, not access to Electron.

Raw generated HTML has zero capabilities. An installed enhancer explicitly
declares the subset of operations its view can use. Selecting that enhancer
does not let page content invent more permissions; every operation is checked
again on the server. There is no automatic privilege grant based on HTML content
or an artifact's source URL.

| Method                | Parameters  | Policy                                                           |
| --------------------- | ----------- | ---------------------------------------------------------------- |
| `conversation.read`   | `{}`        | Read the bound conversation                                      |
| `composer.setDraft`   | `{text}`    | Prepare text only; refuses an existing draft                     |
| `conversation.send`   | `{text}`    | Explicit native confirmation before sending                      |
| `workspace.readFile`  | `{path}`    | Bounded UTF-8 file under the session directory, realpath checked |
| `workspace.execute`   | `{argv}`    | Native confirmation; tracked daemon-owned job                    |
| `workspace.jobRead`   | `{jobId}`   | Requires execute capability and matching session/plugin revision |
| `workspace.cancelJob` | `{jobId}`   | Same scope check; kills only the owned job                       |
| `ui.openFile`         | `{path}`    | Validated workspace path, opened by Clave                        |
| `ui.openArtifact`     | `{entryId}` | Existing artifact in the bound conversation                      |

Runtime access errors do not grant fallback authority. Unmounting, reloading,
closing, or moving the view revokes its lease. Readable original content remains.
Do not automatically retry sends or executions after an uncertain outcome.

Jobs record acceptance before spawning, use argv without implicit shell parsing,
bound execution/output, and support cancellation. Environment credentials are
not stored in job records or supplied by the frame. Commands still run with the
user's OS privileges after confirmation; workspace scoping is not an OS sandbox.

A supervisor keeps ordinary job descendants owned until cleanup finishes, even
if their immediate parent exits. Its own timeout and daemon-disconnect handler
stop jobs after an owning-service crash; reopening never signals stale persisted
PIDs. Commands deliberately escaping through detached groups or `setsid`, and
forcibly killing the supervisor itself, are outside this guarantee. Windows uses
an exact process-tree termination command but has not been exercised on this Mac.
File-read and open-file RPCs also refuse Clave's private profile directory, even
when the selected workspace contains it.

## Verification and upgrades

```sh
npm test -- src/main/runtime-plugins src/main/conversations
npm run build
npm run test:e2e -- runtime-plugins
node src/main/runtime-plugins/protocol.electron.mjs
```

The tests use local fake providers and view documents, not billable model calls.
They check immutable updates, pinned revisions, persistence without plugins,
capability and scope denial, and actual Electron iframe isolation.

This feature requires conversation protocol 2. A protocol-1 daemon already
running for the profile is not killed or replaced automatically. The client
reports that mismatch. Use a separate UI-dev profile while its sessions run, or
stop the old service deliberately after finishing those sessions. Never delete
conversation records to resolve a protocol mismatch.

To try this build alongside an older running service, use a fresh nested profile:

```sh
npm run dev -- -- --user-data-dir=.clave-ui-dev/plugins-v2
```

The directory is covered by the existing `.clave-ui-dev/` ignore rule. This
changes app state, not provider logins or the machine's shared tmux socket.
Custom provider sessions cannot yet be pinned/exported through the legacy
`.clave` format; those operations fail explicitly instead of creating a terminal.
