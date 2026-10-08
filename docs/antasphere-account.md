# The Antasphere account in Clave

Signing in to Clave with an Antasphere account (PRDCT-3259). Optional: nothing in the
app waits on it, and every provider account, session and the local daemon work without
it. For now the login signs the user into Clave and nothing else: the hub's own APIs are
never called.

Code: `src/main/antasphere-account.ts` (the flow, Electron-free), owned by the server's
settings source (`src/main/settings/source.ts`: the shell's `shell-source.ts` while the
server runs in-process, the standalone's `standalone-source.ts` under Bun), served as one
settings domain of the wire contract (`packages/contract/src/settings/antasphere.ts`, the
server's handlers in `packages/server/src/settings/`, the typed client in
`packages/client/src/settings.ts`), the IPC route and the browser in
`src/main/ipc-handlers/antasphere-account-handlers.ts`, the preload's routes in
`src/preload/index.ts`, the read model in `src/shared/antasphere-account-types.ts`, the
window's store and section in `src/renderer/src/store/antasphere-account-store.ts` and
`components/settings/AntasphereAccountSection.tsx`.

## Who owns what (ADR 0003)

The **server** owns the login: the flow below, the token exchange and validation, the
sealed session, its renewal and its sign-out, through the one settings source the server
answers from. Inside the app that is the shell's own source, and the IPC route reads the
same manager; attached to a standalone server (`CLAVE_SERVER_URL`), the shell builds **no**
manager at all: nothing under the app's user data is restored or offered as a login, the
window asks the server it is attached to, and main's IPC route refuses
(`CapabilityUnavailable`, `antasphereAccount`). The standalone server runs the same
manager on its own data directory, its session sealed in the macOS Keychain.

The wire: `GET /accounts/antasphere` (the status), `POST /accounts/antasphere/sign-in`,
`/handoff/confirm`, `/cancel`, `/sign-out`, `/dismiss`, and the event
`accounts.antasphere_changed` on the push channel (the status only). Every window of one
app hears every change through the settings push routing, so several windows agree.

The **shell** owns the one thing a server has no business doing: the user's browser. A
sign-in's answer carries the _browser handoff_, the authorization URL bound to the login's
generation, to the one client that asked, in the command's direct answer and nowhere else
(no event, no push frame, no status, no log line, no file). The preload that receives it
asks the manager that issued it, right before opening, whether it is still exactly the
handoff of the login in flight (`confirm-handoff`: the URL and the generation, a read that
starts nothing), hands it to main, and hands the page the status without it. Main opens
it through `shell.openExternal` after its own check: a URL at the issuer this process is
configured for, no credentials, and, while the shell holds the manager, the exact handoff
once more at the open.

Three guards close the gap between a sign-in's answer and the browser's open, since the
answer waits on discovery and the registration and can land seconds later:

- the manager hands out a handoff only for the login that is current when asked, and
  confirms only that exact handoff while that login is still waiting (a cancel, a
  sign-out, a new login, the browser's callback, a shutdown: no);
- the preload keeps its own order of the account's operations: a sign-in takes a number,
  a cancel, a sign-out, a newer sign-in and a status heard from the server saying the
  login is no longer in flight bump it synchronously, and the sign-in checks its number
  after every await and once more right before the open. A confirmation the server
  computed as `true` whose reply arrives after a cancel opens nothing;
- the window's store applies an answer only while it is the latest thing that window
  asked or heard, so a late "signing in" cannot overwrite a cancel; Cancel is disabled by
  its own ask alone and stays live while a sign-in waits on the issuer.

The boundary, stated plainly: the confirmation and the OS opening the browser are two
steps, not one transaction. What the guards close is everything the client hears before
it hands the URL to the system; a cancel on the server in the moments after that lands on
the manager's callback check, where a stale state opens nothing, not on the browser.

## The flow

OpenID Connect Authorization Code with PKCE (S256), `state` and `nonce`, as a public
native client, through `openid-client` v6:

1. The main process opens a listener on `127.0.0.1` (the port the stored registration
   names, or any free port) for exactly one login.
2. Discovery at the issuer. Every endpoint the metadata names must sit on the issuer's
   origin, and every request is pinned to it: one that would leave it is refused before
   it is sent. Each request waits at most 15 s, follows no redirect and reads at most
   256 KiB.
3. The authorization URL (scope `openid profile email offline_access`, the loopback
   `redirect_uri`) is answered as the handoff to the client that asked, which has the shell
   open the user's own browser on it (`shell.openExternal`) once the manager confirms it.
4. The hub sends the browser back to `http://127.0.0.1:<port>/callback`. Only a `GET` on
   that path carrying the pending login's exact `state` is taken, once; anything else is
   answered and changes nothing.
5. The code is exchanged at the token endpoint, the ID token validated: signature against
   the hub's JWKS (`enableNonRepudiationChecks`), issuer, audience, expiry, nonce. A
   decoded-only token is never accepted.
6. The session is sealed and the windows hear `signed-in`.

The login has a deadline (5 min). Cancel, sign-out and quit close the listener and drop
whatever answer was still in flight: each bumps a generation counter that any
continuation checks before it writes.

## Configuration

| Setting                   | Default                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAVE_ANTASPHERE_ISSUER` | `https://account.antasphere.com` | The issuer, read by the process that owns the login (the app, or the standalone server) and by the shell for its check of what it opens. An override must be a bare origin: `https://…`, or `http://127.0.0.1:<port>` for a local test provider. Anything else is refused, and a refused override does **not** fall back to the hub: sign-in is off and the section says so (`configuration`). |
| `CLAVE_KEYCHAIN_FILE`     | the login keychain               | Standalone server only: a keychain **file** the secrets are filed in instead of the login keychain, named last on every `security` subcommand. The end-to-end harness's, so a run never touches a personal keychain.                                                                                                                                                                           |

Plain HTTP is accepted for the literal loopback target only. There is no other knob: the
scopes, the grants and the callback path are fixed in code.

## The registration

The first login registers Clave at the hub's registration endpoint
(`token_endpoint_auth_method: none`, grants `authorization_code` + `refresh_token`,
response type `code`, the loopback redirect URI, `application_type: native`) and keeps
the result in `antasphere-account-client.json` under the app's user data, owner-only:
the client id, the issuer, the loopback port it was registered with, and the date.
Nothing else from the registration answer is kept; in particular the scopes the hub hands
a client by default are not, and every authorization request names the identity scopes
explicitly.

Every later login reuses that client and its port. When the port is taken by another
program, one replacement registration is made on a newly reserved port and replaces the
stored one. A registration that comes back confidential (a client secret, another auth
method) or refused is not kept and the login fails as `registration`.

## The session and its lifetime

`antasphere-account-session.json` (owner-only) holds the issuer, the client id, a date
and one sealed string: the whole session (subject, name, email, when it was obtained,
when it lapses, the refresh token) encrypted through the secret port, Electron's
`safeStorage` in the app and the macOS Keychain for the standalone server. The plain
half carries no identity and no token. The session is serialised to printable ASCII
before it is sealed (JSON with every character beyond ASCII as a JSON escape,
`serializeSessionSecret`), because the Keychain port files only what `security` reads
back verbatim and a name or an email is Unicode for most of the world; the decode is
`JSON.parse`, so a record sealed before this existed, plain JSON with the Unicode in it,
opens the same way. On the Keychain a renewal files the new item before the old handle is
deleted, so the port holds one item per login. A replacement is written atomically and the
previous sealed value is discarded only once the new file is in place; a value whose
file could not be written is discarded itself, so the port holds one item per login.

- The login lasts as long as the verified identity: the ID token's `exp`, and no later
  than the access token's `expires_in` when the hub states a shorter one. A token that
  has already expired on arrival is refused.
- At boot the file is read back: bound to the configured issuer and the stored client,
  opened, parsed, and valid until its expiry it is the login. A file bound to another
  issuer or client, one that does not open, or one that opens to something else is
  discarded. Without OS encryption the file is kept but is not a login (`storage`). A
  disk that fails to read is a `storage` failure in the status and never a rejection.
- With a refresh token the session is renewed a minute ahead of its end, one renewal at
  a time, in the running app as at a boot; the renewed ID token is validated the same
  way and must name the same subject. A renewal the hub refuses discards the session; a
  renewal the network loses keeps the file for the next boot, signed out meanwhile.
- Without a refresh token the session ends at its expiry: the running app signs out
  (`expired`) when the clock reaches it, and a status read past it answers signed out
  before the timer does. With a refresh token, an identity past its expiry reads signed
  out (`expired`) while the renewal runs, and signed in again once it lands; a read past
  the expiry starts the renewal if the timer has not. The lapse is pushed to every window
  once, by the end timer, by a renewal timer that fires past the end, or by the first
  status read. The code checks the wall clock in both places: a timer that fires late
  detects the lapse, and so does the first status read (opening Settings → Accounts).
  There is no explicit resume hook, and an immediate update on wake from sleep has not
  been verified; nothing in the app gates on the login meanwhile. A wait longer than a
  timer can hold (about 24.8 days) is re-armed when the platform's maximum passes,
  never ended early.
- A renewal keeps the profile: the renewed ID token's claims first, userinfo when the
  token carries no email, and what the login had for anything still missing. A refresh
  answer with no usable lifetime (neither an ID token `exp` nor `expires_in`, or an end
  already past, which the library tolerates by a few seconds) is refused as
  `invalid-response` and ends the login, once: a session never runs on an end nobody
  stated or that has passed, and never asks again in a loop.
- Clearing the stored record (sign-out, expiry, a corrupt or refused session) removes
  the file; when the disk refuses, the record is overwritten in place with one no boot
  reads as a session, because with `safeStorage` the ciphertext is the file and leaving
  it would restore a login that was signed out. When neither works, sign-out still ends
  the login in memory and shows a `storage` failure rather than a sign-out it cannot
  promise: the record is intact and a later boot on a working disk restores it.
- Sign-out is local to Clave: the file goes, the secret is discarded, every window is
  told. The hub's own session is not ended.
- Every sign-out, cancel, new login and shutdown bumps a generation counter. A login,
  registration or renewal still in flight from an older generation is dropped when it
  lands: it writes nothing and cannot put a login back or overwrite a newer one. The
  browser's callback is a value handed to the waiting login, never a rejected promise.

## What the windows see

One shape, `AntasphereAccountStatus`: the phase, the account (subject, name, email,
verified), the issuer's host, the dates, whether the session renews, and the last
failure as a code (`cancelled`, `timeout`, `denied`, `network`, `invalid-response`,
`registration`, `storage`, `configuration`, `expired`). No token, no authorization URL,
no callback query and no text from the hub ever cross IPC or reach a log; the renderer
puts short words on the code. A bridge call that does not reach main is shown as a
transport failure with a Retry, the last known status kept; the exception's text is not.

The page the browser lands on after the hub sends it back says only that the browser's
part is done ("Go back to Clave"), or that the sign-in did not complete when the hub
answered with a refusal: the outcome is decided by the exchange that follows and told in
Clave.

## Recovery

| Symptom                                               | What to do                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Could not sign in" with `network`                    | The hub was unreachable, slow, or redirected. Try again; check the proxy.                                                                                                                                                                                                                    |
| `invalid-response`                                    | The hub's answer did not validate (metadata off the issuer, a bad token). Nothing was kept. Try again; if it persists, the hub's metadata or keys changed.                                                                                                                                   |
| `registration`                                        | The hub would not register a public native client. Check the hub's registration policy.                                                                                                                                                                                                      |
| Signed out after a restart, or "Your sign-in expired" | The session lapsed and could not be renewed (no refresh token, or the hub refused it). Sign in again.                                                                                                                                                                                        |
| "Clave could not complete that" with Retry            | The window could not reach the main process for that call. Retry; if it persists, restart Clave.                                                                                                                                                                                             |
| `storage`                                             | OS encryption is unavailable (a broken keychain, a headless session), or the user data folder could not be written: a sign-in could not be kept, or a sign-out's record could neither be removed nor invalidated. Restore the folder or the encryption; a stored session is kept until then. |
| `configuration`                                       | `CLAVE_ANTASPHERE_ISSUER` is set to something refused. Unset it or fix it.                                                                                                                                                                                                                   |
| Start over completely                                 | Quit Clave, delete `antasphere-account-session.json` and `antasphere-account-client.json` from the user data folder. The next login registers afresh.                                                                                                                                        |

## Verification

- `npx vitest run src/main/antasphere-account.test.ts`: the flow against a local signed
  OIDC provider (`tests/e2e/fixtures/oidc-provider.mjs`): discovery, registration and
  its reuse, the code flow, every invalid token, the callback's checks, restore and
  renewal, corrupt and unreadable records, cancel, sign-out and quit against answers in
  flight, the handoff's confirmation, and a Unicode identity on the Keychain adapter
  (sealed ASCII, restored whole, the item rotated and cleaned). Nothing reaches
  `account.antasphere.com`.
- `npx vitest run packages/contract packages/server/src/settings packages/client src/main/settings src/preload src/main/antasphere-handoff.test.ts src/renderer/src/store/antasphere-account-store.test.ts`:
  the contract (the handoff in the sign-in's answer and in no event or query), the
  server's routes and refusals, the typed client, the source's ownership and refusals,
  the preload's guard against a late `true` on both arms, the shell's check of what it
  opens, and the store's ordering.
- `node tests/e2e/run.mjs antasphere-account` (after `npx electron-vite build`): the
  same through the real app's Settings → Accounts, with `shell.openExternal` stood in,
  twice: `antasphere-account.spec.mjs` with the server in-process (a cancel while the
  issuer is slow included), `antasphere-account-attached.spec.mjs` attached to a
  standalone server of the spec's own, on a keychain file of the run's own, through a
  proxy that holds one answer back (a `true` confirmation landing after a cancel, a
  sign-in answer landing after another window signed in), the server's query agreeing
  at every step and the session under the server's data directory alone.
- `npx vitest run src/main/antasphere-account.fixtures.test.ts`, or on Bun
  `CLAVE_FIXTURES=1 bun scripts/antasphere-account-fixtures.ts fixtures load antasphere-account/signed-in`:
  the `@structure-ai/fixtures` scenario, one isolated run against a provider it starts
  and a Clave server of the run's own: the sign-in goes through the server's commands and
  the verification through its query.
  The run's provider, server and manager close with the command (the world is a scoped layer),
  the run's install directory (`$TMPDIR/clave-antasphere-fixture-<run-id>`) stays for
  inspection, and `fixtures cleanup <run-id>` removes it. `CLAVE_FIXTURES=1` is the
  capability; without it `load` fails. The `@effect/cli` the fixtures CLI pulls in is
  pinned by an npm override to the release that shares the app's Effect 3.22.1, so one
  Effect runs.
