# apps/mobile-ios/scripts

`generate-tokens.mjs` and `build-icons.mjs` generate the desktop's tokens and icons for
the app. The other two scripts run the app against an isolated fixture stack on this Mac.
`check-release-binary.sh` (bash, from `apps/mobile-ios`) builds Debug and Release for the
simulator and reads both binaries with `strings`: the development-only markers must be in
Debug and absent from Release; `--prove-red` shows the check fails when the guard is off.

## The fixture stack

```sh
node apps/mobile-ios/scripts/fixture-stack.mjs [--approve] [--dry-run | --self-check | --once | --prove-tmpdir-guard | --prove-prerequisites | --prove-inside cache|resolver|args|probe | --prove-recorder-read missing|unreadable | --prove-title-guard]
node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid> [--only <xcodebuild -only-testing value>]
```

`fixture-stack.mjs` brings the stack up and keeps it running until Ctrl-C. `--approve`
approves every phone that asks to pair. `--self-check` proves the stack end to end and
exits. `--once` brings it up, prints it and tears it down; both keep the stack up at least
12 s under the recorder watch. `--dry-run` runs the two pre-boot checks below on the very
command and environment a boot would use, prints that command and exits without starting
anything. A boot whose checks fail, or whose watch catches a call, exits 2.

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

The stack owns it or nothing happens. A folder the stack made holds `.clave-fixture-stack`, a
regular file whose content is exactly the stack's owner id (`clave native iOS fixture stack ·
apps/mobile-ios/scripts/fixture-stack.mjs`), and is emptied and reused at every run; a folder
that does not exist or is empty becomes one. A folder that exists, holds anything and has no
marker, a marker that is a symlink (read with `lstat`, never followed), a marker naming
another owner, or a run root that is itself a symlink is refused before a single entry is
touched, and nothing ever removes the folder itself or anything above it. A dry run never rewrites a reused folder: when the folder exists it
works in a fresh sibling it removes at the end. `--prove-tmpdir-guard` shows the three refusals
with their sentinels intact, an owned folder emptied and reused, and a dry run leaving a reused
folder alone.

```
stack.json      issuer, relay, server, serverId, machineId, workspaceId, sessionId, nonce, scratch, tokenFile,
                announced (the three discovery fields), inside (what the fourth check read), probe (what the
                daemon ran and answered), recorderLog, recorderBaseline (the probe's one line)
owner-token     the server's bearer token, mode 0600 (the only place the scripts write it)
server/         the daemon's data, its keychain file included (no login keychain is touched)
relay/          the relay's data
scratch/        the workspace `scratch` the Echo chat runs in
stubs/          zsh (the daemon's login shell, stood in for), bin/claude and bin/codex (the recorders),
                recorder.log (one line per recorded call, never a prompt; the probe's line first),
                claude-config/ and codex-home/ (the empty folders a real CLI run with that environment
                would write into)
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
PR #354), `--test-no-activate` (the test mode, which also stops the usage clock and opens
the daemon's test route) and `--test-no-machine-usage` (no usage read of the machine login;
the flag counts only beside the previous one, `packages/host/src/test-mode.ts`). The daemon's
environment is built from an allowlist (`HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`,
`LC_ALL`, `LC_CTYPE`, `TERM`) plus what the stack sets: `SHELL`, a script named `zsh` under
`stubs/` that prints the daemon's own environment whatever it is asked (the daemon reads its
login environment with `$SHELL -lic 'env -0'`) and runs a `-c` command with /bin/sh; `PATH`,
led by `stubs/bin`, where `claude` and `codex` are recorders that append one line (the time,
the command, its first two arguments, never the stdin) to `stubs/recorder.log`, the `claude`
one answering `--version` with `claude fixture-recorder` and a one-shot with a fixed title;
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`, two empty folders beside them; the issuer and the
keychain file. Nothing else of the parent process reaches the daemon or the relay: no agent
login, no server address. The claim is exactly that: an allowlisted environment and two empty
credential folders.

Five checks, printed first, every boot; one failing stops the boot with exit 2:

1. before any process starts, the daemon's command carries the three flags and
   `--dev-echo-adapter` (`preBootChecks` in `fixture-stack.mjs`);
2. before any process starts, the environment handed to the daemon is the allowlist plus
   the stack's own variables, its `SHELL` the stub, the first folder of its `PATH` the
   recorders', `CLAUDE_CONFIG_DIR` and `CODEX_HOME` the empty folders (`preBootChecks`; no
   shell is run for it);
3. after the daemon has announced itself and before anything is seeded, its discovery file
   (`clave-server.json`) says `titles: "off"`, `testMode: true` and `machineUsage: false`
   (`startStack`, step 3b);
4. at the same moment, read inside the daemon through its test route (`POST /e2e/evaluate`,
   `packages/server/src/fixtures/route.ts`, there only under `--test-no-activate`). On a daemon
   carrying lane C's title hooks (`globalThis.__claveE2E.titles`, PR #354 from 33524ed6) the
   title module itself answers `launch()`, the one-shot's executable, arguments and PATH as a
   real one would resolve them from the daemon's cached login environment, and `locate()`,
   a command on that PATH; on a daemon without them a dynamic import by absolute path lands on
   the daemon's own module instances and the launch is built the way the title path builds
   it. The facts say which road was taken. The cached environment (read from the daemon's own
   backend module either way) must resolve `claude` and `codex` to the recorders by canonical
   path and name the empty folders; the one-shot's executable must have the recorder's
   canonical path, no wrapper token may precede its own arguments, and on the module road its
   environment must carry no credential (`startStack`, step 3c, `assertInside`). Nothing runs
   here;
5. only then the daemon itself runs the probe (`startStack`, step 3d): inside the daemon the
   one-shot's executable is resolved again the same way, its canonical path checked once more
   against the recorder's and the probe's arguments against exactly `--version`, a wrapper or
   a foreign path refused without starting anything, and the recorder must answer its fixed
   line and leave exactly one line in the recorder log. Before the probe the log is absent,
   which is no call yet; after it, that one line is the watch's baseline (`assertProbe`). The
   watch starts here and covers the sign-in, the seed and everything after.

From the probe to the stop, the recorders and the two folders are read every half second
(`startStack`, steps 3e and 7b, `inspect`): a line beyond the baseline, a file in a folder, a
log that lost the probe's line, is missing or cannot be read, or a folder that is missing, a
symlink or unreadable (a read that fails is a failure, never "no calls" or "empty") stops the
daemon, latches the problem through the cleanup and the step under way, and ends the run with
exit 2, in every mode (the long run `fixture-check.mjs` uses, `--once`, `--self-check`). Nothing under `~/.claude` or any other
folder of this Mac is read: the evidence is the stack's own recorder log and its own two
folders.

Proofs that the checks go red, every flag kept so no boot ever runs with wrong flags, and only
the stack's own files touched: `--prove-tmpdir-guard` starts nothing; `--prove-prerequisites`
hands the third check a discovery read saying `titles: "on"`; `--prove-inside cache` hands the
fourth a cached login `PATH` without the recorders, `--prove-inside resolver` a one-shot whose
file is not the recorder, `--prove-inside args` arguments other than `--version`, each refused
before the probe, and `--prove-inside probe` hands the daemon a wrong expected canonical path,
which it refuses to run, nothing started; `--prove-recorder-read missing|unreadable` removes or
replaces the owned recorder log while the stack runs and expects the watch to latch a failure;
`--prove-title-guard` plants one line in the recorder log while the stack runs and expects the
watch to stop the daemon. That a real title call reaches the recorder rather than the CLI was
shown on 9 November 2026 at 11:29 and 11:30, before `--no-titles` existed; after lane C's
fixture is on `mobile`, its `--mutate drop-title-opt-out` is the verifier's knob for that proof.

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
