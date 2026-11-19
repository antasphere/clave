# The mobile relay, from a Clave server

How a phone reaches a person's Clave servers from any network, and what a Clave server does
to be reachable that way (issue #407, ported from lane E of the mobile wave, decision 4 of
the mobile spec `clave-os/knowledge/specs/2026-10-29-mobile-app.md`). Every Clave server signed
in to Antasphere keeps one outbound connection to the relay with a credential its owner
claimed; a phone holding a bearer of the hub lists the machines of its own subject and reaches
one through it. The relay keeps connection state and nothing else.

**The relay itself is not in this repository.** It is the `antasphere/relay` tool
(https://github.com/antasphere/relay, deployed at `relay.antasphere.com`), which serves the wire
protocol of `packages/contract/src/relay.ts` byte for byte. This page is the server's end: the
client, its wiring, Settings → Mobile, and how to run it against a relay on this Mac.

Code: the client in `packages/server/src/relay/client.ts`, the wire contract in
`packages/contract/src/relay.ts`, the wiring in `src/main/server/relay-wiring.ts` (the
in-process server through `src/main/server/clave-server.ts`, the separate server and the
daemon through `src/main/server-entry.ts`), the address and the state in the devices domain
(`GET/POST /devices/relay`, `GET /devices/relay/status`, `src/main/server/devices-port.ts`),
the page in `src/renderer/src/components/settings/MobileSettings.tsx`.

## The relay, in one paragraph

`POST /machines/claim` with the owner's hub bearer and the machine's record answers a machine
id and a secret once. `GET /machines` with a bearer lists that subject's machines, each with
`online` and `lastSeen`. A machine keeps one WebSocket to `/machines/connect`: the first frame
is a `hello` with its id, its secret and its record, answered by `welcome` or closed with 4001;
a newer socket for the same machine closes the older with 4009; a `ping` every 25 s, and 60 s
of silence ends the socket. Any request to `<relay>/m/<machineId>/<path>` is sent to the
machine as `/<path>`, the caller's `Authorization` included, and the machine's own listener
answers it; `WS <relay>/m/<machineId>/push` is the machine's push channel, tunnelled frame by
frame. The details, the limits and the deployment are antasphere/relay's documentation.

## The server's end

A Clave server reaches the relay when it has an address and a login:

- **The address** is the `mobileRelayUrl` preference (empty by default), which Settings →
  Mobile writes through the server's devices domain, or, for a standalone server,
  `--relay <url>` on its command line (the flag wins). It is read again at every attempt, and
  a save in Settings makes the next attempt now, so an address takes effect without a
  restart; the separate server the packaged app starts keeps the preference in its own
  `preferences.json`, since the page writes it through that server. The address is `https`
  (the relay behind its TLS proxy) or plain `http` to a literal loopback address
  (`127.0.0.1`, `[::1]`, `localhost`: a relay on this Mac). Settings refuses any other
  plain-http address when it is saved, the standalone entry refuses it as a flag before it
  starts (exit code 2), and the client refuses it again where a claim or a hello would leave,
  whatever wrote it, with one log line naming its scheme and host: the claim carries the
  owner's access token and the hello the machine secret.
- **The login** is the server's Antasphere account (`docs/antasphere-account.md`): the machine
  credential is bound to its subject, and the claim presents its access token
  (`currentAccessToken()` on the account manager, which renews through the manager's one
  renewal and never beside it, since the hub rotates refresh tokens with no grace). A server
  with no login stays off the relay and says so; a sign-out takes the machine off the relay at
  once, a sign-in puts it back. Renewing a token for the same owner keeps the connection
  open. A claim or handshake invalidated by sign-out, shutdown, or an owner or address change
  cannot save a stale credential or send a hello.

The credential lives in `relay.json` under the server's data directory, owner-only: the
relay's address, the machine id and the owner's subject in clear, the secret sealed through
the secrets port (Electron's `safeStorage` in the app, the Keychain or the encrypted files for
a standalone server). A credential claimed under another address or another owner is cleared
and claimed anew; a relay that refuses the hello (its store reset, the machine forgotten)
clears the credential and claims anew. The reconnect doubles its wait from a second to a
minute, with jitter. The record's name combines the host (without macOS's `.local`) with the
signed-in owner's display name; it also carries the platform, the app's version and the direct
addresses: none for the in-process and the separate server, whose listener is loopback; its
own address for a daemon started with `--host`. The log says when the client claims,
connects, waits and why, never with a token in the line.

**The server's own bearer token never reaches the relay.** The requests the relay forwards
carry the phone's own credential, and the server's listener authenticates them exactly as it
authenticates a direct caller: a paired phone's device session is held to the phone's
allowlist (`packages/server/src/devices/scope.ts`) and to the owner binding (a phone paired
under one account is refused while another is signed in on the server), and the owner's routes
answer 403 to it. The `Origin` header is dropped on the way in, since the listener's
cross-origin rule is for browser pages. The relay forwards the path without its
`/m/<machineId>` prefix, so the phone's road of `docs/mobile-server-reads.md` (a server reached
at an HTTPS address of its own, which strips its own machine id) is not involved.

The client runs on macOS and Linux, the two platforms the record names; a Windows server stays
off the relay and says so in its log.

## Settings → Mobile

The page (in the Clave group of Settings) holds the relay address, with Save and Clear, and the
client's state, asked of the window's own server every two seconds while the page is open
(`GET /devices/relay/status`, the owner's alone):

| State        | What it means                                                                       |
| ------------ | ----------------------------------------------------------------------------------- |
| `off`        | No address, or no relay client on this server.                                      |
| `signed-out` | An address, but no Antasphere login (or one with no usable token).                  |
| `claiming`   | Asking the relay for this machine's credential.                                     |
| `connecting` | Opening the control socket with the credential.                                     |
| `connected`  | Welcomed: phones can reach this Mac through the relay.                              |
| `waiting`    | The last attempt failed (the network, the relay, a forgotten credential); retrying. |
| `refused`    | The address is not https, or the relay refused the login; retrying, needs a change. |

The client's last error is shown under the state in its own words. The page does not pair a
phone; pairing is the phone's and the mobile branch's.

## Running it against a relay on this Mac

The tests use the mobile branch's relay as a fixture, `tests/e2e/fixtures/relay/` (never
bundled or shipped): it speaks the same protocol as antasphere/relay without its database.
From a checkout, with the repository's own Bun:

```sh
node_modules/.bin/bun tests/e2e/fixtures/relay/main.ts \
  --port 8787 --data-dir /tmp/clave-relay --issuer https://account.antasphere.com
```

It prints `{"url":"http://127.0.0.1:8787"}` once it listens. A Clave server on the same Mac
reaches it with `http://127.0.0.1:8787` saved in Settings → Mobile, or with
`--relay http://127.0.0.1:8787` on the standalone entry. A test provider stands in for the hub
with `--issuer http://127.0.0.1:<port>` (plain http is accepted for a loopback issuer only).

## Verification

- `npx vitest run packages/server/src/relay`: the client against the fixture relay and a local
  listener (the claim and its storage, no address and no login, a refused claim and a refused
  address, the requests answered with `Origin` dropped, a streamed answer, a tunnel piped, the
  reconnect, a relay that lost its store, the stop), and `road-through-relay.test.ts`: a real
  Clave server, a paired phone through `/m/<id>/`, device scope and owner binding as on the
  direct road, `Origin` dropped, and no byte sent to the relay carrying the server's token.
- `npx vitest run src/main/server/relay-wiring.test.ts src/main/server/relay-lifecycle.test.ts src/main/server/clave-server-relay.test.ts`:
  the credential store sealed through the secrets port, the record, the address rule, the
  login's changes, and the in-process start and stop order.
- `npx vitest run src/main/antasphere-account.test.ts -t "the access token"`: the token
  answered, kept out of every status and log, renewed through the one renewal.
- `npx vitest run packages/server/src/devices/devices.test.ts -t relay`: the address rule at
  save time and the state read.
- `node tests/e2e/run.mjs mobile-relay mobile-relay-separate` (after `npx electron-vite build`):
  the real app, once on the in-process server and once on the separate server (the packaged
  default, whose child owns the login, the preference and `relay.json`); a
  standalone server refusing a plain-http `--relay`; Settings → Mobile refusing a plain-http
  address, saving the fixture relay's and saying signed out; the app signing in on the local
  provider, its server claiming and connecting (the page says connected), a client reaching the
  sessions and the push channel through `/m/<id>/...`, another account seeing no machine, the
  Mac offline after a sign-out and back under the same id after a sign-in and a relaunch, and
  offline again once the address is cleared.

The off-network path itself, a phone on mobile data reaching the Mac at home, is proven only
with the deployed relay and a real phone.
