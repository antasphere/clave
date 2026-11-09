# apps/mobile-ios/scripts

`generate-tokens.mjs` and `build-icons.mjs` generate the desktop's tokens and icons for
the app. The other two scripts run the app against an isolated fixture stack on this Mac.

## The fixture stack

```sh
node apps/mobile-ios/scripts/fixture-stack.mjs [--approve] [--self-check | --once]
node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid> [--only <xcodebuild -only-testing value>]
```

`fixture-stack.mjs` brings the stack up and keeps it running until Ctrl-C. `--approve`
approves every phone that asks to pair. `--self-check` proves the stack end to end and
exits. `--once` brings it up, prints it and tears it down.

`fixture-check.mjs` brings the stack up with approval on, boots the simulator if it is
not booted, runs `xcodebuild test` (by default `-only-testing:ClaveUITests/FixtureFlowTests`),
tears the stack down and exits with xcodebuild's code. `--push <payload.json>` sends a
notification to the app once the tests are done. `--keep` leaves the stack up until
Ctrl-C. The tests get the stack's facts as `TEST_RUNNER_CLAVE_FIXTURE_*` variables:
`ISSUER_URL`, `RELAY_URL`, `SERVER_URL`, `MACHINE_ID`, `SESSION_ID`, `NONCE`. The owner's
token is never passed to them.

Both scripts take `--server <port>` (default 47101), `--relay <port>` (default 47102)
and `--tmpdir <dir>` (default `/private/tmp/clave-native-a/stack`). The provider takes a
free port, which the scripts print. Everything listens on 127.0.0.1.

## The tmpdir

It is deleted and recreated on every run.

```
stack.json      issuer, relay, server, serverId, machineId, workspaceId, sessionId, nonce, scratch, tokenFile
owner-token     the server's bearer token, mode 0600 (the only place the scripts write it)
server/         the daemon's data, its keychain file included (no login keychain is touched)
relay/          the relay's data
scratch/        the workspace `scratch` the Echo chat runs in
logs/           server.log, relay.log, xcodebuild.log
results/        one .xcresult per check
check.json      startedAt, finishedAt, udid, only, exitCode, resultBundle
```

## What the self-check proves

The check runs after the owner has signed in, the server has claimed its machine on the
relay, and one Echo chat has been seeded with a nonce. Through the relay road
(`<relay>/m/<machineId>/...`, using the server's token as the bearer), it confirms two
things:

- the seeded chat's timeline holds the nonce;
- a new message written through the road gets the Echo adapter's reply within 15 s.

## No real model call from a boot

The daemon names every fresh Claude-mode chat by its first message with a one-shot of the
Claude CLI under the machine's login, and polls the machine's Claude and Codex usage unless
told not to. The stack starts the daemon with `--test-no-activate` and `--test-no-machine-usage` (the
second flag counts only beside the first, `packages/host/src/test-mode.ts`), with `SHELL` pointing at
a script that answers the daemon's own environment whatever it is asked (the daemon reads
the login shell's environment with `$SHELL -lic 'env -0'`), and with a `PATH` led by a
folder holding a `claude` and a `codex` stub that drain their input, print a fixed title and
touch a marker under `stubs/markers/`. After the seed the boot asserts that the marker is
there and that no new transcript under `~/.claude/projects` carries the title prompt, else
it fails. `--prove-title-guard` boots with a `claude` stub that leaves no marker and expects
the boot to fail at that guard: the proof the check can go red, made with the stub still in
place, never by removing it.

## What is a fixture, and what is not

- The provider is `tests/e2e/fixtures/oidc-provider.mjs`. It is local and approves on
  sight. Nothing reaches account.antasphere.com.
- The chats run the Echo adapter (`--dev-echo-adapter`), which repeats what it is told and
  raises no request. The daemon around it is the real server entry: on 9 November 2026 two
  boots (11:18:58 and 11:19:54) let it call the real Claude CLI once each to name the
  seeded chat, which the guard above now stops; the daemon also polls the machine's usage
  unless `--test-no-activate` with `--test-no-machine-usage` says not to. Until that fix is on `mobile`, boots that start a session are on hold, and from
  then on every boot first shows the title opt-out, the no-activate flags and the post-login
  recorder interlock pass.
- The relay and the server are this checkout's own entries, run under the repository's Bun.
