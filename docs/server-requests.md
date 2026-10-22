# Shared agent requests

Daemon mode owns pending requests and agent MCP in the server process. A client
disconnect does not answer, expire or cancel them. Native permission and question
events are captured before clients subscribe. A later subscription replays native
prompts, and the request query returns all current pending work.

`api.requests.list()` returns `{ revision, pending }`. Request IDs and session IDs
belong to this endpoint. Fleet consumers must pair them with their server identity
and send answers to that same endpoint. `api.requests.watch(push, listener, onError)`
refreshes on connection and `requests.changed` events. It discards superseded
queries, so an earlier pending snapshot cannot resurrect an answered request.

`api.requests.resolve({ requestId, response })` accepts a permission option, question
answers, a secret value, or dismissal. An invalid answer leaves the prompt pending.
The first valid answer reserves it before any provider write or asynchronous action.
Further attempts return `{ accepted: false }`. Accepted means the resolution was
claimed; a failed action remains terminal and is not automatically executed again.
Closing the session or stopping the daemon cancels pending work. A finished or
cancelled provider turn also removes its native prompts.

Questions may carry a stable `id`. Answer records, input state and masking use
`question.id ?? question.question`. Older questions without IDs keep their text
keys. Native Codex questions carry the original provider IDs, so identical prompt
text can identify separate inputs. Display `question` and `header` unchanged;
never use display text as an alias for an ID-bearing question. A form requires
exactly one nonblank answer per canonical key. `secretQuestions` contains these
same keys, so a private question remains distinct from a public one with the
same text. Session event schemas and pending snapshots preserve the IDs.

Secrets travel only in the authenticated resolution POST body and the approved
action's function call. They never appear in request snapshots, events or polling
results. Secret action output is also omitted, including redacted stdout/stderr.
The native env-file action writes the value on the owning server; a run action
injects it into a subprocess environment. Clients review the action before answering.
Do not ask for sensitive values through ordinary clarification questions.
Malformed resolution and legacy session-write payloads return generic validation
errors without copying answers or question keys into HTTP problem details.

The daemon starts an authenticated loopback MCP listener for its own agent
processes. Existing per-session token configs establish the caller; a request
parameter cannot impersonate another session. `clave_request_approval`,
`clave_request_clarification` and `clave_request_secret` return a `requestId`
immediately. Poll `clave_request_result` or `clave_secret_result` from the same
session. These tools keep working when no Mac is attached. An attached desktop's
MCP announcement cannot replace this endpoint. The legacy app-child mode retains
its desktop announcement behavior. The daemon also exposes server-owned list,
session read and session messaging tools; desktop window/editor tools remain
desktop operations.

Pending records are in memory for the daemon's lifetime, capped at 1000 records
including recent outcomes and at 128 KiB of metadata per request. Pending work has
no elapsed-time expiry. Terminal results are kept for ten minutes for late polling.
The resolution HTTP body is capped at 64 KiB before decoding. Secret subprocesses
have a sixty-second timeout. A server restart restores stopped sessions through
the lifecycle host; it does not replay old answers or secret actions. Requests from
the stopped provider must be issued anew after explicit Resume.

The reproducible `shared-requests/answered-approval` fixture takes the ID of a
run-scoped real MCP approval and resolves it through `ResolvePendingRequest`.
Run `npx vitest run packages/server/src/requests/requests.fixtures.test.ts` to load
and verify the scenario against isolated HTTP/MCP listeners. Its receipt remains
under `/tmp/clave-vps-d-impl/fixture-*/receipt.json`. The fleet acceptance lane
composes the two-client Electron scenario with the same domain interfaces.
The same test file also loads `shared-requests/answered-native-questions`,
rejects a malformed private answer over HTTP, resolves distinct IDs with identical
prompt text through the command bus and checks the exact provider response.
Receipts omit submitted answers. Set `CLAVE_E2E_NS` to keep each run's data separate.

Canonical question admission rejects empty keys, keys longer than 16,384 characters, and `__proto__`, which the installed Effect answer-record decoder drops. The key is exactly `q.id ?? q.question`. Supported keys, including `constructor`, are preserved unchanged. Native adapter rejection happens before a prompt is emitted; all other producers use the same pending-service guard.

Authenticated JSON POSTs to `/sessions/write` and `/requests/resolve` receive a syntax check before API decoding. Malformed JSON keeps the generic HTTP 500 `InternalServerError` response, with no body excerpt or parser exception in diagnostics. Only a static warning is logged. Valid JSON still passes through the normal schema and domain validation; unsupported keys are rejected before pending admission. Existing authentication, body limits and other endpoint handling remain in place.
