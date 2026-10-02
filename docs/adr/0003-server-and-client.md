# ADR 0003: the server apart from the client

Status: accepted, 2026-10-02 (wave 1 of the split: the shell boots `@clave/server` in-process or attaches to one running on its own, and the suite drives both); amended the same day from lane A's gate (runtime-agnostic server layers, the push channel on the server's own port)

## Context

Clave is one Electron program. Measured on `dev` at fb8abba: a main process of about 44k lines in which 71 modules import `electron`; a flat preload of 291 methods over 235 IPC channels, called from 489 sites in 108 renderer files, with no client wrapper; the sidebar truth (groups, tabs, layout) in each window's renderer store, so the MCP server answers 20 of its tools by asking a renderer; about 25 JSON files under the user-data directory, each written by its own manager; secrets through Electron's `safeStorage`. The sessions module (`src/main/sessions/`) is the one seam already shaped like a wire contract. The end-to-end harness proves the app by reaching inside that one process (`app.evaluate` on `ipcMain` and `BrowserWindow`), so any change of transport breaks every spec.

Valentin, 2 October 2026: "Right now clave is running as a single program, everything in an electron app. I want to be able to split server from the client. You shall use @structure-ai framework for event messaging."

`@structure-ai` 0.2.1 (Ligerian-labs/structure) is Effect 3.22 and Effect Schema. Its event messaging is domain events on aggregates, an event store with projections, a transactional outbox and an idempotent inbox, schema-typed command and query buses. Two measured facts shape the split: the framework pushes nothing to a client (no WebSocket, no SSE; `http.serve` takes raw mounts but exposes no upgrade hook), and node-pty, from the app's own `node_modules`, loads under Bun 1.3.14 and never emits a byte, while under Node it works.

The full record, with the nine decisions and the measurements behind them, is the spec `knowledge/specs/2026-10-02-server-client-split.md` on `clave-os`.

## Decision

The server is a package on the framework, and the split is a strangler: the server first runs in-process inside Electron main behind the bus, then as its own process. Every lane merges into `dev` and the app works at every merge. There is no `[major]` release marker until the out-of-process server ships to users; the framework is pinned at 0.2.1.

### What is event-sourced, and what is not

Workspaces, groups, tabs, session records, accounts, launch profiles and preferences are aggregates with projections; the sidebar is a read model. PTY bytes, provider frames, usage reads and git status are ephemeral streams, never in the event store. The event store is in memory in wave 1.

### Runtime and the push channel

The server's layers are runtime-agnostic and the listener comes from an adapter: Node when the server runs inside the app, Bun when it runs alone. The PTYs stay with a Node process until a Bun-native PTY is proven. The push channel is one WebSocket upgrade on the server's own HTTP port, owned by Clave, carrying server-to-client events and session bytes with reconnection and per-session subscriptions. A second WebSocket handler on that port corrupts frames, so nothing in the shell and nothing in the harness listens on or upgrades that port.

### Topology and secrets

A local daemon on the loopback with a bearer token, the MCP server's shape, spawned and attached by the app. Reachability from another machine is designed for and not built. Secrets at rest go through a secret port with two adapters: `safeStorage` while the server runs in-process, the macOS Keychain through the `security` CLI for the standalone server. The new contract is Effect Schema; zod stays where the renderer still reads it and retires lane by lane.

### What stays Electron's

Windows (`window-registry.ts`, `window-routing.ts`, `window-state.ts`), the app menu, the auto-updater, view guests, the preview protocol, dialogs, clipboard, notifications, the haptic and mission-control helpers, and the plugin host in these two waves. The renderer keeps `window.electronAPI` for those.

### How the shell gets its server

`src/main/server-boot.ts`, called once at `app.whenReady`:

- **In-process**, the default and what the shipped app does: the shell calls `startClaveServer` (`src/main/server/clave-server.ts`, lane A's), which starts `@clave/server` on Node's own listener over the session manager, publishes the address to the windows, and gives the boot the url, the token and `stopClaveServer`.
- **Attached**, under `CLAVE_SERVER_URL` with `CLAVE_SERVER_TOKEN`: the shell uses a server somebody else started and starts none of its own.

Either way the shell then registers itself with the server (`POST /clients`, as `shell`, named `clave-shell <version>`, with its pid) and writes `clave-server.json` in the user-data directory (the url, the token, the mode, `ok`, the client id; mode 0600, write-then-rename, after `mcp-server.json`). On quit it waits for a boot still in flight, deregisters, and, when the server is its own, stops it.

The token belongs to what is meant to call the server: the shell, the client, the harness. It lives in that file and in the shell's handle, and the renderer's client gets it from main over IPC alone, on the channel the contract names (`server:endpoint`, answered with `{ url, token }` or null while there is no server). The two variables an attach is asked with are read once at boot and taken out of the main process's environment there, before anything spawns. An export there would reach every helper main spawns off `process.env` (git, `gh`, the Codex app-server, the plugin runner) and none of the sessions, which get their environment from the login shell read once at boot and from tmux's own `update-environment` list; neither is wanted. A session or an agent that must reach the server is handed the address deliberately, when the sessions move to the server (wave 2), and the server spec pins the claim: a terminal the app spawns sees neither variable.

An attach that fails (nothing answers the url, or the token is refused) is never papered over by starting the in-process server instead. The app runs without a server, the failure is in the log, in the discovery file as `ok: false` with the url that was asked for, and on screen as a notification outside test mode. In this wave nothing the window shows comes from the server, so the app stays usable; once the domains move, a server that cannot be reached is a boot failure.

### What the shell expects of the server

The shape lane A's contract carries (`packages/contract/src/clients.ts` and `api.ts`: the clients group beside the framework's health group), as the server answers it in both shapes:

| Call                                   | Answer                                       | Token  |
| -------------------------------------- | -------------------------------------------- | ------ |
| `GET /health/live`                     | 200 `{ status: "live" }`                     | none   |
| `GET /health/ready`                    | 200 `{ ready, checks }`                      | none   |
| `POST /clients` `{ kind, name, pid? }` | 201 `{ id, kind, name, pid?, registeredAt }` | bearer |
| `GET /clients`                         | 200 an array of those, oldest first          | bearer |
| `POST /clients/unregister` `{ id }`    | 204, or `ClientNotFound`                     | bearer |

`kind` is one of `shell`, `browser`, `agent`, `other`; the Electron shell registers as `shell`, named `clave-shell <version>`, with its pid. Bound to 127.0.0.1. A wrong or missing token is a 401, compared in constant time. The push channel is a WebSocket upgrade at `/push` on that same listener, lane A's; the shell and the harness never upgrade it.

### The server as its own process

`scripts/server-process.mjs` is the one place that names the command, for the dev script and the harness alike. The process binds the loopback, writes `clave-server.json` into its `--data-dir`, and prints one JSON line `{"url","token"}` on stdout once it listens; whoever started it hands the pair to the app. The command runs `src/main/server-entry.ts` under Bun, which runs the TypeScript as it is: `@clave/server`, the same package the app runs in-process, over an empty session source, because until the sessions move to the server (wave 2) a standalone server has none to answer for; a client sees the same API, the same token check and the same push channel either way. `npm run dev:attached` starts the server and `electron-vite dev` attached to it and stops both together; `npm run dev:server` starts the server alone and prints the two variables for a dev app started by hand. The server's dev data lives under `~/.clave/server-dev`.

### The harness

`tests/e2e/harness.mjs` runs the suite two ways, and the way is `CLAVE_E2E_SERVER`: `in-process` (the default) or `attached`, where `launchApp` starts one server per spec on its own data directory and port before the app and stops it with `app.close()`. A spec that must prove one path whatever the suite runs passes `server: 'attached'`, `'in-process'` or `{ url, token }`. In in-process mode a stray `CLAVE_SERVER_URL` in the caller's shell is dropped, so the app never attaches by accident. `serverEndpoint(dir)` reads the discovery file; `serverClient(url, token)` is the server's HTTP API, and it is how a spec asserts on the server, never a hook inside main. `run.mjs` names the mode on both ends of its output. `listeningPorts(pid)` asks the OS what the main process serves, which is how a fallback on another port would show. `tests/e2e/server-boot.spec.mjs` proves four things, in-process and attached: the app is on its server and a spawned terminal sees no token; an attached app registers and deregisters; a dead url leaves the app on the MCP port only; a quit during a slow registration leaves no ghost client. Its header says which mutation turns which line; the round-1 verifier proved six of eight and the two it did not are now pinned (the ports, the crash rule below).

`run.mjs` reads `tests/e2e/known-failures.json`, the named failures of `dev` itself: `specs` lists the checks that fail on every machine we measured, by spec and check name, printed `KNOWN` and counted apart; `unstable` lists the specs that crash before finishing or fail differently from one run or machine to the next, printed `UNSTABLE`, counted apart, and explicitly not a gate until fixed. A `<spec> ran to completion` check can never be listed as known: it is the runner's own, raised when a spec throws, and listing it would absorb every crash of that spec with exit 0. A listed check that passes, or an unstable spec that passes in full, is reported at the end so the file shrinks. Measured on 2 October 2026 on `dev` at fb8abba: 25 failing checks on a laptop, 28 on `macos-latest`, 15 in common; 10 checks in 7 specs are known, 11 specs are unstable. The branch on the same list: 1801 passed, no failure of its own.

The 19 specs that reach inside the main process (`spyPtySpawn` on `pty:spawn`, the dialog and clipboard stubs, the menus) stay as they are: their subjects have not moved to the server in this wave, and a client that does not exist yet cannot assert them. They move with the sessions in wave 2.

### CI

`.github/workflows/checks.yml` gains an end-to-end job on `macos-latest` for pull requests and pushes to `dev` (Bun and tmux installed by the job, the app built from the checkout). What it proves: the server spec passes with the server in-process and with the server attached to its own process. Those two steps are the gate and fail the job. What it does not prove: the rest of the suite. The whole suite runs in-process as a third step with `continue-on-error`, its result line written to the job summary, because on 2 October 2026 the suite on `dev` is not deterministic across machines (the figures above) and a gate that is red on a healthy branch is a gate nobody reads. That step becomes a gate by dropping `continue-on-error` once the unstable specs are fixed (PRDCT-1762 and PRDCT-2542 name the boot race and the launch timeout; PRDCT-1711 carries the thread). Its first run, on the draft pull request that proved the job, took 32 minutes. The release rail (`release.yml`, `build-win.yml`) is untouched.

## Consequences

- The app works at every merge, and the server is a swap of one line when the package lands; nothing on screen changes in this wave.
- The server's packaging as a second binary is not in `electron-builder.yml`. Listed debt, with the out-of-process server's release.
- The PTY sidecar, the durable event store adapter and the move of the sidebar truth are wave 2's, batched again from what wave 1 merged. Out of both waves: the plugin host, git, GitHub, SSH, locations, OpenClaw, linked documents, a browser client.
- The e2e suite on `dev` carries failures that predate the split and do not depend on it. They are named in `known-failures.json`, printed in every run, and the unstable specs are off the gate by name rather than by a filter that would hide a crash. Fixing them is the work PRDCT-1762 and PRDCT-2542 describe, not this lane's.
