# The mobile relay

How a phone reaches a person's Clave servers from any network (decision 4 of the mobile
spec, `clave-os/knowledge/specs/2026-10-29-mobile-app.md`; lane E of the mobile wave,
issue #284). The relay is the directory and the road: every Clave server signed in to
Antasphere keeps one outbound connection to it with a credential its owner claimed; a
phone holding a bearer of the hub lists the machines of its own subject and reaches one
through it. The relay keeps connection state and nothing else.

Code: the relay in `packages/server/src/relay/` (`relay.ts` the process, `auth.ts` the hub
bearer check, `registry.ts` the machines file, `main.ts` the entry, `client.ts` the
server's end), the wire contract in `packages/contract/src/relay.ts`, the wiring into a
Clave server in `src/main/server/relay-wiring.ts` (the in-process server through
`server/clave-server.ts`, the standalone entry through `server-entry.ts`), the image in
`packages/server/relay.Dockerfile`.

## What the relay does

- **The directory.** `POST /machines/claim` with the owner's hub bearer and the machine's
  record (`{name, platform, version, direct: [{url}]}`) answers `{machineId, machineSecret}`
  once; the relay keeps the secret as a SHA-256 beside the owner's subject. `GET /machines`
  with a bearer lists that subject's machines, each with `online` (connected right now)
  and `lastSeen`. `POST /machines/forget {machineId}` drops one of the caller's own.
  `GET /health` is open and counts the machines known and online.
- **The road.** Any request to `<relay>/m/<machineId>/<path>` is sent to the machine as
  it was received, the caller's `Authorization` included, and the machine's own listener
  answers: the relay checks nothing on this path but that the machine exists (404
  otherwise) and is connected (503 otherwise). A body is bounded at 8 MiB (413), a
  machine that does not answer within 120 s is a 504, one that could not perform the
  request a 502; at most 256 requests in flight per machine, including unfinished
  uploads (503 beyond). The deadline includes the upload and aborts the local request.
  `WS <relay>/m/<machineId>/push` is the machine's push channel, tunnelled frame by frame:
  the machine opens a socket of its own to its listener for each, and the handshake runs
  there (the hello with the device session's token, the welcome). At most 64 open tunnels
  per machine. Each push message is bounded at 8 MiB; an oversized message closes
  only its tunnel with code 1009, preserving the machine connection.
- **Who a bearer is.** The relay holds no key of the hub: it asks the hub's userinfo
  endpoint (the one its discovery document names, `/api/v1/auth/oauth2/userinfo` on
  account.antasphere.com) with the bearer and remembers the subject under the SHA-256 of
  the bearer for ten minutes, or until the token's `exp` when it is a JWT. A JWT of another
  issuer or already expired is refused without asking. A hub that does not answer is a
  503, never a grant.
- **The machine's road.** One WebSocket to `/machines/connect`: the first frame within 5 s
  is `{"_tag":"hello", machineId, machineSecret, record}` (the record refreshed at every
  connect), answered by `welcome` or closed with 4001; one control socket per machine, a
  newer one closing the older with 4009; a `ping` frame every 25 s, `pong` back, 60 s of
  silence closes the socket with 4011. The phone's requests travel as `request` frames and
  come back as one `response` frame (a body of known length under 64 KiB) or as
  `response-head`, `response-chunk` and `response-end`; a tunnel as `tunnel-open`,
  `tunnel-data` (base64, both ways) and `tunnel-close`.

## The server's end

A Clave server reaches the relay when it has an address and a login:

- the address is the `mobileRelayUrl` preference (Settings → Mobile writes it) or, for a
  standalone server, `--relay <url>` on its command line. It is read again at every
  attempt, so an address saved in Settings takes effect without a restart; the separate
  server the packaged app starts follows the preference the app writes into the server's
  own copy of `preferences.json`. The address is `https` (the relay behind its TLS proxy)
  or plain `http` to a literal loopback address (`127.0.0.1`, `[::1]`, `localhost`: the
  development relay on this machine); any other plain-http address is refused where a
  claim or a hello would leave, whatever wrote it, with one log line naming its scheme
  and host, since the claim carries the owner's access token and the hello the machine
  secret.
- the login is the server's Antasphere account (`docs/antasphere-account.md`): the
  machine credential is bound to its subject, and the claim presents its access token
  (`currentAccessToken()` on the account manager, which renews through the manager's
  one renewal and never beside it, since the hub rotates refresh tokens with no grace).
  A server with no login stays off the relay and says so in its log once; a sign-out takes
  the machine off the relay at once, a sign-in puts it back. Renewing a token for the
  same owner keeps the connection open. A claim or handshake invalidated by sign-out,
  shutdown, or an owner/address change cannot save a stale credential or send a hello.

The credential lives in `relay.json` under the server's data directory, owner-only: the
relay's address, the machine id and the owner's subject in clear, the secret sealed
through the secrets port (Electron's `safeStorage` in the app, the Keychain or the
encrypted files for a standalone server). Another address or another owner claims anew;
a relay that refuses the hello (its store reset, the machine forgotten) clears the
credential and claims anew. The reconnect doubles its wait from a second to a minute, with
jitter. The record name combines the host (without macOS's `.local`) with the signed-in
owner's display name. It also carries the platform, the app's
version, and the direct addresses: none for the in-process and the separate server, whose
listener is loopback; its own address for a daemon started with `--host`, which is the
Tailscale address when the daemon runs on one (the relay never installs or configures
Tailscale). The log says when the client claims, connects, waits and why, never with a
token in the line.

The server's own bearer token never reaches the relay. The requests the relay forwards
carry the phone's own credential (the device session lane A issues; the server's token in
the end-to-end spec until then) and the server's listener authenticates them as it
authenticates any caller; the `Origin` header is dropped on the way in, since the
listener's cross-origin rule is for browser pages.

## The limits, said plainly

- **No end-to-end encryption beyond TLS at the relay.** The relay terminates the phone's
  TLS (through the host's proxy) and the machine's, and sees every header and every body
  in flight, in both directions. It keeps none: no body past the request it belongs to,
  no token (a hash in the bearer cache, a hash in the machines file), no session, no
  history. Whoever operates the relay could read the traffic while it passes; the relay
  is the team's and runs on a host of the team's for that reason.
- **A standalone server reaches the relay only once its owner is set.** The standalone
  entry's `--relay` flag works for a daemon whose owner is its own Antasphere login (an
  attached desktop on the same host signs it in). The owner hand-off of decision 5 of the
  spec (the Mac that configured a server claims a credential for it and hands it, with the
  owner's subject, over the connection it already holds) is designed and not built: a
  configured server is not reachable from the phone yet, and the beta says so under its
  name.
- **One relay, one issuer.** The relay authenticates against one hub; a token of another
  issuer is refused.
- **No rate limit of its own.** The hub's userinfo limit (120 per minute per IP) is
  absorbed by the bearer cache; everything else is the host proxy's to bound.
- **A machine claimed under a previous login stays listed, offline, for that account**
  until it is forgotten (`POST /machines/forget`) or the relay's store is reset.
- **Platforms.** The relay client runs on macOS and Linux (the two platforms the record
  names); a Windows server stays off the relay and says so.
- **Not run.** A local relay on this Mac proves the protocol and the server's client
  (the unit tests, `tests/e2e/mobile-relay.spec.mjs`). The off-network path itself, a
  phone on mobile data reaching the Mac at home, is proven only with the deployed relay
  and a real phone.

## Running it

In development, from a checkout, with the repository's own Bun:

```sh
node_modules/.bin/bun packages/server/src/relay/main.ts \
  --port 8787 --data-dir /tmp/clave-relay --issuer https://account.antasphere.com
```

`--host` binds another interface (`127.0.0.1` by default). The entry prints
`{"url":"http://127.0.0.1:8787"}` on stdout once it listens, logs to stderr, and stops on
SIGTERM or SIGINT. A Clave server on the same machine reaches it with the preference
`mobileRelayUrl` set to that url, or `--relay http://127.0.0.1:8787` on the standalone
entry; a test provider stands in for the hub with `--issuer http://127.0.0.1:<port>`
(plain http is accepted for a loopback issuer only).

## Deploying it

The image is `packages/server/relay.Dockerfile`, built from the repository root on
`oven/bun:1.4.1-slim` (the Bun the repository pins) with the contract package copied in
as a module and only `effect` and `ws` installed:

```sh
docker build -f packages/server/relay.Dockerfile -t clave-relay .
docker run -d --name clave-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v clave-relay-data:/data \
  -e RELAY_ISSUER=https://account.antasphere.com clave-relay
```

| Variable         | Default   | Meaning                                                               |
| ---------------- | --------- | --------------------------------------------------------------------- |
| `RELAY_PORT`     | `8787`    | The port the relay listens on inside the container.                   |
| `RELAY_HOST`     | `0.0.0.0` | The interface; every one inside the container, the proxy in front.    |
| `RELAY_DATA_DIR` | `/data`   | Where `machines.json` lives; a volume, backed up with the deployment. |
| `RELAY_ISSUER`   | none      | The hub's origin, required.                                           |

The host's proxy (Caddy, nginx, Traefik) terminates TLS for the relay's public name
(`relay.antasphere.com`, say) and forwards to `127.0.0.1:8787`, WebSocket upgrades
included (`Connection: upgrade`, `Upgrade: websocket`; Caddy does it by default, nginx
needs `proxy_http_version 1.1` and the two headers), with no request body limit under
8 MiB and read timeouts above two minutes, since a forwarded request may wait on the
machine that long and a control socket is idle between pings for 25 s. `GET /health`
answers `{"status":"live","machines":n,"online":m}` for the proxy's and the image's
health checks. The address the servers and the phones are given is the proxy's https url.

`machines.json` carries the owners' subjects, the records and the secret hashes: back it
up with the volume, and treat the host as holding the traffic of every machine on it.
There is no secret of the relay's own to rotate; a machine whose credential should no
longer be accepted is forgotten by its owner or removed from the file while the relay is
stopped.

## Verification

- `npx vitest run packages/server/src/relay`: the relay against the local OIDC provider
  (`tests/e2e/fixtures/oidc-provider.mjs`, its userinfo answering the subject of a bearer
  it issued and refusing every other): two subjects and two machines, each listing their
  own; a bad, expired or foreign bearer refused; the cache; the claim once and the
  secret hashed; the control socket's hello, replacement and offline detection; a whole
  and a streamed response through the road, a body, the failures and the caps; a tunnel
  carrying frames both ways; forget, health, the close. And the client against a real
  relay and a local listener: the claim and its storage, no address and no login, a
  refused claim, the requests answered with `Origin` dropped, a streamed answer, a
  tunnel piped, the reconnect, a relay that lost its store, the stop.
- `npx vitest run src/main/antasphere-account.test.ts -t "the access token"`: the token
  answered, kept out of every status and log, renewed through the one renewal, obtained
  once for a record sealed before it was kept.
- `node tests/e2e/run.mjs mobile-relay` (after `npx electron-vite build`): the real app
  signed in on the local provider, its server claiming and connecting to a relay the spec
  starts under the repository's Bun, a client reaching the sessions and the push channel
  through `/m/<id>/...` with the server's token where a phone will hold its device
  session, another account seeing no machine, the Mac offline after a sign-out and after a
  quit, back online under the same id after a sign-in and after a relaunch.

The named fixture scenario `mobile-relay/isolated-owners` uses `@structure-ai/fixtures`
to claim two run-scoped machines through the authenticated relay API. Run it locally with
`npx vitest run packages/server/src/relay/relay.test.ts -t mobile-relay/isolated-owners --maxWorkers=2`.
It prints its run ID and machine IDs, verifies directory isolation and refusal of a foreign
forget request, then removes only its own claims through the owner-authorized forget route.
Its issuer and relay use isolated loopback ports and temporary data; it never uses production.
