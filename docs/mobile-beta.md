# Clave on the phone: the beta

No beta candidate of the native apps is claimed here. What exists in this tree is what
[mobile.md](mobile.md) describes: the two apps' sources, their checks on simulators and
emulators, and the fixture stack each app runs those checks against.

## What a beta needs from the team

These stay NOT RUN until the team provides them; nothing in this tree requests, creates or
changes a credential:

- **iPhone**: an Apple team that owns the Release build's bundle identifier, `com.clave.ios`
  (a Debug build is `com.clave.ios.dev`), that identifier with the push capability, an App
  Store provisioning profile and the team's distribution signing; for the server's pushes, an
  APNs signing key with its Key ID and the owning Team ID.
- **Android**: the team's release keystore; for the server's pushes, a Firebase project with
  the Android app and a service account.
- **Off-network access**: a deployed TLS relay and a real phone on another network. A local
  relay proves the protocol only.

No store publication, relay deployment or release is part of the native apps' delivery.

## Using the beta, from the Mac

On the Mac, sign in to Antasphere in Settings → Accounts and set the team's relay origin in
Settings → Mobile. The Mac's server must stay running. The phone signs in as the same owner,
lists the owner's machines through that relay and asks to pair with the chosen one. Approve
the named phone in Settings → Mobile on the Mac; a refusal or an expiry shows on the phone.
Revoking it there ends its access.

## The prototype's beta

The React Native beta's records (its saved iOS run, its reviews, its build scripts and their
provenance receipts) stay with the prototype on the branch
`mobile-react-native-baseline-20261109` and in the project OS's `2026-10-29-mobile-beta-flows`
bundle, on the clave-os branch `docs/clave-mobile-beta-wave`. They say nothing about the
native apps.
