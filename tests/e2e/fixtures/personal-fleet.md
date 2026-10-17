# Personal fleet acceptance

Build once, then run the original two-server/two-client scenario in an isolated namespace:

```sh
npm run build
SHELL=/bin/sh CLAVE_E2E_NS=clave-vps-f-impl node tests/e2e/run.mjs fleet-
```

The six `fleet-*.spec.mjs` files cover fixture capability/isolation, stable daemon restart endpoints, two desktop clients, files and images, recovery, and native/MCP pending requests. Every failed assertion makes the runner exit nonzero. Run one spec with its filename filter, such as `fleet-recovery`.

`fleet-world.mjs` starts two standalone loopback owners on OS-assigned ports and hidden Electron clients with distinct user-data directories. The daemon helper is independent of client close and registered for exact-process deadline cleanup. Restart reuses that owner's address and private data. The harness never shows the test windows or changes the installed Clave app. All data lives under the chosen `/tmp/<namespace>`.

The named `@structure-ai/fixtures` scenario is `personal-fleet/two-owners`. The fixture spec calls the repository Bun with `tests/e2e/fixtures/personal-fleet.mjs --load`. Its JSON input arrives on stdin: an explicit `enabled` capability, namespace, private receipt path, and two owned loopback endpoints with their tokens and session roots. Tokens never appear in command arguments, output or receipts. Do not supply another environment's endpoints. Capability defaults to false. The scenario dispatches fixture commands through the framework bus; their handlers call the real authenticated session, sidebar and file commands. It does not write business tables or construct event histories.

One shared fixture instance allocates session/group/directory identities for both owners, producing intentional raw-ID collisions. Every invocation gets a fresh run UUID and new identities. Readiness queries verify the created files/sessions. The spec then checks real history and disk contents. Progress receipts preserve completed steps after partial failure. Successful receipts include run ID, record IDs and data locations. The runner prints their safe locations. Earlier receipts and files remain for inspection; a retry creates a new generation and does not roll back the earlier one.

Every `world.load()` call allocates a unique receipt filename, including repeated default calls. The loader reserves a supplied filename exclusively before creating records or writing progress. Reusing an existing receipt is refused, preserving its bytes and earlier data. The fixture check exercises both cases through real commands.

The file spec connects each desktop through a test-owned loopback forwarding observer for each real daemon. HTTP responses and WebSocket bytes pass through unchanged. Only method, route and response status are recorded. Each UI list/read/edit/Upload/download and second-client read must reach the selected endpoint with no matching peer request, in addition to preserving exact byte assertions. This distinguishes the serving daemon even though both processes share the host filesystem. These observers are test resources; they are not application preview tunnels. Their listeners and sockets close with the owned world.

The first-agent check reads the actual created cwd from the owner's authenticated sessions API and compares its canonical path to the selected server folder. Remote creation must leave the peer and local session inventories unchanged. File navigation waits for the visible current folder and stable control geometry before normal Playwright clicks. Reconnect checks observe live owner snapshots and connected badges before selecting the session. Named transition timing identifies detach/quit/reopen/catch-up failures without extending timeouts or force-clicking.

Echo is a local recording adapter for ordinary chat paths. Recovery uses the real Codex adapter with `fleet-provider.mjs`, a local stdio recording process that never invokes a model. Its history mode supplies a durable chat event; its request mode supplies native approval and private clarification. Pending explicit requests use the daemon's real MCP endpoint and its generated test-session configuration. Synthetic secret actions write only a run-owned fixture file. Title generation uses `fleet-title.mjs` through an isolated test setting. Native Open/Save pickers return run-owned paths; the application performs the real uploads, downloads and image preparation.

The specs stop their own apps and daemons in `finally` and retain data. File deletion has no application command, so no fixture cleanup command or automatic rollback is provided. No shared target is reset. Remove retained test resources only after checking that their generation is no longer needed and their owned processes have stopped.

This recipe emulates two Macs and two standalone servers on one macOS host. It does not prove a real VPS/Tailscale link or suspend the host computer. The detached interval exercises a client that consumes no server traffic. Contremaitre remains the application-preview workflow. Passing functional checks does not replace any independent prerequisite review.
