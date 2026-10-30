# Clave mobile beta

The beta wiring is in progress on the provisional integration base. Sign-in, relay discovery, pairing, attachments and durable sends have native adapters and screens. Cold notification navigation, native acceptance, build artifacts and independent verification are still pending. This document does not claim an installable beta candidate.

The phone uses the system keyboard's dictation. It needs no separate transcription service.

## Native modules needed for phase two

The Expo SDK 58.0.21 bundled-module table names these versions. Lane D owns the mobile dependency changes and root lockfile under the coordinator handoff. The install added these exact pins without changing any previously locked package version.

| Module | SDK 58 baseline | Purpose |
| --- | --- | --- |
| expo-web-browser | 58.0.7 | System authentication session with PKCE |
| expo-crypto | 58.0.7 | PKCE randomness and SHA-256 |
| expo-notifications | 58.1.7 | Raw APNs or FCM device tokens, categories and responses |
| expo-device | 58.0.5 | Phone name and platform |
| expo-image-picker | 58.0.10 | Photos, screenshots and camera |
| expo-document-picker | 58.0.4 | Files |
| expo-file-system | 58.0.13 | Read picked files for upload |
| expo-task-manager | 58.0.12 | Android background notification actions |

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

For native source verification, set `CLAVE_MOBILE_PROOF_URL` to an isolated loopback receipt listener and `CLAVE_MOBILE_CANDIDATE` to a unique run marker when starting this worktree's Metro. The development-only module reports the actual React Native SourceCode script URL, the worktree and marker. A native driver must assert all three against its expected values and use an explicit device ID. Merely starting Metro on a requested port proves nothing. This mechanism has not yet been exercised on a native device.

## Notification platform limit

Expo Notifications 58.1.7 documents background or terminated notification-action tasks only on Android. A killed iOS app cannot receive a response through that task, and a non-foreground action does not invoke its JavaScript listener. The native adapter therefore foregrounds iOS actions and resolves them in the app; Android actions use the registered headless task. These paths still need native verification. Real APNs/FCM delivery remains NOT RUN.
