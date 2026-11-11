# Clave on the iPhone

The native iPhone companion of Clave: a SwiftUI app under `Clave/`, its logic in the
local Swift package `ClaveCore/` (Foundation only, so its tests run on the Mac as on the
simulator), the host tests in `ClaveTests/`, the UI tests in `ClaveUITests/`. It speaks
the server's wire contract as the React Native prototype did (`docs/mobile*.md`,
`packages/contract/src`), signs in at the Antasphere hub through the system browser,
keeps its credentials in the Keychain apart from its settings and drafts, isolated per
owner, and draws the desktop's four themes with Geist and Heroicons from the owned tokens
and assets. No React Native, no JavaScript engine, no WebView.

Identifiers: bundle `com.clave.ios.dev` in Debug and `com.clave.ios` in Release (the
identifier a store build carries is owed with the Apple team), callback scheme `clave-ios`
(`clave-ios://oauth/callback`, the deep link `clave-ios://chat/<machineId>/<sessionId>`),
OAuth client name `Clave iOS`, Keychain service `<bundle id>.credentials`
(`com.clave.ios.dev.credentials` in Debug, `com.clave.ios.credentials` in Release).
Deployment target iOS 17.

The key-value store (one JSON file in the app's support folder, every key under the owner's
namespace) keeps each machine's sends of unknown outcome under a key of its own,
`clave.unknown-sends:<machineId>`. The app has had development installs only; records still
under the old shared key `clave.unknown-sends` are moved to their machine's key at the owner's
first connection. A machine's records move only into a ledger that does not exist yet (a ledger
emptied since keeps its key, holding an empty list); the old list is removed only after every
machine's write succeeded; and a move that failed runs again at the next connection made.
A send whose record left its ledger while the conversation's mark still says its outcome is
unknown (a failed write during that move, or a process end between two of a settle's writes)
keeps the bar until the person chooses: Discard or Send again then clears the bar, says the
phone cannot tell whether the message was delivered, and sends nothing; the draft and the
picked files stay, and the person checks the conversation before sending it again.
When the server refuses this phone's attempt to complete a send of unknown outcome (401, 403,
or a 422 that says the session refused the write or does not exist), the send stays unknown and
the phone never writes it again by itself; a later status answer of accepted or rejected still
settles it, and the person's choice on the bar ends it. A send whose record was kept but whose
mark could not be written is shown as unknown, never as not sent, until a pass settles it or the
person chooses.

## The toolchain

Xcode 26.0.1 (17A400) with Swift 6.2 and the iOS 26.0 simulator runtime; the iOS 17.5
runtime for the oldest supported system. Nothing else: no generator, no pods, no package
beyond the local one. Node 24 and the repository's `npm install` are needed only by the
scripts that regenerate the tokens and the icons and by the fixture stack, never by the
build.

## The commands

From `apps/mobile-ios`, with a simulator you created (`xcrun simctl create <name>
"iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-0` prints its UDID):

```sh
# the core's tests, on the Mac, seconds
(cd ClaveCore && swift test)

# the app, built for the simulator
xcodebuild -project Clave.xcodeproj -scheme Clave \
  -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath /tmp/clave-ios/DerivedData build

# every test target on the simulator (the package's, the host's, the UI tests)
xcodebuild -project Clave.xcodeproj -scheme Clave \
  -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath /tmp/clave-ios/DerivedData test

# install and launch the unsigned development build on that simulator
xcrun simctl boot <udid>
xcrun simctl install <udid> /tmp/clave-ios/DerivedData/Build/Products/Debug-iphonesimulator/Clave.app
xcrun simctl launch <udid> com.clave.ios.dev
xcrun simctl shutdown <udid>
```

A Debug build reads the fixture's addresses from its launch environment
(`CLAVE_IOS_ISSUER`, `CLAVE_IOS_RELAY`, plain http to the loopback) and offers the
Developer connection at the foot of the Machines screen; a Release build ignores both and
reaches the hub at `https://account.antasphere.com` and the relay the person enters, over
https alone. The Info.plist's loopback exception is merged into the Debug configuration
only (`Config/Info-Debug.plist`), and the transport policy refuses plain http in a release
build a second time.

`bash apps/mobile-ios/ci.sh`, run from the repository root, is the gate the mobile CI job
runs on a macOS runner: the core's tests, the simulator build, the host tests, the launch
smoke test and the shell's flow (`ShellFlowTests`, against the in-process fake the launch
argument `--ui-test-fake` selects in a Debug build), then `scripts/check-release-binary.sh`,
which builds Release and proves the fake, the launch overrides and the developer connection
are absent from its binary (`--prove-red` builds Release with `DEBUG` set and expects the
check to fail). `CLAVE_IOS_SIMULATOR_UDID` names the simulator (on a shared Mac, name one you
created). Unset, as on the hosted runner, the gate takes the first iPhone on the newest iOS
that `xcodebuild -showdestinations` lists for the scheme and fails with a sentence saying so
when there is none, so no runtime version is written in the gate. The listing it judged and the
runtimes `xcrun simctl list runtimes` names are kept under `build/reports` (which the mobile
job uploads) and printed when no iPhone is picked: the hosted run of 10 November 2026 at
19:34 UTC picked none and left no listing to read; its run at 20:10 UTC kept it: Xcode 26.0.1
lists only the Mac and the two placeholders there, beside the iOS 26.2, 26.4.1 and 26.5
runtimes, so no simulator exists for it on that image; its runs at 20:31 and 20:37 UTC showed that
it cannot build the app there for any platform either, a simulator or a device: the asset
catalog compiler refuses without a simulator runtime of its SDK ("No simulator runtime version
from ["23C54", "23E254a", "23F77"] available to use with iphonesimulator SDK version 23A339").
So when the job names an installed Xcode whose runtime the runner has in
`CLAVE_IOS_SIMULATOR_DEVELOPER_DIR`, every xcodebuild step (the pick, the build, the tests and
the release check) runs under it, its folder checked and its version printed, and the job's own
Xcode keeps the core package's tests; unset, as on this Mac, every step runs under the job's
own Xcode. The app built with Xcode 26.0.1 is this Mac's evidence; on the hosted runner Xcode
26.0.1 covers the core package alone. The hosted run's evidence
is on whatever runtime the runner's image carries, which its log names (`ci: picked …`), and
the iOS 17.5 evidence is this Mac's alone, never claimed for CI. Each step's verdict is its tool's own
exit code, the output read from a log file afterwards; `bash
apps/mobile-ios/scripts/prove-ci-gate.sh` runs `ci.sh` with stand-ins for swift, xcodebuild
and xcrun and proves it exits non-zero, without printing `ci: green`, when any one of the
four steps fails, that the real release check fails on a Release output that is missing or
carries a development-only marker, and that a runner's simulator pick takes the newest
iPhone its Xcode lists, never an ineligible one, and fails when there is none or the list
cannot be read. An installed runtime is not a created device: under the named Xcode the hosted
run at 9b675556 picked iPhone 17 on iOS 26.5, while the one at 5d176d40 was offered only the Mac
and the two placeholders though the iOS 26.2, 26.4.1 and 26.5 runtimes were installed, so the
gate also keeps simctl's devices, device types and runtimes (JSON) and the Xcode's version and
SDKs under `build/reports`, and when no iPhone is listed it makes one of its own,
`clave-ci-<epoch>-<pid>`, on the installed, available iOS runtime of the simulator SDK (26.2 or
26.2.x for the SDK 26.2), as that runtime's first iPhone device type, which its log names
(`ci: made simulator …`), checks that the scheme lists it, runs every step on it and deletes it,
and no other device, on every exit, failing with a sentence and making nothing only when no
runtime matches the SDK.

## The fixture check

`scripts/README.md` describes the isolated stack: the local OpenID Connect provider, this
checkout's relay and its standalone server with the Echo adapter, all on 127.0.0.1, the
owner signed in, one Echo chat seeded with a nonce.

```sh
node apps/mobile-ios/scripts/fixture-stack.mjs --dry-run        # the two pre-boot checks, nothing started
node apps/mobile-ios/scripts/fixture-stack.mjs --self-check     # the stack alone, proven through the relay road
node apps/mobile-ios/scripts/fixture-check.mjs --udid <udid>      # the UI tests of the app against it
```

Every result of the Echo adapter is a fixture result: it repeats what it is told and
raises no request. The daemon itself is not a fixture, and two boots of this stack on
9 November 2026 (11:18:58 and 11:19:54) let it make a real one-shot call of the Claude CLI
under the machine's login, to name the seeded Echo chat by its first message, a fixture
nonce: the daemon names every fresh Claude-mode chat that way, the Echo fixture included,
and reads the machine's Claude and Codex usage unless told not to. Since then every boot
runs six checks and refuses unless all pass (`scripts/README.md`): before the relay and the
daemon start, both commands start Bun with `--no-env-file` before their entry, the daemon's
carries `--no-titles`, `--test-no-activate` and `--test-no-machine-usage`, and its environment
is an allowlist plus the stack's own stub shell (printing a fixed environment the stack wrote),
recorders and empty credential folders; after the daemon announces itself and before
anything is seeded, its discovery file says `titles: "off"`, `testMode: true` and
`machineUsage: false` (lane C's fix, PR #354 against `mobile`), a read inside the daemon
shows its cached login environment and its one-shot resolver naming the recorders, and the
daemon runs that one probe itself, the recorder answering. After the seed the recorders and
the folders are watched for the whole run against the probe's line; one call beyond it, one
file, or a recorder log that cannot be read stops the daemon. The run folder is the stack's
own, marked with its owner id, or the boot refuses before touching it. Until that fix is on `mobile` and this branch is rebased onto it, the daemon
announces none of the three and the boot refuses before the seed; every fixture boot that
starts a session, seeds, writes or launches is on hold until the wave's coordinator lifts it.

## What a device install needs

Nothing here signs a device build. An Apple team with the app identifier, a provisioning
profile for it, and the push capability on that identifier (an APNs key for the server's
`push/apns.json`) are the team's to create; the entitlement file
(`Config/Clave.entitlements`) already asks for the development push environment. Until
then the app runs on the simulator alone, where a push arrives through `xcrun simctl push`
and never through APNs.

## Regenerating what is generated

```sh
node scripts/generate-tokens.mjs            # Clave/Theme/Tokens.generated.swift from packages/ui/src/tokens.css
node scripts/generate-tokens.mjs --check    # exits 1 when the committed file is stale
node scripts/build-icons.mjs                # the Icons folder of Assets.xcassets and Clave/Theme/IconName.swift
```
