# Clave on the phone: the package, the toolchain, the checks

`packages/mobile` (`@clave/mobile`) is Clave on an iPhone or an Android phone: the sessions
running at home, their conversations, the agents' requests, a launch from a saved profile
(the spec: `knowledge/specs/2026-10-29-mobile-app.md` on clave-os, decisions 1, 6, 7 and 8;
the acceptance criteria: issue #283). React Native 0.88.1 on Expo SDK 58.0.21, React 19.3.1,
TypeScript strict, every dependency exact-pinned, one root `workspaces` entry and the
repository's one lockfile. No build service: the native projects are generated and built here.

## The host, verified on 29 October 2026

| Tool                     | What is on this Mac                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xcode                    | 26.0.1 (17A400), Swift 6.2.0, the iOS 26.0 simulator runtime (iPhone 17 Pro, iPhone 17 Pro Max) and iOS 17.5 (the iPhone 15 family)                                                                                                                                      |
| CocoaPods                | 1.16.2 (`pod` wants a UTF-8 locale: `LANG=en_US.UTF-8`)                                                                                                                                                                                                                   |
| Android SDK              | `~/Library/Android/sdk`: platform android-36, build-tools 36.1.0, platform-tools (`adb` 1.0.41 on the PATH), the emulator at `~/Library/Android/sdk/emulator/emulator` (not on the PATH), one AVD `Medium_Phone_API_36.1`; no `cmdline-tools`                                 |
| JDK                      | `/usr/bin/java` is Apple's stub and runs nothing. Homebrew's `openjdk` is 27.0.1 (`/opt/homebrew/opt/openjdk`; 26.0.1 stays in the Cellar unlinked since the Maestro install upgraded the formula). Gradle 9.4.1 refuses JDK 27 class files; the successful Android build uses `/opt/homebrew/opt/openjdk@21` |
| Node, npm, Bun           | Node 24.18.0, npm 11.16.0, the repository's own Bun 1.4.1 (`node_modules/.bin/bun`, which runs the standalone server from its sources)                                                                                                                                     |
| Maestro                  | 2.12.0 from `brew install mobile-dev-inc/tap/maestro` (the `maestro` cask in homebrew-core is another product). It needs `JAVA_HOME`                                                                                                                                       |
| Watchman, Expo CLI, Gradle | none installed globally; the Expo CLI runs through `npx` from the package, Gradle through the project's wrapper                                                                                                                                                         |

Export what a command needs in your own shell; nothing here edits a shell profile:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
brew install openjdk@21
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export LANG=en_US.UTF-8
```

## The commands, from a fresh clone

```sh
npm install                       # at the repository root: one install for every workspace
cd packages/mobile
npm run typecheck                 # tsc --noEmit
npm run lint                      # the root ESLint config, one tree
npm test                          # vitest, the package's own config, under Node
npm run check:release-bundle      # two Metro exports: the developer screen present in dev, absent in release
```

The native projects are generated, never edited (`ios/` and `android/` are git-ignored):

```sh
npx expo prebuild --platform ios --clean      # the iOS project; applies plugins/with-jsi-xcode26.js
(cd ios && LANG=en_US.UTF-8 pod install)
npx expo run:ios --device 26A905C4-1DFF-453C-8846-C9904410448E     # builds, installs and opens the app on the simulator, with Metro
npx expo prebuild --platform android --clean
npx expo run:android --device emulator-5558   # with the emulator booted (below)
npx expo start --port 8081                    # Metro alone, for an app already installed
```

A development build loads its JavaScript from Metro on port 8081: the iOS simulator reaches
the Mac's loopback directly; the Android emulator needs `adb -s <serial> reverse tcp:8081
tcp:8081` (the Expo CLI does it) and `adb -s <serial> reverse tcp:43201 tcp:43201` for the
server below.

Device pinning (the wave of 29 October 2026 shared this Mac between several lanes): name the
device on every call. Lane C used the iPhone 17 Pro simulator
`26A905C4-1DFF-453C-8846-C9904410448E` and the Android instance started as
`emulator -avd Medium_Phone_API_36.1 -port 5558` (serial `emulator-5558`); its verifier the
iPhone 17 simulator `223E6321-2F84-4E05-96CC-56672716B8EA` and `-port 5560 -read-only`
(`emulator-5560`). An `emulator-5556` on this Mac belongs to another wave.

### What the first build cost

Measured on 29 October 2026 on this Mac under a load average above 100 (five lanes building at
once), so these are observations under load, not timing guarantees:

| Step                                                  | Minutes |
| ----------------------------------------------------- | ------- |
| `npm install` at the root, the mobile workspace added | 0.5     |
| `expo prebuild --platform ios --clean`                | 1       |
| `pod install`                                         | 1.5     |
| `expo run:ios` (xcodebuild, Debug, simulator)         | 2.7     |
| `expo prebuild --platform android --clean`            | 0.1     |
| `expo run:android` (Gradle, debug)                    | 3.8 under JDK 21 |

The first `expo run:ios` attempt failed: expo-modules-jsi 58.0.21 does not compile under Xcode
26.0.1 (Swift 6.2.0), `JavaScriptObject.swift:946: sending 'slot' risks causing data races`
(expo/expo#52462, open on that day). The module's own fix for the same error elsewhere
(expo/expo#51040, released in 58.0.9) wraps the captured pointer in its `UncheckedSendable`
struct; `plugins/with-jsi-xcode26.js` applies that one change at prebuild time, idempotently,
and fails loudly the day the module's code is neither the known original nor the patched form.
Delete the plugin when expo-modules-jsi ships the fix or when the team's Xcode moves to a Swift
that accepts the original.

## Signing

Simulator and emulator builds need no signing, and nothing on this Mac signs a device build of
Clave mobile. The generated iOS project names no team and no certificate; release signing is
unset; the bundle id is `com.clave.app.mobile` on both platforms (the Mac app is
`com.clave.app`), the scheme `clave`. The Apple team, the app id with the push capability, the
provisioning profiles and the APNs key are the human's to create; the device artifacts (a
TestFlight archive, a signed APK) are built on top of that by the beta's delivery lane.

## The standalone server the app is developed against

```sh
npm run dev:server            # from packages/mobile: scripts/dev-server.mjs
```

It starts this checkout's server entry as a daemon under the repository's Bun, on
`127.0.0.1:43201` by default, with the Echo adapter on (`--dev-echo-adapter`: a deterministic
chat that repeats what it is told, a fixture and not a real provider), its data in
`/tmp/clave-mobile-c/server`, its secrets in a keychain file under that folder
(`CLAVE_KEYCHAIN_FILE`, never the login keychain), and registers `/tmp/clave-mobile-c/scratch`
as a workspace named `scratch`. It prints `CLAVE_SERVER_URL` and `CLAVE_SERVER_TOKEN` for the
developer connection screen. The daemon is the shape of a server at home: it owns its sessions,
keeps 2000 events of history per session and serves the pending requests. Sessions started on
it run the real agents of this Mac under the person's own logins, so keep them on the scratch
folder. The files route needs the desktop's native helpers built once at the root
(`bash scripts/build-native.sh`).

A development build offers **Developer connection** at the foot of the Machines screen: the
server's address and token, kept in the phone's secure store under a machine id of the form
`dev:<host>:<port>`. The screen exists in development builds only (`__DEV__`), and
`scripts/check-release-bundle.mjs` proves its absence from a release bundle on every CI run.

## The package, in one screen

- `src/contract/`: the shapes of the wire the phone speaks, mirrored from `@clave/contract` as
  plain TypeScript with hand-written decoders, and **pinned** to the contract by
  `contract-pin.test.ts`, run under Node, where the contract loads: the same samples decode
  through the contract's Effect schemas and the mirror to equal values, the inputs the phone
  sends decode through the contract's command payloads, and every shape is assignable both ways
  at the type level. The contract itself does not bundle under Metro: the probe of 29 October
  2026 fails at the first framework import (`@structure-ai/cqrs/src/index.ts` imports `./bus.js`,
  a TypeScript source named by its `.js` extension, which Metro does not resolve), before the
  `node:*` modules and the Bun global the audit named.
- `src/api/`: `ClaveServerClient` on the platform's `fetch` (10 s deadline, 60 s on a page of
  history; a 401 is `unauthenticated`, a 422 is the server's declared failure in its own words)
  and `ClavePushClient`, the desktop's push client ported with a liveness ping (a ping every
  20 s once open; a socket that answers nothing within 10 s is closed and reopened).
- `src/chat/`: the conversation reducer ported from `plugins/chat-view/src/reducer.ts` with
  its semantics (deltas joined until `final`, tool calls paired with results by id, the
  permission cards and what the kernel's state does to them), the page cursor, the drafts
  (one per session per machine, in AsyncStorage), and the composer's send with the
  reconciliation table of the write-status seam.
- `src/machines/`: `MachineSource` with two sources (the relay's contract from lane E; the
  developer connection), the credential store on expo-secure-store, and the transport policy.
- `src/state/`: the Zustand store, the state mapping and the workspace rule.
- `src/screens/`, `src/navigation/`: Machines, Workspaces, Sessions, Chat, Launch, Requests,
  Developer (development only), on React Navigation's native stack.

## The decisions the lane took

- **Navigation**: React Navigation 7 with the native stack, not Expo Router (whose SDK 58 peers
  pull `@expo/ui`, reanimated, worklets, gesture-handler and react-server-dom-webpack).
- **Where the app opens**: a warm resume from the background keeps the navigator in memory; a
  cold launch (a new process) opens Machines then the Workspaces of the current machine, with no
  machine picker when one is already paired or selected; a notification tap is the deep link
  `clave://chat/<machineId>/<sessionId>`, which opens that conversation on either path. Elapsed
  time is never the signal of how the app was closed. The platform limit, plainly: iOS gives no
  signal that distinguishes a person's force-close from an eviction, so on iOS every new process
  is a cold launch; Android may hand back saved instance state after a process death, which this
  app does not read yet, so a new process is a cold launch there too.
- **Test runner**: vitest, the repository's own; every test is plain TypeScript over injected
  ports (fetch, WebSocket, storage, the secure store) and runs under Node.
- **State**: Zustand 5. **Drafts**: `@react-native-async-storage/async-storage` 2.2.0 behind
  one key-value port.
- **Simulator driver**: Maestro, with `scripts/simulator-check.mjs` around it (below).
- **Sessions and workspaces**: a live session carries no workspace; its record does. A session
  shows under the workspace its record is stamped with, else under the workspace whose root
  holds its working folder, else under every workspace of the machine, the desktop's own rule for
  an unstamped remote tab.
- **Launch**: the profiles are those `GET /launch-profiles` answers on the person's main machine
  (the first paired, or the one marked main), chat profiles first; the terminal built-ins of the
  Mac's own constant are not offered, since the phone shows no terminal. The start carries the
  profile's full definition (`launchProfile`, the seam the Mac uses for a server), the family
  boolean, `launchProfileId` and the workspace; the target's accounts are never carried; a
  refusal shows the server's sentence verbatim and the list stays.
- **Requests**: `GET /requests/pending`, refreshed on `requests.changed`; a permission answers
  with an option id, a native question (a request with a provider id) answers as a permission
  with the option `answer` and the answers keyed `q.id ?? q.question`, a multi-select joins its
  picks with `, `; a secret travels in the resolve body and nowhere else; a refused resolution is
  shown and the request goes. A server without the requests port (an in-process one) answers
  `CapabilityUnavailable`; the chat's own permission cards answer through the write route then.
- **Documents for review**: a `tool_call` named `clave_open_side_panel` in the stream becomes a
  card; the file is read through `GET /files/read` with its folder as root; the card says
  editing is done on the Mac. The daemon's own agent tools do not include that tool, so against
  a daemon the card is proven with the Echo fixture's injected stream, never with a real agent.
- **Sends**: an id of 8 to 64 characters minted per message (`clientMessageId`; the server
  honours it once lane B lands, a server before that drops the field). When a write's answer
  is lost, the phone asks `GET /sessions/writes` and applies the table: `accepted` clears the
  draft; `pending` is asked again with backoff for at most 60 s, then counts as `unknown`;
  `rejected` keeps the draft and shows the reason; `absent` completes the same send once with the
  same id; `unknown` sends nothing by itself and leaves the person the choice (send again under a
  new id, with the warning that it may duplicate, or discard). A server without the route (404)
  cannot tell: `unknown`.
- **Credential transport**: https (and wss) always; plain http only in a development build and
  only to the loopback; a release build sends a credential to no plain-http address and ignores
  such addresses. The relay road is the base URL of a machine; the direct addresses a record
  carries are not used by this client.
- **Versions**: React 19.3.1 (the SDK lists 19.3.0; 19.3.1 is what matches the root's react-dom
  19.3.1), TypeScript 5.9.3 shared with the root (the SDK suggests 6.0), `@types/react` 19.3.0.

## The checks

- **Unit**: `npm test`, 12 files: the contract pin, the transport against a stub HTTP server, the
  push client against a `ws` server (hello, subscribe, events, reconnect, liveness), the reducer,
  the cursor, the drafts, the state mapping, the answer shaping, the machine sources against a
  stub relay, the send table (each branch; `unknown` sends nothing), the transport policy
  (release-side refusals, nothing sent), the navigation rule and the deep link.
- **Release bundle**: `npm run check:release-bundle` exports the development bundle (the
  developer screen's markers must be there, or the check is looking for the wrong thing) and the
  release bundle (they must be absent), and exits non-zero either way round.
- **The simulator check**: `npm run check:simulator` (`scripts/simulator-check.mjs`) starts a
  standalone server of its own with the Echo fixture, seeds a workspace and an Echo chat holding
  a message with a nonce, boots the iPhone 17 Pro simulator, installs the development build
  `expo run:ios` made (found in Xcode's DerivedData), starts Metro, and runs the Maestro flow
  `e2e/chat.yaml`: the developer connection, the machine, the workspace, the session, the seeded
  text in the history, a reply typed on the phone and the Echo's repeat of it. It exits with
  Maestro's code and stops what it started. The narrative of lane C records the run that passed
  and the run made to fail on purpose.
- **CI**: `.github/workflows/mobile.yml` runs the typecheck, the lint, the unit tests, the
  export for both platforms and the release-bundle check on Linux. The simulator check needs a
  Mac and is run by hand.

## What a real provider proves, and what the fixture proves

Every result obtained with the Echo adapter is a fixture result: the Echo repeats what it is
told, deterministically, and raises no request. A result on a real provider (one short Claude
chat through the Mac's own login, on the scratch folder, on this band's server data) is named
as such where it is reported. The integration proof of the beta on a real provider (a launch
from the phone, the agent's reply, a reply back, the same session on an attached desktop)
belongs to the beta's delivery lane, not to this package's checks.
