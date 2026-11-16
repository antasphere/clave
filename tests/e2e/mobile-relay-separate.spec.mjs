// The relay client (issue #407) with the app on a SEPARATE server, the
// packaged default on macOS: the app starts the standalone entry as its
// child and attaches to it, and that child owns the login, the preferences
// Settings → Mobile writes through it, `relay.json` and the relay client.
// The same steps as `mobile-relay.spec.mjs`, read from the child's data
// directory, with a keychain file of the run's own.
import { runMobileRelay } from './mobile-relay.spec.mjs'

export const run = (t) => runMobileRelay(t, 'separate')
