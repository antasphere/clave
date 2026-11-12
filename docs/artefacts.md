# Artefacts: an agent's HTML page beside its session

In a Claude Code or Codex tab running inside Clave, ask:

> Make me a one-page report of this and show it to me.

The agent writes a folder holding a self-contained `index.html` and calls `clave_open_artefact` with that folder. The page opens beside the conversation, through [Slideless](https://www.npmjs.com/package/@antasphere/slideless): it reloads on every edit the agent makes to its files, and a version is kept each time a turn of the agent ends. The version bar above the page goes back to any of them. No account is needed.

This works the same whether the session runs on this Mac or on a [Clave server](server-install.md) the Mac is attached to.

## Who owns an artefact

The server a session runs on owns that session's artefact, in every shape a server takes: inside the app, as the app's own child process, or as a daemon on another machine. It keeps four things.

- **The link.** Which session shows which folder (or which single `.html` file) is a document of the server, `artefacts.json` in its data folder. A Mac that attaches later is told, and the link survives a restart of the server. The server keeps the five hundred most recent links; a tab that comes back after a restart finds its own.
- **Its own copy of Slideless.** Each machine that runs sessions installs the command line from the npm registry into its data folder (`slideless/cli`), checks the package against its published integrity hash and runs it with its own Node. Settings → Software Update → Slideless shows each machine's copy and installs or updates it there. A server with no way out to the registry says so in the panel's card and in Settings.
- **The preview.** One `slideless dev` process per artefact, started when a window first shows the panel and stopped a minute after the last one has let go of it, so looking at another tab and coming back finds the page at once (a window renews its hold every thirty seconds; a hold not renewed for ninety seconds is dropped, so a Mac that disappears leaves nothing running).
- **The versions.** They are kept beside the files, in the server's data folder (`slideless/versions`): one history, whichever Mac looks at it. The server saves a version itself each time the session's agent finishes a turn, with no window open and no Mac attached. That holds for a chat and for an agent in a terminal alike, on a server inside the app and on one running on its own.

`clave_open_side_panel` keeps Markdown files and emails, which a person edits (see [linked-documents.md](linked-documents.md)); an HTML page is an artefact and opens with `clave_open_artefact`.

## From another machine: the forwarded port

A Slideless preview listens on the loopback of the machine it runs on. For a session on a Clave server, that is the server, and the Mac's window cannot frame it. Clave carries the page over the connection the two machines already have, one port with a bearer token:

```
the panel's frame ──► a loopback port of the Mac, one per artefact      (Electron main)
                  ──► <server>/forward/<lease>/…  behind the server's token
                  ──► the preview, on the server's own loopback
```

The frame's address is `http://127.0.0.1:<port>/` on the Mac, so the page behaves exactly as it does for a local session. Three things make that true.

- The preview answers only its own host name, and refuses "Save version" from any other origin: the server's route sends the request on with the preview's own `Host`, and with the preview's own `Origin` when the request came from the page itself.
- The preview writes every address from the root of its origin: each artefact gets a port of its own on the Mac, never a path under a shared one.
- The preview reloads the page over an event stream: both hops stream, in both directions. A request body goes up as it is written, an answer comes down as it is written, and a WebSocket opened by a page is relayed frame for frame.

When the server cannot be reached, the frame shows a page that says so and tries again; when the server is back the artefact shows again without being reopened.

## What keeps it private

A forwarded port is a way into files of the server's disk, and the page it carries was written by an agent. Each rule below has a test that fails when its guard is removed.

| Rule                                                                                                                                                                                                                       | Where                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The server's route sits inside its token check: no token, no answer.                                                                                                                                                       | `packages/server/src/runtime.ts`, `forward/route.ts` |
| A lease names a loopback port the server itself registered. There is no way to name a host or a port from outside, and a lease is 128 random bits.                                                                         | `packages/server/src/forward/registry.ts`            |
| What follows the lease in the path is passed on untouched, never resolved: a `..` reaches the preview, not the server's API.                                                                                               | `forward/route.ts`                                   |
| The Mac's port answers only its own host name, so a page of another site cannot reach it through a name it controls.                                                                                                       | `src/main/forwards/loopback-forwards.ts`             |
| The Mac's port answers only Clave's own windows: main adds a secret header to the requests its windows send to that port, and a request without it is refused. Another process, or another user of the Mac, reads nothing. | `src/main/forwards/window-gate.ts`                   |
| The page never sees the server's token or the window header, and cannot supply the header that says "this request came from the page itself".                                                                              | `loopback-forwards.ts`, `forward/route.ts`           |
| A write or a socket from another origin stops at the Mac's port: the secret header says "a Clave window", not "this page", so without this one forwarded page could post to another's server or open a socket on it.       | `loopback-forwards.ts`                               |
| Cookies are not carried in either direction: a browser sends the cookies of one loopback port to every other.                                                                                                              | both hops                                            |
| The frame is sandboxed and on an origin of its own; the deck inside it sits in a second sandboxed frame that Slideless makes.                                                                                              | `SlidelessArtefact.tsx`                              |

Between the Mac and the server, the bytes travel on the connection Clave already uses for everything else, plain HTTP inside Tailscale or an SSH tunnel: an artefact is no more and no less exposed on the wire than a session's conversation.

## What ends with what

A preview is started through a small host script that exits when its input closes. The server holds that input open and never writes to it, so when the server ends, however it ends, the preview ends with it. A plugin's helper process forked by a server exits when the channel to that server closes, for the same reason.

## Checks

```sh
npx vitest run packages/server/src/forward src/main/forwards src/main/artefacts
node tests/e2e/run.mjs slideless-artefacts
node tests/e2e/run.mjs fleet-artefacts
node_modules/.bin/bun scripts/check-artefact-forward.mjs
```

The last one puts the real Slideless command line behind the real route and the real listener and checks the page, its assets, the reload, "Save version", a past version and each refusal.
