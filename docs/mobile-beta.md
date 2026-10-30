# Clave mobile beta

The beta wiring is in progress on the coordinator's integration branch. Sign-in, relay discovery, pairing, attachments and durable sends have native adapters and screens. Cold notification navigation and ordered reconnect hooks have focused tests. Native acceptance, build artifacts and independent verification are still pending. This document does not claim an installable beta candidate.

The phone uses the system keyboard's dictation. It needs no separate transcription service.

## Native modules needed for phase two

The Expo SDK 58.0.21 bundled-module table names these versions. Lane D owns the mobile dependency changes and root lockfile under the coordinator handoff. The install added these exact pins without changing any previously locked package version.

| Module               | SDK 58 baseline | Purpose                                                 |
| -------------------- | --------------- | ------------------------------------------------------- |
| expo-web-browser     | 58.0.7          | System authentication session with PKCE                 |
| expo-crypto          | 58.0.7          | PKCE randomness and SHA-256                             |
| expo-notifications   | 58.1.7          | Raw APNs or FCM device tokens, categories and responses |
| expo-device          | 58.0.5          | Phone name and platform                                 |
| expo-image-picker    | 58.0.10         | Photos, screenshots and camera                          |
| expo-document-picker | 58.0.4          | Files                                                   |
| expo-file-system     | 58.0.13         | Read picked files for upload                            |
| expo-task-manager    | 58.0.12         | Android background notification actions                 |

`expo-secure-store` 58.0.2 is already present. Hub tokens and machine credentials use it. The app registers as a public native client with redirect `clave://oauth/callback`. Automated sign-in uses `tests/e2e/fixtures/oidc-provider.mjs`, never the production hub.

## Attachments

The upload is `POST /files/attachments/prepare`. A message carries the returned attachment records, labels and markers, plus its client message ID. The beta admits ten files per message, each at most 5 MiB, with at most 20 MiB of images together. PNG, JPEG, GIF and WebP can travel as images when the provider supports them. HEIC and video travel as file references with an explanation. Unknown file sizes and unavailable file routes are explicit refusals.

## Credentials still required

These checks remain NOT RUN until the team provides the corresponding prerequisites:

- APNs delivery needs an APNs signing key, its Key ID and the owning Apple Team ID.
- FCM delivery needs a Firebase project, its Android app and a service account.
- TestFlight export needs the team that owns `com.clave.app.mobile`, that app ID with push enabled, an App Store provisioning profile and the team's distribution signing setup. An App Store Connect API key can authorize managed provisioning. The Mac app's team `7F2DZP2LY5` and the local Pupuce CORP distribution certificates on team `7MLU33B3H5` do not establish ownership of the mobile app ID.
- Off-network access needs a deployed TLS relay and a real phone on another network. A local relay proves the protocol only.

No credentials are requested or changed by the pure module tests. No store publication, relay deployment or release is part of this lane.

## Current verification

The pure sign-in tests use the local signed OIDC fixture. Enrollment and upload tests use local HTTP stubs. Notification tests inject the platform interface. Reconnect tests exercise every write status and assert that an unknown outcome sends nothing. These are fixture results, not a real-provider smoke or native-device acceptance.

## Account separation

A secure-store and key-value namespace hashes the issuer and subject together. A subject change reconstructs the store and navigator and disconnects the previous subscriptions. Old asynchronous writes retain their old immutable namespace. A returning owner retains offline drafts, paired credentials and their main machine. Another account cannot read those records.

## Development configuration

`CLAVE_ANTASPHERE_ISSUER` configures the local OIDC fixture for development only. Release sign-in uses the production issuer. `CLAVE_MOBILE_RELAY` supplies the team relay origin; it can also be entered on Machines after sign-in. A release client requires HTTPS. A relay change clears existing pairings before new credentials can travel there.

Native source verification uses `packages/mobile/scripts/native-provenance.mjs`. It compares the bundle actually loaded by Hermes with the requested Metro bundle and compares its source map with this worktree's files. It requires a clean committed candidate. The native driver records the candidate, run marker, explicit device, lockfile hash and native artifact hash beside that source proof. Merely starting Metro on a requested port proves nothing. The earlier in-app proof reporter and its configuration fields were removed.

## Local build scripts

Both scripts require a clean committed worktree. They record the HEAD, tree and lockfile hash in `provenance.json` beside the artifact and refuse source changes during the build. Run native generation and builds through the wave's shared heavy-job lock.

```sh
/tmp/clave-mobile-wave-1029/heavy.sh run D "unsigned iOS archive" -- \
  bash scripts/mobile-build-ios.sh "$PWD" /tmp/clave-mobile-d/ios-candidate

JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" \
/tmp/clave-mobile-wave-1029/heavy.sh run D "signed beta Android APK" -- \
  bash scripts/mobile-build-android.sh "$PWD" /tmp/clave-mobile-d/android-candidate
```

Use a new output directory for each build. The iOS default is an unsigned device `.xcarchive`, which cannot be installed or uploaded to TestFlight. Explicit signing requires `MOBILE_IOS_TEAM_ID`, `MOBILE_IOS_PROFILE` and `MOBILE_IOS_IDENTITY`. `MOBILE_IOS_EXPORT_OPTIONS_PLIST` enables an IPA export with the owning team's settings. Managed provisioning also accepts `MOBILE_IOS_API_KEY_PATH`, `MOBILE_IOS_API_KEY_ID` and `MOBILE_IOS_API_ISSUER_ID`. The key remains in its file.

Android produces `clave-release.apk`, signed with a local beta key under `/tmp/clave-mobile-d/keystore`. `MOBILE_ANDROID_KEY_DIR` selects a different local key directory. Team signing uses `MOBILE_ANDROID_KEYSTORE`, `MOBILE_ANDROID_KEY_ALIAS`, `MOBILE_ANDROID_STORE_PASSWORD_FILE` and `MOBILE_ANDROID_KEY_PASSWORD_FILE`. The signing files must have no group or other permissions. Passwords travel through files rather than command arguments. Store distribution needs the team's keystore.

These scripts have syntax checks only at this checkpoint. No native build artifact is claimed yet.

The native/provider acceptance driver needs a separately built **development** `.app` or debug APK, with the new native modules included. Release artifacts cannot connect to Metro or its source inspector. Start only the assigned simulator or emulator, then run `scripts/mobile-beta-native.mjs` with explicit `--worktree`, full `--candidate` SHA, unique `--marker`, `--metro-port`, `--server-port`, `--relay-port`, `--data`, `--scratch`, `--output`, `--app`, `--provider echo|codex` and either `--ios-udid` or `--android-serial`. The driver starts its own isolated server and Metro, launches from a saved profile on the phone, checks two responses and the same session through an attached hidden Electron app, and verifies the actually loaded source. Its developer connection flow explicitly does not prove relay discovery or native enrollment. Echo is always a fixture; Codex uses the Mac's existing login and verifies the reported model. No such native run has passed yet.

## Using the beta

On the Mac, sign in to Antasphere in Settings → Accounts and configure the team's relay origin in Settings → Mobile. The Mac server must stay running. The phone signs in as the same owner, lists the owner's machines through that relay, and requests pairing with the chosen machine. Approve the named phone in Settings → Mobile on the Mac. A refusal or expiry appears on the phone.

The app registers the raw APNs or FCM token after pairing, checks it again on startup and registers replacements reported by the operating system. A notification opens its conversation. An action that needs a form opens its specific request. A cold launch without an explicit link opens the last machine's Workspaces; a warm resume keeps its current screen. Reconnection refreshes requests and subscribed history, then reconciles sends whose outcomes were not confirmed. An ordinary offline draft is never sent automatically.

## Notification platform limit

Expo Notifications 58.1.7 documents background or terminated notification-action tasks only on Android. A killed iOS app cannot receive a response through that task, and a non-foreground action does not invoke its JavaScript listener. The native adapter therefore foregrounds iOS actions and resolves them in the app; simple Android actions use the registered headless task.

When an Android background action cannot settle, Clave saves its owner-scoped route and posts a local "Open Clave to answer" notification. Tap it to open the request. This needs one further tap, and does not automatically open the app. Android 12 and newer [forbid launching an activity through a notification service or receiver](https://developer.android.com/about/versions/12/behavior-changes-12#notification-trampolines), so this notification uses Expo's activity tap. Its displayed text is generic and carries no question, answer, secret or credential. The route stays in that owner's storage; the tap checks the current pairing and pending request before opening a form. A posting failure reaches the caller, and the saved link remains available on a cold resume. These paths have mocked-adapter checks but still need native verification. Real APNs/FCM delivery remains NOT RUN.
