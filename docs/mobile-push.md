# Push notifications to the phone

The Clave server tells a paired phone when an agent needs the person (the mobile wave,
lane B; decisions 9 and 10 of the spec `knowledge/specs/2026-10-29-mobile-app.md` on
clave-os, issue #282). It sends to APNs for an iPhone and to FCM for an Android phone, with
credentials of the team's and through no third-party service. Nothing is sent twice: a
message the phone writes carries an id it minted, and the server treats a second arrival of
the same id as the first.

Code: the contract `packages/contract/src/notify.ts` (the categories, the payload, the two
owner's routes), the server's `packages/server/src/notify/` (the dispatcher, the two
transports behind one port, the recording fake, the credentials), the write ledger
`packages/server/src/sessions/writes.ts`, and the main-process seam that feeds the
dispatcher what the server's own events do not carry,
`src/main/server/session-events.ts` (`observeSessionsForNotify`).

## What is sent, and when

One notification per event, to every push target the server holds:

| Category        | When                                                                                                                                                                                                                        | Text                                                                 | Actions                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `question`      | a new pending request of kind clarification (the standalone server), or a `permission_request` frame carrying questions (the in-process server)                                                                             | the first question, and how many more (`Which branch? (and 1 more)`) | `reply`, `open` on one free-text question; `open` otherwise                          |
| `permission`    | a new pending request of kind permission, or a `permission_request` frame                                                                                                                                                   | the request's description (the tool's name when it has none)         | `allow`, `deny`, `open` when the options carry an allow and a deny; `open` otherwise |
| `secret`        | a new pending request of kind secret                                                                                                                                                                                        | the request's description: what is asked, never a value              | `open`                                                                               |
| `finished`      | a session's state reaching `done` (the server's own `session.state_changed` event)                                                                                                                                          | `<title> finished`                                                   | `open`                                                                               |
| `failed`        | a fatal `error` frame, or the session's process ending with a code other than 0 that no stop or restart asked for; once per session, until it works again                                                                   | `<title> failed` (never the error's message)                         | `open`                                                                               |
| `account_limit` | a `usage.claude_read` or `usage.codex_read` whose tightest window (the most severe, then the most used: the account pool's rule) has 5 percent or less left, or is called critical; once per account, window and reset time | `<label>: <window> has <n>% left`                                    | `open`                                                                               |
| `test`          | `POST /notify/test` only                                                                                                                                                                                                    | `Test notification from <machine> to <device>`                       | `open`                                                                               |

A question, a permission or a secret waits 1.5 s before its push leaves, and is pushed only
when it is still pending then: a request answered on the Mac in that time is never pushed.
Nothing is pushed when a request is answered; the phone refreshes the pending requests
when it opens.

The in-process server (the app's own) has no pending-requests service, so it reads the
frames of the sessions' streams instead; the standalone server (the app's separate child, a
daemon) has one, and reads it alone: never both for one request.

## The payload

```json
{
  "category": "question",
  "serverId": "6f1c…",
  "serverName": "Valentins-MacBook-Pro",
  "sessionId": "clave-…",
  "sessionTitle": "Fix the build",
  "workspaceName": "clave-app",
  "requestId": "3a9e…",
  "text": "Which branch do we ship from?",
  "actions": ["reply", "open"]
}
```

- `serverName` is the machine's hostname, `.local` dropped. `serverId` is the server's own
  id, the one its push channel's welcome names.
- `sessionId` and `sessionTitle` are empty strings on an `account_limit` and a `test`, which
  are about no conversation. `workspaceName` is the registered workspace the session's
  folder belongs to, else the folder's name; absent when the folder is unknown.
- `requestId` is the id the phone resolves the request with on that server: the pending
  request's id (`POST /requests/resolve`) on a server with a requests service, the frame's
  id (`POST /sessions/write`, a `permission_response`) on the in-process server. It is the
  collapse id of the push (`apns-collapse-id`, FCM's `collapse_key`), so a later push about
  the same request replaces the earlier one on the phone rather than stacking.
- The keys are closed (`NOTIFICATION_PAYLOAD_KEYS`): a transport serialises exactly these.
  No token, no path to a credential, no answer of a question, no environment variable's
  value, no secret's value, no error message, ever: `payload.test.ts` holds every category
  against a list of forbidden fields, and `dispatcher.test.ts` the dispatcher's own
  payloads.

On APNs the push is an alert: the title is the session's title (the machine's name when
there is none), the subtitle the machine's name, the body the text, the sound the default,
the category `clave.<category>` (the app registers its actions under it), the thread the
session's id, and the payload above under the key `clave`. On FCM the message carries the
title and the text as its notification, `android.priority: high`, the channel `clave`, and
every payload field as a string in `data` (the actions joined by a comma) plus `categoryId`,
the same `clave.<category>` as the iOS category, which the Android client
(expo-notifications) reads its action buttons from.

Display text is limited to 500 JSON-escaped UTF-8 bytes, and display titles to 120,
including any ellipsis. Truncation preserves Unicode code points. Both transport bodies
repeat display fields. APNs checks its complete serialized JSON against 4096 bytes;
FCM conservatively checks the notification/data JSON, including keys and values but
excluding the routing-token envelope. If identity data alone exceeds that budget, the
send fails before connecting or exchanging OAuth credentials; routing IDs are never
truncated. These are local checks against the [APNs payload limit](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html)
and [FCM payload limit](https://firebase.google.com/docs/cloud-messaging/error-codes), not
proof of delivery by either provider.

## The credentials and the configuration

Read once at boot from `push/` under the server's data directory: the app's user data for
the in-process server (`~/Library/Application Support/Clave/push/` on a Mac), `<user
data>/server/push/` for the separate server the packaged app starts, `--data-dir`'s `push/`
for a standalone server. A missing file leaves that transport off, logged once as one line
that carries no value (`push: APNs off (no push/apns.json under the data directory)`); a
file that does not parse or lacks a field is logged the same way with the field's name.

`push/apns.json`:

```json
{
  "keyId": "ABC123DEFG",
  "teamId": "TEAM123456",
  "bundleId": "com.antasphere.clave",
  "keyFile": "AuthKey_ABC123DEFG.p8",
  "sandbox": false
}
```

The `.p8` key sits beside it (`keyFile` is relative to `push/`; an absolute path works too).
`sandbox: true` sends to `api.sandbox.push.apple.com` instead of `api.push.apple.com`: a
build run from Xcode on a device takes the sandbox, a TestFlight or App Store build the
production host. The provider token is signed with the key (ES256) and reused for 50
minutes.

`push/fcm-service-account.json` is the service account's key file as Firebase hands it out
(`project_id`, `client_email`, `private_key`, `token_uri`). The OAuth token it buys is
reused until a minute before it expires.

Both files hold credentials: keep them readable by the owner alone, and never commit them.

`--push-fake` on either entry (the app, the standalone server) puts a recording transport
and a fake phone registry in place of both: the end-to-end suite runs on it, and so can a
machine with no credentials yet. The status route says `fake: true` then.

## The owner's routes

Behind the server's bearer token, like every route; a phone's device session (lane A of
the wave) is scoped to what a phone does and never reaches them.

```sh
curl -H "authorization: Bearer $CLAVE_SERVER_TOKEN" "$CLAVE_SERVER_URL/notify/status"
# {"transports":{"ios":true,"android":false},"fake":false,"targets":2,"serverName":"Valentins-MacBook-Pro"}
curl -H "authorization: Bearer $CLAVE_SERVER_TOKEN" -H "content-type: application/json" \
  -d '{"deviceId":"<the phone's device id>"}' "$CLAVE_SERVER_URL/notify/test"
# {"deviceId":"…","platform":"ios","result":{"outcome":"sent"}}
```

A `gone` outcome (APNs 410 or `BadDeviceToken`, FCM `UNREGISTERED`) means the platform no
longer knows the token: the server forgets it on the phone's record, and the phone registers
again at its next launch. A `failed` outcome carries the platform's status and reason,
never the token.

## What a teammate must obtain

Checked on 29 October 2026: none of this exists on this machine, in Steward's secret files
(which declare no secret file for the app repository) or in the repository's CI secrets
(the macOS signing and notarization credentials only). Until they exist, a push reaches a
simulator only, through the fake.

- **APNs**: an APNs authentication key from the Apple Developer account (Certificates,
  Identifiers & Profiles → Keys → a key with the Apple Push Notifications service enabled),
  downloaded once as `AuthKey_<Key ID>.p8`, with its **Key ID** and the account's **Team
  ID**, and the app's **bundle id** (the `apns-topic`). One key serves every app of the
  team, production and sandbox alike.
- **FCM**: a Firebase project with the Android app registered (its `google-services.json`
  goes in the app, lane C), the Firebase Cloud Messaging API (v1) enabled, and a service
  account key (Project settings → Service accounts → Generate new private key) with the
  Firebase Cloud Messaging Admin role, saved as `push/fcm-service-account.json`.

## Nothing is sent twice

The seam `seam-write-status.md` of 29 October 2026, shared with the phone (lanes C and D),
is the definition; this is the server's side of it.

A `user_message` written to `POST /sessions/write` may carry `clientMessageId`, 8 to 64
characters of letters, digits, dot, underscore, colon and dash, minted by the client. The
server keeps a **ledger per session**, persisted under `write-ledger/` in its data
directory and complete for the session's life: every id ever received is kept with its
status, nothing is evicted. Two phases are written before the provider is touched:
`received` when the write arrives, before the session is even checked, then `dispatched`
immediately before the message is handed to the provider; then `accepted` with when the
provider took it, or `rejected` with a short reason (never the message's text). A phase
that cannot be persisted refuses the write, so an entry exists only once it is on disk.

The write answers `{ "status": "accepted", "at": <when> }`. A second write with an
accepted id answers the first result and writes nothing; with a pending id (received or
dispatched) it answers `{ "status": "pending" }` and writes nothing; with a rejected id it
is refused (`SessionWriteRefused`) with the recorded reason, so a resend takes a new id;
with an unknown id it is refused as `SessionWriteUnknown` and writes nothing, so a resend
is always a new id and always the person's. An id the ledger does not hold is a first write only when the ledger is complete and the acknowledged write history does not contain it. Otherwise it is refused as unknown.

`GET /sessions/writes?id=<session>&clientMessageId=<id>` answers `{ status, at?, reason? }`,
from the ledger alone, whether or not the session still runs:

| Status     | Meaning                                                                                                                                                 | The phone (the seam's table)                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `accepted` | the provider took it (the ledger holds it, or the server's own history of writes carries the id); `at` is when                                          | clears the draft                                           |
| `pending`  | received, not settled yet                                                                                                                               | asks again with backoff, at most 60 s                      |
| `rejected` | the provider refused it, or the server restarted before the dispatch (`server restarted before dispatch`)                                               | keeps the draft, shows the reason; a resend mints a new id |
| `absent`   | the ledger is intact and complete and never saw the id: the write never arrived. Never decided from a history page, a retention limit or a partial read | completes the same send with the same id, once             |
| `unknown`  | the ledger is missing, unreadable or incomplete, or the server stopped between the dispatch and the provider's answer                                   | sends nothing by itself; the person decides, with a new id |

**The server's own history of writes** is the second file (`<session>.history.json`, beside the
ledger): every `user_message` carrying an id is recorded as it passes on the session's
stream, from where the sessions live and independently of the write's handler, on the
in-process server and the standalone server alike. It is the durable evidence that
settles a `dispatched` entry as `accepted` after a restart. Recovery at boot preserves
uncertainty: an entry left at `dispatched` becomes `unknown` unless that history carries
the id; an entry left at `received` was provably never handed to the provider and becomes
`rejected`; nothing is resent by the server, ever. A crash between the dispatch and the
provider's acknowledgement is therefore an `unknown`, by design. A ledger file that cannot
be read is put aside and started again marked incomplete: an id it does not hold then reads
`unknown`, never `absent`.

The first upgrade initializes the host's existing saved and live session identities before
opening the API, only when neither the ledger directory nor `write-ledger-activation.json`
exists. The activation record lives outside the ledger directory and is written first.
A later missing or corrupt ledger, a missing whole directory, or a partially completed
activation stays unknown and is never migrated again. An unknown arbitrary session is not
initialized by this migration. This keeps an existing desktop conversation usable on its
first phone connection without treating lost delivery records as a fresh conversation.

After activation, only a lifecycle creating a new session identity initializes an empty complete ledger.
Restoring an identity never does. A missing ledger is unknown even if a surviving history
contains other ids. If the whole ledger is incomplete, unknown ids are refused, including
new ids: restore the ledger or start a new session before sending more identified messages.
A history-proven accepted id still returns its original result without dispatch.

Identified Codex writes wait for the turn/start or turn/steer acknowledgement before emitting
the user-message evidence. Identified Claude writes wait for the stdin write callback.
A lost transport acknowledgement stays unknown and never authorizes a retry of that id.
Messages without a client id retain their existing behavior.

The reproducible `mobile-notify/write-once` fixture dispatches the same identified message
twice through `WriteSession`, then checks one provider-port write and persisted status over HTTP.
Run `CLAVE_E2E_NS=mobile-b npx vitest run packages/server/src/sessions/writes.fixtures.test.ts`.
It retains a receipt under `/tmp/mobile-b/write-fixture-*/receipt.json`; this isolated fixture
uses a recording session port, no real provider. Remove only that run directory to clean up.

The status query and repeated-write admission share one acceptance rule. A recorded first
accepted result keeps its original timestamp. Otherwise durable acknowledged history settles
received, rejected or unknown records as accepted, including a crash after the history write
but before the primary ledger update. Replayed evidence never replaces the first result.

A message with no id is written every time, as before, and answers `accepted`.

## Verification

- `npx vitest run packages/server/src/notify packages/server/src/sessions/writes.test.ts src/main/server/session-events.test.ts packages/contract/src/sessions.test.ts`:
  every category's dispatch and payload against the recording transport, the forbidden
  fields, the collapse ids, the grace, the once-per-window rule, the two transports
  against local fakes (an h2c fake APNs that verifies the provider token against the
  public half of a test key and answers 200, 410, 400 and 429; an HTTP fake FCM that
  verifies the service-account assertion, hands an OAuth token and answers success and
  `UNREGISTERED`), the gone path forgetting the token, the credentials files, the write
  ledger (the two phases, the five statuses, the second write on every state, the recovery
  rules on what a previous process left, the file storage surviving a restart), the status
  query over HTTP, and the main-process observation.
- `node tests/e2e/run.mjs mobile-notify` (after `npx electron-vite build`): the real app
  attached to a standalone server started with `--push-fake`, where a question raised by
  the echo adapter produces one recorded push with the session's id and the question's
  text, and a message written twice with one client id appears once in the history, reads
  `accepted` on the status route, and sits accepted in the ledger file under the server's
  data directory.
- Nothing in any test reaches Apple or Google.

## Not in this change

The pairing of a phone and its push token (the devices domain, lane A of the wave), the
phone's handling of a push and its actions (lanes C and D), and a push on the resolution of
a request (the phone refreshes the pending requests when it opens). The delivery by APNs
and FCM to a real phone is NOT RUN until the credentials above exist.
