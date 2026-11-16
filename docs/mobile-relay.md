# The mobile relay

How a phone reaches a person's Clave servers from any network (decision 4 of the mobile
spec, `clave-os/knowledge/specs/2026-10-29-mobile-app.md`; lane E of the mobile wave,
issue #284). The relay is the directory and the road: every Clave server signed in to
Antasphere keeps one outbound connection to it with a credential its owner claimed; a
phone holding a bearer of the hub lists the machines of its own subject and reaches one
through it. The relay keeps connection state and nothing else.

**The relay is its own tool, [`antasphere/relay`](https://github.com/antasphere/relay)**
(meant for `relay.antasphere.com`), since antasphere/relay#1 and this repository's #409.
Its protocol, the ways it departs from the Bun relay that used to live here, and its
deployment are documented there: `docs/concepts/relay.md` and
`docs/operations/relay-on-the-team-stack.md`. This repository holds only the server's end:

Code: the relay client in `packages/server/src/relay/client.ts`, the wire contract in
`packages/contract/src/relay.ts`, the wiring into a Clave server in
`packages/host/src/server/relay-wiring.ts` (the in-process server through
`server/clave-server.ts`, the standalone entry through `server-entry.ts`), and the native
apps' relay sources. The tests run the Bun relay this branch used to ship as a test
fixture, `tests/e2e/fixtures/relay/` (byte-identical to the fixture on `dev`, #408): it
speaks the same contract, and no build bundles it.

## What the relay does

The protocol as the client meets it; antasphere/relay's `docs/concepts/relay.md` is the
reference, with what the tool adds because it shares its origin with a dashboard (no
cookie on the road, an allowlist of answer headers, a sandboxing CSP on every answer).

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
- **Not run.** A local test relay on this Mac proves the protocol and the server's client
  (the unit tests, `tests/e2e/mobile-relay.spec.mjs`). The off-network path itself, a
  phone on mobile data reaching the Mac at home, is proven only with the deployed relay
  and a real phone.

## A relay for development

The relay a team runs is antasphere/relay, developed and run from its own repository. For
the client's tests and a quick local loop, this checkout starts the test relay with the
repository's own Bun:

```sh
node_modules/.bin/bun tests/e2e/fixtures/relay/main.ts \
  --port 8787 --data-dir /tmp/clave-relay --issuer http://127.0.0.1:<provider port>
```

`--host` binds another interface (`127.0.0.1` by default). The entry prints
`{"url":"http://127.0.0.1:8787"}` on stdout once it listens, logs to stderr, and stops on
SIGTERM or SIGINT. A Clave server on the same machine reaches it with the preference
`mobileRelayUrl` set to that url, or `--relay http://127.0.0.1:8787` on the standalone
entry. The issuer is a test provider (`tests/e2e/fixtures/oidc-provider.mjs`; plain http
is accepted for a loopback issuer only).

## Deploying it

Nothing in this repository builds, packages or deploys a relay any more. The relay is
released and deployed as a tool of the team stack: antasphere/relay's
`docs/operations/relay-on-the-team-stack.md` lists the steps (Steward, the release, the
hub client, the stack entry, DNS, the machine). The machines a Bun relay knew can be
carried over (`machines.json`, "Moving from the Bun relay" in its `docs/concepts/relay.md`).

## Verification

- `npx vitest run packages/server/src/relay`: the client against the test relay, the local
  OIDC provider (`tests/e2e/fixtures/oidc-provider.mjs`, its userinfo answering the
  subject of a bearer it issued and refusing every other) and a local listener: the claim
  and its storage, no address and no login, a refused claim, the requests answered with
  `Origin` dropped, a streamed answer, a tunnel piped, the reconnect, a relay that lost
  its store, the stop. The relay's own tests (the directory, the bearer check, the road,
  the caps, the tunnels) live in antasphere/relay.
- `npx vitest run packages/host/src/antasphere-account.test.ts -t "the access token"`: the token
  answered, kept out of every status and log, renewed through the one renewal, obtained
  once for a record sealed before it was kept.
- `node tests/e2e/run.mjs mobile-relay` (after `npx electron-vite build`): the real app
  signed in on the local provider, its server claiming and connecting to the test relay
  the spec starts under the repository's Bun, a client reaching the sessions and the push
  channel through `/m/<id>/...` with the server's token where a phone will hold its device
  session, another account seeing no machine, the Mac offline after a sign-out and after a
  quit, back online under the same id after a sign-in and after a relaunch.
- The native fixture stacks (`packages/mobile-native/scripts/fixture-server.mjs`,
  `apps/mobile-ios/scripts/fixture-stack.mjs`, `apps/mobile-android/scripts/fixture-env.mjs`)
  start the same test relay for the phones' own checks.
