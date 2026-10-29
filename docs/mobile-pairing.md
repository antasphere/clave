# Pairing a phone with a Clave server

A Clave server admits a phone as its owner's and nobody else's (the spec
"Clave on the phone" on clave-os, decision 3; issue #281). The server already
knows its owner: the Antasphere account signed in on it (`docs/antasphere-account.md`).
A phone signed in with the same account proves it is that person's once, asks
to pair, waits for the owner's word on the Mac, and from then on holds a
credential of the server's own, the device session, kept to what a phone does.

Code: the wire contract in `packages/contract/src/devices.ts`; the domain in
`packages/server/src/devices/` (the port, the identity token, the store, the
pairings, the scope, the service, the handlers, the events, lane B's seam
`push-targets.ts`); the token check in `packages/server/src/auth.ts` and the
push handshake in `packages/server/src/push/`; the typed client in
`packages/client/src/devices.ts`; the entries' wiring in
`src/main/server/devices-port.ts` (both entries), `devices-shell.ts` and
`devices-notify.ts` (the Mac); the page in
`src/renderer/src/components/settings/MobileSection.tsx` over
`src/renderer/src/store/mobile-store.ts`.

## The flow

1. **The phone signs in at the hub** as a native client of its own (its own
   dynamic registration, so its own client id) and holds an ID token: RS256,
   `aud` the phone's client id, `sub` the person.
2. **The phone asks**: `POST /devices/pair` with the ID token, the client id
   it registered, and how it names itself (`{name, platform: 'ios'|'android',
   appVersion}`). No bearer: the proof is in the body. The server checks the
   owner is signed in (before it fetches anything), then the token: a compact
   JWS signed RS256 or ES256 with a key the hub publishes (read through
   `/.well-known/openid-configuration` and the `jwks_uri` on the issuer's
   origin, cached a day, read again at most once a minute on an unknown
   `kid`), `iss` the configured issuer (`CLAVE_ANTASPHERE_ISSUER`, the hub by
   default, the same rule as the account manager), `exp` and `nbf` with 60 s
   of skew, `aud` the client id sent (a string or a list holding it), `azp`
   that client id when present, and `sub` the owner's subject. A refusal
   names the check (`DevicePairingRefused`, 422) and never the token; a
   server with no login answers `CapabilityUnavailable`. The answer is
   `{pairingId, expiresAt}`: a pairing that waits ten minutes, and the Mac
   shows a notification when no window is focused.
3. **The owner decides** in Settings → Mobile: the phone appears by name and
   platform under "Phones asking to pair", with Approve and Refuse. Nothing
   is issued before the approval.
4. **The phone reads the answer**: `GET /devices/pair?id=` answers `{status}`
   (`pending`, `approved`, `refused`, `expired`); on `approved` the answer
   carries `deviceSession: {token, deviceId, serverId, serverName}` exactly
   once, consumed by that read. The token is 32 random bytes in hex; the
   server keeps its SHA-256 and nothing else. An unknown or forgotten pairing
   reads `expired`; a settled one stays readable for ten minutes.
5. **From then on** the phone presents the token as a bearer on the API and
   in the push channel's `hello` frame (its `token` field; the server tells
   the two credentials apart by hash). Every call records the phone's
   last-seen time, at most once a minute.
6. **Revoked** from the same page, or by `POST /devices/revoke`: the next call
   is refused (401), its sockets are closed with code 4011, the record is gone.

Pending pairings live in memory: a server restart drops them and the phone
asks again. At most 32 wait at once; the next is told to try later (`busy`).

## The routes

| Call | Who | Answer |
| --- | --- | --- |
| `POST /devices/pair` | anybody (16 KiB at most) | `{pairingId, expiresAt}`, or 422 `DevicePairingRefused {check}` / `CapabilityUnavailable` |
| `GET /devices/pair?id=` | anybody | `{status, deviceSession?}` |
| `GET /devices` | the owner | `{revision, devices[], pending[]}` |
| `POST /devices/approve {pairingId}` | the owner | the device; 422 `DevicePairingNotFound` |
| `POST /devices/refuse {pairingId}` | the owner | 204; 422 `DevicePairingNotFound` |
| `POST /devices/revoke {deviceId}` | the owner | 204; 422 `DeviceNotFound` |
| `GET /devices/me` | a phone | its record; 422 `DeviceSessionRequired` for the owner's token |
| `POST /devices/me/push-token {token, platform}` | a phone | 204 |
| `POST /devices/me/push-token/clear` | a phone | 204 |
| `GET /devices/relay` | the owner | `{url}` (empty when none) |
| `POST /devices/relay {url}` | the owner | `{url}` normalized; 422 `RelayAddressInvalid` |

The event `devices.changed {revision}` goes to every attached client on every
change (a phone asking, approved, refused, revoked, seen, its push token set
or cleared, the relay address); a client re-lists. A phone asking is also
`devices.pairing_requested {pairingId, name, platform}`: every Mac window
relays it to main over IPC (`devices:pairing-requested`, acted on once per
event id), and main shows the macOS notification when no window is focused,
whether the server runs in the app's process or apart; a phone's socket never
hears it.

## The scope

A device session is an **allowlist** (`packages/server/src/devices/scope.ts`):
`GET` on `/sessions`, `/sessions/by-id`, `/sessions/models`, `/sessions/commands`,
`/sessions/capabilities`, `/sessions/history`, `/requests/pending`,
`/launch-profiles`, `/workspaces`, `/devices/me` and anything under `/files/`;
`POST` on `/sessions/start`, `/sessions/stop`, `/sessions/write`,
`/sessions/resize`, `/sessions/view`, `/sessions/restart`, `/requests/resolve`,
`/devices/me/push-token` and `/devices/me/push-token/clear`. Every other route,
the test fixture route `/e2e/evaluate`, the accounts, the clients (and the
saved server connections behind them), the plugins, the sidebar, the git
panel, the server's own routes, the owner-only device routes and every write
to the settings included, answers 403 `{error: "Forbidden", message: "A phone
may not do this."}`. The owner's token keeps everything it had.

On the push channel a phone's socket is admitted with no `Origin`, a loopback
`Origin`, or an `Origin` equal to the server's own address as the handshake's
`Host` header names it (what a phone's WebSocket sends, derived from the URL
it opened; no page is ever served from that origin). Any other `Origin` keeps
its 403. A phone's socket hears the `session.*` events, `requests.changed`,
`devices.changed`, `workspaces.state_changed` and the `usage.*` reads, and
none of the desktop's view request frames.

## The store

`devices.json` under the server's settings storage (the app's user data in
process, `--data-dir` for the standalone server), mode 0600, replaced whole:

```json
{ "v": 1, "devices": [ { "id": "dev-…", "name": "…", "platform": "ios", "appVersion": "…",
  "createdAt": 0, "lastSeenAt": null, "tokenHash": "<sha256 hex>", "push": null } ] }
```

A document that cannot be read admits no phone and is never written over.
The push token, set by the phone through its session, is what lane B's
`PushTargets` port lists (`devicesPushTargets(store)`: `list()` every device
with a token, `forget(deviceId, token)` clears it when it is still that one).

## Settings → Mobile

The owner's login state (sign in first when there is none, with a way to the
Accounts page), the phones asking to pair with Approve and Refuse, the paired
phones (name, platform, app version, last seen) each with Revoke, and the
relay address field bound to the preference `mobileRelayUrl` (`preferences.json`,
an http(s) origin or empty; the relay client reads it, the server validates
it). The page listens to `devices.changed` and re-lists; the bridge offers
`devicesList`, `devicesApprove`, `devicesRefuse`, `devicesRevoke`,
`mobileRelayGet`, `mobileRelaySet` and `onDevicesChanged`, routed to the
server alone (no IPC arm: the devices are the server's).

## Pairing in development

1. Start the app on a profile of your own (`npm run dev`, or the built app
   with `--user-data-dir=<dir>`), sign in with your Antasphere account under
   Settings → Accounts. Against a local test issuer, start the fixture
   provider (`tests/e2e/fixtures/oidc-provider.mjs`) and name it to the app
   and to the server through `CLAVE_ANTASPHERE_ISSUER=http://127.0.0.1:<port>`.
2. Obtain an ID token for the phone's own client: register a native client at
   the issuer (`POST <issuer>/api/v1/auth/oauth2/register` at the hub, `/register`
   on the fixture), run the code flow with PKCE under a custom-scheme redirect,
   exchange the code. `packages/server/src/devices/devices.test.ts` does it in
   a dozen lines against the fixture (`mintIdToken`).
3. `POST <server>/devices/pair` with `{idToken, clientId, device}`; the server's
   address is in `clave-server.json` under the user data (in process) or on
   the standalone's stdout.
4. Approve the phone in Settings → Mobile, then `GET /devices/pair?id=<pairingId>`
   once: the device session is in the answer and nowhere else.
5. Call the API with `Authorization: Bearer <token>`, or open `ws://<server>/push`
   and send `{"_tag":"hello","token":"<token>"}`.

## Verification

- `npx vitest run packages/server/src/devices`: the identity token against
  the local provider (valid; another subject; another issuer; another
  audience; expired; tampered signature and body; no owner login; ES256; an
  unknown `kid` read again once; the day's cache), the store's persistence
  and its hashing, the pairing desk against a clock, and the whole domain
  through a running server (the lifecycle, every refused route, the push
  handshake's origins, the revocation closing the socket, the push token on
  lane B's seam, the relay address).
- `node tests/e2e/run.mjs mobile-pairing` (after `npx electron-vite build`):
  the same through the real app, in process when the suite is and attached to
  a standalone server of the spec's own otherwise.
