# What a paired phone reads beyond its sessions

A paired phone (a device session, `docs/mobile-pairing.md` on the mobile branch) is held to the
allowlist in `packages/server/src/devices/scope.ts`. The UX round of 13 November 2026 added six
reads to it, so the phone can keep the desktop's sidebar groups, show the Mac's agent accounts and
their limits, and name the Mac's Clave version in its settings. Every one of them is a `GET` with no
body; the owner's token reaches them too.

| Call                         | Answer                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /sidebar/overview`      | `{windows: [{windowKey, workspaceId?, displayOrder[], groups: [{id, name, color?, collapsed, workspaceId?, sessionIds[]}]}]}` |
| `GET /accounts/claude`       | `[{id, label, hasToken, tokenSetAt, tokenExpiresAt, tokenInvalid}]`                                                           |
| `GET /accounts/codex`        | `[{id, label, kind: "chatgpt" \| "apiKey", hasCredential}]`                                                                   |
| `GET /usage/claude/snapshot` | `{<accountId>: {windows: [...], fetchedAt, message?} \| {error, reason?}}`                                                    |
| `GET /usage/codex/snapshot`  | the same shape, for the Codex accounts                                                                                        |
| `GET /server/info`           | `{version, installRef, upgrade: {supported, reason?, state, ...}, name?}`                                                     |

## The sidebar overview

The overview is a projection of every window's layout, built at each call by
`packages/server/src/sidebar/overview.ts`. Each window keeps its groups and its top level in the
layout's own order. A group keeps its name, its colour (left out when it has none), whether it is
folded, its workspace and its member sessions. Nothing else crosses: no quick-launch terminals (their
commands and folders), no prompt, no folder, no view. `displayOrder` holds group ids, standalone
session ids and file-tab ids; a phone skips any id it does not know. A running group terminal is not
among a group's `sessionIds`.

Where the layouts come from depends on how the Mac runs its server:

- **In the app's process** (`npm run dev`, `--server=in-process`): the app's own layouts, every
  window, each with the workspace it shows (`windows.json`).
- **As the app's child** (`--server=separate`, the packaged default on macOS): the layouts stay in the
  app's process, and the child holds none. The app starts the child with `--shell-data-dir <userData>`,
  and the child reads the app's layout files (`<userData>/sidebar-layouts/windows/*.json`) and window
  list (`<userData>/windows.json`) at each call. It never writes them. Windows come in the app's
  order, with their workspace. A layout file whose window the list does not name comes after, by key.
- **A daemon** (`--daemon`): its one shared sidebar, under the key `server`, with no `workspaceId`,
  since it shows every workspace.

The full layouts (`GET /sidebar/layout`, `GET /sidebar/layouts`) and every sidebar command stay the
owner's.

## Accounts and limits

The account lists carry `hasToken` and `hasCredential`, never the token or the credential: the
contract's views (`packages/contract/src/settings/accounts.ts`) name no such field, and the HTTP
boundary encodes the view, so a field the source adds is dropped before the answer leaves.

The two snapshots are the server's cached last read of every account, the same cache the Mac's
sidebar foot reads (`AccountUsageManager.snapshot()` in `src/main/usage-manager.ts`): reading one asks
no provider anything. Their payload is empty, so a `force` the phone sends is ignored. The live reads
(`GET /usage/claude`, `GET /usage/codex`), which can ask the provider, stay the owner's. A read that
failed is `{error, reason?}`; `reason: "unauthorized"` means the provider refused the credential.

## Events

A phone hears `sidebar.overview_changed`, which carries nothing: it means "read the overview again".
The server publishes it at every change of the layouts, or at every save the child sees in the app's
layout folder, a quarter of a second after the files settle. It never hears `sidebar.layout_changed`,
which carries the whole layout. It still hears the `usage.*` reads as they land, which is when a
limits screen should update. It does not hear `accounts.*`: a phone reads the account lists again
when it shows them.

## The chat's own writes

`POST /sessions/write` takes every input kind of `SessionWireInput` from a phone, on any session the
phone may write to, with no extra filter:

```json
{"id": "<session>", "input": {"type": "set_model", "model": "claude-fable-5-1", "remember": false}}
{"id": "<session>", "input": {"type": "set_model", "model": null}}
{"id": "<session>", "input": {"type": "set_effort", "effort": "high"}}
{"id": "<session>", "input": {"type": "set_permission_mode", "mode": "acceptEdits"}}
{"id": "<session>", "input": {"type": "stop_task", "taskId": "<task id>"}}
{"id": "<session>", "input": {"type": "permission_draft", "id": "<request provider id>", "answers": {"<key>": "value or [values]"}}}
{"id": "<session>", "input": {"type": "interrupt"}}
```

A phone's write is answered `{status: "accepted", at}`. An effort outside `^[a-z][a-z0-9_-]{0,31}$`
is refused with a 400 and written nowhere.
