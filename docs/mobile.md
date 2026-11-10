# Clave on the phone: the two native apps and what they share

Clave on the phone is two native apps on the same server and the same wire contract: a
SwiftUI app under `apps/mobile-ios` and a Kotlin and Jetpack Compose app under
`apps/mobile-android`. Neither holds React Native, Expo, a JavaScript engine or a screen
rendered by a WebView (the decision of 9 November 2026). Each app's README is the reference
for its toolchain, its commands and its identifiers; this page says what they share and
where it lives.

The React Native prototype that came first (`@clave/mobile`, React Native 0.88.1 on Expo
SDK 58) is retired from this tree, with its scripts. It stays readable on the branch
`mobile-react-native-baseline-20261109` (at `00e16111`): the apps' sources name the
prototype files they were ported from by their path on that branch.

## The two apps

|                  | iPhone                                                         | Android                                                            |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Folder           | `apps/mobile-ios`                                              | `apps/mobile-android`                                              |
| Interface        | SwiftUI, its logic in the Swift package `ClaveCore`            | Kotlin and Jetpack Compose, its own Gradle build                   |
| Toolchain        | Xcode 26.0.1, the iOS 26.0 simulator runtime; iOS 17 and later | JDK 21, compileSdk 37; Android 8.0 (minSdk 26) and later           |
| Identifier       | bundle `com.clave.ios.dev`                                     | application id `com.clave.app.android` (`.debug` on a debug build) |
| Sign-in callback | `clave-ios://oauth/callback`                                   | `clave-android://oauth/callback`                                   |
| CI entry         | `bash apps/mobile-ios/ci.sh`                                   | `bash apps/mobile-android/ci.sh`                                   |
| Reference        | `apps/mobile-ios/README.md`                                    | `apps/mobile-android/README.md`                                    |

Neither identifier is the prototype's `com.clave.app.mobile` or the Mac app's
`com.clave.app`, so a test install never replaces another app or reads its data. Both apps
sign in at the Antasphere hub through the system browser, keep their credentials in
the platform's protected store (the Keychain, the Android Keystore), one namespace per owner
(issuer and subject), apart from settings and drafts, and speak https only in a release
build; plain http to the loopback is for debug builds and the fixture.

## The wire

Both apps speak the server's contract (`packages/contract/src`) as the Mac does. The
server's side of it is documented beside this page: pairing and the device session in
[mobile-pairing.md](mobile-pairing.md), machine discovery through the relay in
[mobile-relay.md](mobile-relay.md), notifications in [mobile-push.md](mobile-push.md), the
ordered history in [mobile-timeline.md](mobile-timeline.md), the account in
[antasphere-account.md](antasphere-account.md) and the agents' requests in
[server-requests.md](server-requests.md).

## What the two apps share: `packages/mobile-native`

`packages/mobile-native/README.md` is the reference. In one screen:

- `fixtures/`: the fixture vectors, the wire shapes and commands the phones use, exported
  from the contract's own Effect schemas and commands, each sample decoded through the
  contract; `vectors.test.ts` exports them again and fails on any drift.
- `assets/`: the four desktop themes' tokens read from `packages/ui/src/tokens.css`, the
  Heroicons paths and Geist Sans (OFL), generated deterministically; `assets.test.mjs` fails
  when a generated file no longer matches its source.
- `scripts/fixture-server.mjs`: the fixture server both apps are tested against, this
  checkout's own server as a daemon with the Echo adapter, a local relay and a local OpenID
  Connect provider on ports the caller names, its processes kept off every real provider and
  proven so. `--check` runs its proof and exits 0 only with its summary line.

```sh
npm ci
npm run vectors:check --workspace @clave/mobile-native   # exit 1 on drift, writes nothing
npm run assets:check --workspace @clave/mobile-native
node packages/mobile-native/scripts/fixture-server.mjs --check \
  --server 47301 --relay 47302 --issuer 47303 --tmpdir /private/tmp/clave-native-c
```

The iOS simulator reaches the Mac's `127.0.0.1` directly; the Android emulator reaches the
three ports through `adb reverse`. Each app's README says how its own fixture check starts
the stack and drives the app against it.

## CI

`.github/workflows/mobile.yml` has four jobs: one that says which app folders are here; the
Linux job for the vectors, the assets and the fixture server, its booted cases included; the
iPhone app on macOS with Xcode 26.0.1; the Android app on Linux with JDK 21. An app job whose
folder is absent says so in one line and passes. `npm run check:structure` requires each app
folder that exists to hold its `ci.sh` and no `package.json`.

## What a fixture result proves

Every result obtained with the Echo adapter is a fixture result: the Echo repeats what it is
told, deterministically, and raises no request. A check on a real provider is a separate,
explicitly authorized step, named as such where it is reported. The evidence stays in four
classes, never merged: package and signing; simulator or emulator; hosted relay; physical
device.

## Signing and distribution

Nothing in this tree signs a device build or publishes one. What a beta needs from the team,
and how the beta is used from the Mac, is in [mobile-beta.md](mobile-beta.md).
