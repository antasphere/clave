# apps/mobile-ios/scripts

`generate-tokens.mjs` and `build-icons.mjs` generate the desktop's tokens and icons for
the app. The other two scripts run the app against an isolated fixture stack on this Mac.
`check-release-binary.sh` (bash, from `apps/mobile-ios`, `CLAVE_IOS_SIMULATOR_UDID` required)
builds Debug and Release for the simulator and reads both binaries with `strings`: the
development-only markers must be in Debug and absent from Release, a binary that is not
there fails the check rather than reading as one without markers, and each app must carry its
own identifier (Debug `com.clave.ios.dev`, Release `com.clave.ios`, so the two never share a
container or a Keychain service); `--prove-red` shows the check fails when the guard is off.
`prove-ci-gate.sh` (bash, from `apps/mobile-ios`) runs `ci.sh` in a scratch folder with
stand-ins for swift, xcodebuild and xcrun, and proves three things: the gate exits non-zero,
without printing `ci: green`, when the core's tests, the build, the tests or the release
check fail; the real `check-release-binary.sh`, reading the binaries the xcodebuild stand-in
writes, passes a clean Release output and fails one carrying a development-only marker, one
missing altogether and one carrying the Debug build's identifier; and with no simulator named, the gate fails on a runner with no
iPhone and skips a runtime newer than the Xcode's simulator SDK. `--against <file>` and
`--release-check <file>` run the scenarios on other copies: the copies at df0332c9 read green
with no Release output and pick the newer runtime, and the ci.sh at ca3f0f35 read green on a
failed build and on failed tests.

## The fixture stack

```sh
node apps/mobile-ios/scripts/fixture-stack.mjs [--approve] [--dry-run | --self-check | --once | --prove-tmpdir-guard | --prove-env-guard stray|no-env-file|live-stub|relay-issuer | --prove-home-guard | --prove-prerequisites | --prove-inside keys|cache|resolver|args|home|probe | --prove-recorder-read missing|unreadable | --prove-title-guard recorder|folder]
node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid> [--only <xcodebuild -only-testing value>]
```

`fixture-stack.mjs` brings the stack up and keeps it running until Ctrl-C. `--approve`
approves every phone that asks to pair. `--self-check` proves the stack end to end and
exits. `--once` brings it up, prints it and tears it down; both keep the stack up at least
12 s under the recorder watch. `--dry-run` runs the four pre-boot checks below on the very
commands and environments a boot would use, prints those commands and exits without starting
anything. A boot whose checks fail, whose watch catches a call, or whose run keychain's bracket
fails (below) exits 2.

`fixture-check.mjs` brings the stack up with approval on, boots the simulator if it is
not booted, runs `xcodebuild test` (by default `-only-testing:ClaveUITests/FixtureFlowTests`),
tears the stack down and exits with xcodebuild's code. `--push <payload.json>` sends a
notification to the app once the tests are done. `--keep` leaves the stack up until
Ctrl-C. The tests get the stack's facts as `TEST_RUNNER_CLAVE_FIXTURE_*` variables:
`ISSUER_URL`, `RELAY_URL`, `SERVER_URL`, `MACHINE_ID`, `WORKSPACE_ID`, `SESSION_ID`, `NONCE`. The owner's
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
works in a fresh sibling it removes at the end. `--prove-tmpdir-guard` shows the refusals (no
marker, another owner, the owner id with an extra newline, no newline, a leading space or a
CRLF line end, a symlink marker, a symlink run root to an owned folder) with their sentinels
intact, an owned folder emptied and reused as the same folder, and a dry run leaving a reused
folder alone.

```
stack.json      issuer, relay, server, serverId, machineId, workspaceId, sessionId, nonce, scratch, tokenFile,
                announced (the three discovery fields), inside (what check 5 read, the daemon's home facts
                included), probe (what the daemon ran and answered), recorderLog, recorderBaseline (the
                probe's one line)
owner-token     the server's bearer token, mode 0600 (the only place the scripts write it)
server/         the daemon's data, and run.keychain-db, the run's own keychain while the run lasts
                (made before the daemon is built, deleted at every stop; no login keychain is touched)
relay/          the relay's data
scratch/        the workspace `scratch` the Echo chat runs in
stubs/          zsh (the daemon's login shell, stood in for), bin/claude and bin/codex (the recorders),
                recorder.log (one line per recorded call, never a prompt; the probe's line first),
                claude-config/ and codex-home/ (the empty folders a real CLI run with that environment
                would write into)
home/           the owned home: the HOME of the daemon, the relay and the stub shell (below), empty at boot
report.json     written at every stop: stoppedAt, home, homeEntries (the names of what is under home/,
                never the content)
logs/           server.log, relay.log, xcodebuild.log
results/        one .xcresult per check
check.json      startedAt, finishedAt, udid, only, exitCode, resultBundle
```

## The owned home

`home/` is the HOME of every child: the daemon's environment, the relay's environment and the
fixed environment the stub shell prints all carry `HOME=<tmpdir>/home`, an empty folder the stack
makes beside its other folders, inside the folder its marker protects, before either child is
built. The stack's own HOME, the person's, is never handed on: it is not in the allowlist. The
empty `CLAUDE_CONFIG_DIR` and `CODEX_HOME` folders the daemon also gets are not enough on their
own: several of the server's readers resolve their paths from the home instead, and Node's and
Bun's `os.homedir()` answer `$HOME` when it is set:

- `packages/analytics/src/collector.ts:61`, the analytics collector's transcripts, `~/.claude/projects`;
- `packages/host/src/session-history/service.ts:92` and
  `packages/host/src/sessions/adapters/claude-adapter.ts:171`, the transcripts,
  `CLAVE_TRANSCRIPTS_ROOT` when it is set, else `~/.claude/projects`;
- `packages/host/src/triage/sources.ts:163`, the triage sources, `~/.codex/auth.json`;
- `packages/host/src/extensions-reader.ts:34` and `:409`, the extensions, `~/.claude` and
  `~/.claude.json`.

The analytics collector runs in the plugin runner, which the plugin host forks with an environment
built from the daemon's own `PATH`, `HOME`, `TMPDIR`, `TEMP`, `SystemRoot` and
`ELECTRON_RUN_AS_NODE` (`packages/host/src/plugins/plugin-host.ts:113-117`), so the daemon's HOME
is the runner's too. `CLAVE_TRANSCRIPTS_ROOT` is not allowlisted, and check 3 requires it set
nowhere, so the transcript readers fall back to the owned home as well. Check 3 proves the HOME of
both children and of the stub before the boot, check 5 proves it from inside the daemon, and at
every stop the names under `home/` are written to `report.json`: the record of what the server
kept there.

## The run keychain

On macOS the server seals the owner's session with `/usr/bin/security add-generic-password`, in
the keychain file `CLAVE_KEYCHAIN_FILE` names (`packages/host/src/ports/secrets.ts`,
`standalone.ts`). The stack names `<tmpdir>/server/run.keychain-db`, an owned file of the run
folder, and makes it at step 0 of every boot, after the run folder's ownership checks and before
the daemon is built, with the repository's reviewed method (`tests/e2e/fixtures/run-keychain.mjs`,
its three commands copied into the stack): `security create-keychain -p '' <file>`, then
`security set-keychain-settings <file>` (no lock on sleep, no timeout). It is never added to the
search list, and every stop, a failed boot included, deletes it with `security delete-keychain
<file>` once the server, the relay and the provider are down. The `security` commands run with
the stack's own environment.

The user's keychain search list (`security list-keychains -d user`) is read once before the
keychain is made and once after it is deleted. The two reads must be equal and must not name the
run's keychain; only the number of entries and the result are printed, never the list, which
names the person's home. A list that differs, names the run keychain, or cannot be read, and a
keychain that cannot be deleted, end the run with exit 2 whatever the mode and whatever its
verdict line says (`fixture-check.mjs` too). The stack never edits the list: a list that already
names the run keychain before the boot refuses it with nothing made.

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
environment is built from an allowlist (`USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TERM`) plus what the stack sets: `HOME`, the owned home (above); `SHELL`, a script named `zsh` under
`stubs/` that prints a FIXED environment the stack wrote into it at boot, the very same
variables, never the environment of any process (the daemon reads its login environment with
`$SHELL -lic 'env -0'`), and runs a `-c` command with /bin/sh; `PATH`, led by `stubs/bin`,
where `claude` and `codex` are recorders that append one line (the time, the command, its
first two arguments, never the stdin) to `stubs/recorder.log`, the `claude` one answering
`--version` with `claude fixture-recorder` and a one-shot with a fixed title;
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`, two empty folders beside them; the issuer and the
keychain file. Bun is started with `--no-env-file` before every entry (the daemon's and the
relay's), since it loads `.env`, `.env.<NODE_ENV>` and `.env.local` from its working directory
otherwise. Nothing else of the parent process or of the repository reaches the daemon or the
relay: no agent login, no server address, not the person's home. The claim is exactly that: an
allowlisted environment, written once into the daemon and once into its stub shell, two empty
credential folders and an empty owned home; check 5 reads the sorted keys of the daemon's
`process.env` from inside and requires them equal to that set.

Seven checks, printed first, every boot; one failing stops the boot with exit 2:

0. before the relay and the daemon start (the provider is in-process), the relay's command
   starts Bun with `--no-env-file` before its entry and names the loopback issuer
   (`preBootChecks` in `fixture-stack.mjs`);
1. at the same moment, the daemon's command starts Bun with `--no-env-file` before the entry
   and carries the three flags and `--dev-echo-adapter`;
2. at the same moment, the environment handed to the daemon is the allowlist plus the stack's
   own variables, its `SHELL` the stub whose text prints exactly those variables and echoes no
   live environment, the first folder of its `PATH` the recorders', `CLAUDE_CONFIG_DIR` and
   `CODEX_HOME` the empty folders (no shell is run for it);
3. at the same moment, the `HOME` of the daemon's environment, of the relay's environment and of
   the fixed environment read back from the stub shell's text is the owned home: exactly
   `<tmpdir>/home`, an empty real folder (a symlink refused, never followed) inside a run folder
   holding the stack's marker, and not the person's own home (the stack's `os.homedir()` or its
   user's login home); `CLAVE_TRANSCRIPTS_ROOT` is set in none of the three. Every value is
   compared as written, so a wrong one is never read, listed or followed, and a failure names
   the child and the key and prints the owned paths alone, never the value;
4. after the daemon has announced itself and before anything is seeded, its discovery file
   (`clave-server.json`) says `titles: "off"`, `testMode: true` and `machineUsage: false`
   (`startStack`, step 3b);
5. at the same moment, read inside the daemon through its test route (`POST /e2e/evaluate`,
   `packages/server/src/fixtures/route.ts`, there only under `--test-no-activate`). On a daemon
   carrying lane C's title hooks (`globalThis.__claveE2E.titles`, PR #354 from 33524ed6) the
   title module itself answers `launch()`, the one-shot's executable, arguments and PATH as a
   real one would resolve them from the daemon's cached login environment, and `locate()`,
   a command on that PATH; on a daemon without them a dynamic import by absolute path lands on
   the daemon's own module instances and the launch is built the way the title path builds
   it. The facts say which road was taken. The cached environment (read from the daemon's own
   backend module either way) must resolve `claude` and `codex` to the recorders by canonical
   path and name the empty folders; the sorted keys of the daemon's `process.env` must equal
   the allowlist plus the stack's own; the daemon's `os.homedir()`, its `process.env.HOME` and
   the cached login `HOME` must be the owned home, the root each reader listed under "The owned
   home" computes, by that reader's own expression, must lie under it, and `CLAVE_TRANSCRIPTS_ROOT` must be unset
   (the plugin runner inherits the daemon's HOME, `plugin-host.ts:113-117`, so this covers the
   collector too); the one-shot's executable must have the recorder's canonical path, and it must
   carry no argument beyond its executable, asserted the same way on both roads: the module road
   builds the launch with no arguments of its own, and on the hooks road the read takes the title
   path's own arguments (`TITLE_CLI_ARGS`, read from the daemon's own `title-generator.ts`) off the
   end of the launch, which must end with exactly them, so no wrapper token can precede the
   one-shot's own on either road; on the module road its environment must carry no credential
   (`startStack`, step 3c, `assertInside`). Nothing runs here;
6. only then the daemon itself runs the probe (`startStack`, step 3d): inside the daemon the
   one-shot's executable is resolved again the same way, its canonical path checked once more
   against the recorder's and the probe's arguments against exactly `--version`, a wrapper or
   a foreign path refused without starting anything, and the recorder must answer its fixed
   line and leave exactly one line in the recorder log. Before the probe the log is absent,
   which is no call yet; after it, that one line is the watch's baseline (`assertProbe`). The
   watch starts here and covers the sign-in, the seed and everything after.

From the probe to the stop, the recorders and the two folders are read every half second
(`startStack`, steps 3e and 7b, `inspect`): a line beyond the baseline, any entry in a folder
(an empty sub-folder included), a log that lost the probe's line, is missing or cannot be
read, or a folder that is missing, a symlink or unreadable (a read that fails is a failure,
never "no calls" or "empty") stops the daemon, latches the problem through the cleanup and
the step under way, and ends the run with exit 2, in every mode (the long run
`fixture-check.mjs` uses, `--once`, `--self-check`); a signal during the boot stops the
children already started and exits 2 when that last read saw a problem. Nothing under
`~/.claude` or any other folder of this Mac is read: the evidence is the stack's own recorder
log, its own two folders and, at the stop, the names under its own `home/`.

Proofs that the checks go red, every flag kept so no boot ever runs with wrong flags, and only
the stack's own files touched (their lines count the checks from 1: check 3 above is "check 4
of 4"): `--prove-tmpdir-guard` starts nothing; `--prove-env-guard
stray|no-env-file|live-stub|relay-issuer` starts nothing and hands the pre-boot checks one thing
wrong (a stray variable, the daemon's command with `--env-file=.env` in place of `--no-env-file`,
a stub shell echoing a live environment, a relay command naming the hub as its issuer),
expecting exactly the check it breaks red and the others green, the key named and never its
value (a live stub breaks two: it prints no fixed `HOME` either, so check 3 goes red beside
check 2); `--prove-home-guard` starts nothing and hands check 3, in turn, (a) the daemon's `HOME`
set to the stack's own `os.homedir()`, built in memory and never printed, (b) the daemon's `HOME`
in a sibling folder outside the run folder, made and removed by the proof, (c) the relay's `HOME`
set to the stack's own home and (d) a stub shell whose fixed text carries another `HOME` (the
stack's block rewritten with it, so check 2 still reads the text the stack wrote and only check
3's read-back can see it), each expected red alone with its exact reason, a case whose check
lines hold the value failing with the lines withheld, then (e) the unmutated build, every check
green; `--prove-prerequisites` hands check 4 a discovery read saying
`titles: "on"`; `--prove-inside keys` hands check 5 one stray key in the daemon's
environment, `--prove-inside cache` a cached login `PATH` without the recorders,
`--prove-inside resolver` a one-shot that would start another executable, `--prove-inside
args` a one-shot carrying `-p` beyond its executable (applied after the read, on whichever road
the daemon serves, and refused with the module road's reason) and `--prove-inside home` another folder (`scratch/`) as
the owned home it expects, so the daemon's real `os.homedir()` must fail it, each refused before
the probe, and `--prove-inside probe` hands the daemon a wrong expected canonical path, which it
refuses to run, nothing started; `--prove-recorder-read missing|unreadable` removes or replaces the owned recorder log
while the stack runs and expects the watch to latch a failure; `--prove-title-guard recorder`
runs the `claude` recorder itself with `-p` while the stack runs (never a CLI), so a foreign
line lands in the recorder log, and `--prove-title-guard folder` plants one file in the owned
Claude config folder; the watch must stop the daemon either way. That a real title call
reaches the recorder rather than the CLI was shown on 9 November 2026 at 11:29 and 11:30,
before `--no-titles` existed; after lane C's fixture is on `mobile`, its `--mutate
drop-title-opt-out` is the verifier's knob for that proof.

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
