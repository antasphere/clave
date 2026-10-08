import { create } from 'zustand'
import type {
  AntasphereAccountStatus,
  AntasphereLoginFailure
} from '../../../shared/antasphere-account-types'

/**
 * The Antasphere account as this window sees it (PRDCT-3259): the status
 * the server pushes, mirrored, and the four things a window can ask. Every
 * window shows the same login because the server is the one that holds it;
 * nothing here ever holds a token, a link or a server's words.
 *
 * Two orderings the store keeps, because a sign-in's answer waits on the
 * issuer (discovery, a registration, the page) and can land seconds later:
 *
 *  - an answer is applied only while it is the LATEST thing this window
 *    asked or heard. Every ask takes a sequence number and every push takes
 *    the next one; an answer whose number is behind is dropped, so a sign-in
 *    that answers after a cancel, a sign-out or a newer sign-in cannot put
 *    "signing in" back on screen over what came later;
 *  - what is in flight is kept per ask, not as one flag: a sign-in on its
 *    way does not disable Cancel, which is exactly what the user needs while
 *    the issuer is slow. A second ask of the same kind while one is in
 *    flight is not sent.
 *
 * A call that does not reach the server (the bridge is gone, main threw)
 * is a `transportFailed` the section shows with a Retry, never a silence:
 * the status keeps saying what was last heard, and the user is told the ask
 * did not land. The exception's own text is never kept.
 */
export type AntasphereAsk = 'get' | 'sign-in' | 'cancel' | 'sign-out' | 'dismiss'

interface AntasphereAccountState {
  status: AntasphereAccountStatus | null
  /** The first read answered, or failed: "Reading…" is over either way. */
  loaded: boolean
  /** The asks on their way to the server, each disabling its own button. */
  inFlight: Record<AntasphereAsk, boolean>
  /** The last ask never reached the server, or the server refused it. */
  transportFailed: boolean
  signIn: () => Promise<void>
  cancel: () => Promise<void>
  signOut: () => Promise<void>
  dismissFailure: () => Promise<void>
}

const NOTHING_IN_FLIGHT: Record<AntasphereAsk, boolean> = {
  get: false,
  'sign-in': false,
  cancel: false,
  'sign-out': false,
  dismiss: false
}

/** The order of what this window asked and heard; an answer behind it is stale. */
let seq = 0

function setInFlight(ask: AntasphereAsk, value: boolean): void {
  useAntasphereAccountStore.setState((s) => ({ inFlight: { ...s.inFlight, [ask]: value } }))
}

async function ask(
  kind: AntasphereAsk,
  call: () => Promise<AntasphereAccountStatus> | undefined
): Promise<void> {
  if (useAntasphereAccountStore.getState().inFlight[kind]) return
  const mine = ++seq
  setInFlight(kind, true)
  useAntasphereAccountStore.setState({ transportFailed: false })
  try {
    const status = await call()
    if (!status) throw new Error('no bridge')
    // Stale: a cancel, a sign-out, a newer ask or a push came after this
    // one was sent. What they said stands; this answer is dropped.
    if (mine === seq) useAntasphereAccountStore.setState({ status, loaded: true })
  } catch {
    if (mine === seq) useAntasphereAccountStore.setState({ transportFailed: true })
  } finally {
    setInFlight(kind, false)
  }
}

export const useAntasphereAccountStore = create<AntasphereAccountState>(() => ({
  status: null,
  loaded: false,
  inFlight: { ...NOTHING_IN_FLIGHT },
  transportFailed: false,
  signIn: () => ask('sign-in', () => window.electronAPI?.antasphereAccountSignIn?.()),
  cancel: () => ask('cancel', () => window.electronAPI?.antasphereAccountCancel?.()),
  signOut: () => ask('sign-out', () => window.electronAPI?.antasphereAccountSignOut?.()),
  dismissFailure: () => ask('dismiss', () => window.electronAPI?.antasphereAccountDismiss?.())
}))

let subscribed = false

/** Read the status from the server and follow every change from then on.
 *  The subscription is one per window and lives as long as the window. A
 *  read that fails is `loaded` and `transportFailed`: the section offers a
 *  retry rather than reading forever. A push is the newest truth: it takes
 *  the next sequence number, so an older ask's answer cannot overwrite it. */
export async function loadAntasphereAccount(): Promise<void> {
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onAntasphereAccountChanged?.((status) => {
      seq++
      useAntasphereAccountStore.setState({ status, loaded: true, transportFailed: false })
    })
  }
  await ask('get', () => window.electronAPI?.antasphereAccountGet?.())
  useAntasphereAccountStore.setState({ loaded: true })
}

/** For a test: forget the subscription so the next load subscribes again. */
export function resetAntasphereAccountStore(): void {
  subscribed = false
  seq = 0
  useAntasphereAccountStore.setState({
    status: null,
    loaded: false,
    inFlight: { ...NOTHING_IN_FLIGHT },
    transportFailed: false
  })
}

/** The words for a failure code. The server sends the code, never the hub's text. */
export function describeAntasphereFailure(failure: AntasphereLoginFailure): string {
  switch (failure) {
    case 'cancelled':
      return 'The sign-in was cancelled.'
    case 'timeout':
      return 'The sign-in timed out. Try again when you are ready.'
    case 'denied':
      return 'The sign-in was refused.'
    case 'network':
      return 'Clave could not reach Antasphere. Check your connection and try again.'
    case 'invalid-response':
      return 'The sign-in could not be verified. Try again.'
    case 'registration':
      return 'Antasphere did not accept this Clave for sign-in.'
    case 'storage':
      return 'Clave could not securely save or clear your sign-in on this device.'
    case 'configuration':
      return 'Sign-in is not available with the current configuration.'
    case 'expired':
      return 'Your sign-in expired. Sign in again to continue.'
  }
}
