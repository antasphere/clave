# Clave mobile beta

This lane is in phase one. The pure clients run under Node; they are not yet connected to the native screens. This document records prerequisites, not a claim that a teammate can install the beta yet.

The phone uses the system keyboard's dictation. It needs no separate transcription service.

## Native modules needed for phase two

The Expo SDK 58.0.21 bundled-module table names these versions. Keep the root lockfile with lane C until the coordinator transfers ownership.

| Module | SDK 58 baseline | Purpose |
| --- | --- | --- |
| expo-web-browser | 58.0.7 | System authentication session with PKCE |
| expo-crypto | 58.0.7 | PKCE randomness and SHA-256 |
| expo-notifications | 58.1.7 | Raw APNs or FCM device tokens, categories and responses |
| expo-device | 58.0.5 | Phone name and platform |
| expo-image-picker | 58.0.10 | Photos, screenshots and camera |
| expo-document-picker | 58.0.4 | Files |
| expo-file-system | 58.0.13 | Read picked files for upload |

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
