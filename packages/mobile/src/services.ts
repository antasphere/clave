/**
 * The platform behind the store: AsyncStorage for the drafts and the
 * navigation state, expo-secure-store for the credentials, the platform's
 * fetch and WebSocket (the defaults of the clients). The developer source
 * exists in a development build only: its module is required under
 * `__DEV__`, so a release bundle carries neither it nor the screen
 * (`scripts/check-release-bundle.mjs` proves that on the exported bundle).
 */
import { Platform } from 'react-native'
import { Drafts } from './chat/drafts'
import type { HubSignIn } from './auth/sign-in'
import { nativeOwnerStores } from './platform/account'
import { BetaServices } from './platform/beta'
import type { DeveloperMachineSource } from './machines/developer'
import type { Services } from './state/store'
import type { BuildKind } from './machines/transport-policy'

export function createServices(
  auth: HubSignIn,
  owner: Awaited<ReturnType<typeof nativeOwnerStores>>
): Services {
  const { kv, credentials } = owner
  /* eslint-disable @typescript-eslint/no-require-imports -- a static import would put the module in every build */
  const developer: DeveloperMachineSource | null = __DEV__
    ? new (
        require('./machines/developer') as typeof import('./machines/developer')
      ).DeveloperMachineSource(kv, credentials)
    : null
  /* eslint-enable @typescript-eslint/no-require-imports */
  const build: BuildKind = __DEV__ ? 'development' : 'release'
  const drafts = new Drafts(kv)
  const beta = new BetaServices(auth, kv, credentials, drafts, build, owner.assertCurrentAccount)
  return {
    beta,
    delivery: beta.delivery,
    build,
    credentials,
    sources: { relay: beta.source, developer },
    kv,
    drafts,
    clientOptions: { build },
    pushOptions: { build },
    clientName: `clave-mobile/${Platform.OS}`
  }
}
