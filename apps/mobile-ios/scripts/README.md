# apps/mobile-ios/scripts

`generate-tokens.mjs` and `build-icons.mjs` generate the desktop's tokens and icons for
the app. The other two scripts run the app against an isolated fixture stack on this Mac.
`check-release-binary.sh` (bash, from `apps/mobile-ios`) builds Debug and Release for the
simulator and reads both binaries with `strings`: the development-only markers must be in
Debug and absent from Release; `--prove-red` shows the check fails when the guard is off.

## The fixture stack

```sh
node apps/mobile-ios/scripts/fixture-stack.mjs [--approve] [--dry-run | --self-check | --once | --prove-prerequisites | --prove-title-guard]
node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid> [--only <xcodebuild -only-testing value>]
```

`fixture-stack.mjs` brings the stack up and keeps it running until Ctrl-C. `--approve`
approves every phone that asks to pair. `--self-check` proves the stack end to end and
exits. `--once` brings it up, prints it and tears it down. `--dry-run` runs the two
pre-boot checks below on the very command and environment a boot would use, prints that
command and exits without starting anything. A boot whose checks fail exits 2.

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
stubs/          zsh (the daemon's login shell, stood in for), bin/claude and bin/codex (the recorders),
                recorder.log (one line per recorded call, never a prompt), claude-config/ and codex-home/ (empty)
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
Claude CLI under the machine's login, and reads the machine's Claude and Codex usage unless
told not to. The stack starts the daemon with `--no-titles` (no tab is named, lane C's fix,
PR #354), `--test-no-activate` (the test fixtures, which also stop the usage clock) and
`--test-no-machine-usage` (no usage read of the machine login; the flag counts only beside
the previous one, `packages/host/src/test-mode.ts`); with `SHELL` pointing at a script named
`zsh` under `stubs/` that prints the daemon's own environment whatever it is asked (the
daemon reads its login environment with `$SHELL -lic 'env -0'`) and runs a `-c` command with
/bin/sh; with a `PATH` led by `stubs/bin`, where `claude` and `codex` are recorders that
append one line (the time, the command, its first two arguments, never the stdin) to
`stubs/recorder.log`, the `claude` one answering a one-shot with a fixed title; and with
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointing at empty folders beside them. None of this
Mac's agent logins (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDECODE`,
`OPENAI_API_KEY`) and no address of a server this shell is attached to reaches any child.

Three checks, printed first, every boot; one failing stops the boot with exit 2:

1. before any process starts, the daemon's command carries the three flags and
   `--dev-echo-adapter` (`preBootChecks` in `fixture-stack.mjs`);
2. before any process starts, the daemon's login environment, read the way the daemon reads
   it, resolves `claude` and `codex` to the recorders, names the empty Claude config folder
   and Codex home, and carries none of the logins above (`preBootChecks`);
3. after the daemon has announced itself and before anything is seeded, its discovery file
   (`clave-server.json`) says `titles: "off"`, `testMode: true` and `machineUsage: false`
   (`startStack`, step 3b).

After the seed, the recorder interlock reads the recorders 12 s after the daemon started
(7 s past the usage clock's first tick at 5 s, `packages/host/src/usage-manager.ts`, the
figure lane C's fixture uses): any recorded line, or any new transcript under
`~/.claude/projects` carrying the title prompt, fails the boot.

Two proofs that the checks go red, both with every flag kept so no boot ever runs with
wrong flags: `--prove-prerequisites` hands the third check a discovery read saying
`titles: "on"` and expects the refusal before the seed; `--prove-title-guard` plants one
line in the recorder log after the seed and expects the interlock to go red on it. That a
real title call reaches the recorder rather than the CLI was shown on 9 November 2026 at
11:29 and 11:30, before `--no-titles` existed; after lane C's fixture is on `mobile`, its
`--mutate drop-title-opt-out` is the verifier's knob for that proof.

## What is a fixture, and what is not

- The provider is `tests/e2e/fixtures/oidc-provider.mjs`. It is local and approves on
  sight. Nothing reaches account.antasphere.com.
- The chats run the Echo adapter (`--dev-echo-adapter`), which repeats what it is told and
  raises no request. The daemon around it is the real server entry: on 9 November 2026 two
  boots (11:18:58 and 11:19:54) let it call the real Claude CLI once each to name the
  seeded chat, which the checks above now stop. Until lane C's fix (PR #354) is on `mobile`
  and this branch is rebased onto it, the daemon announces none of the three prerequisites
  and the boot refuses before the seed; every boot that starts a session is on hold until
  the wave's coordinator lifts it.
- The relay and the server are this checkout's own entries, run under the repository's Bun.
