import { create } from 'zustand'
import type { DeviceView, PendingPairingView } from '../../../shared/mobile-types'

/**
 * Settings → Mobile as this window sees it (mobile wave, lane A): the phones
 * paired with this Mac's server, the phones asking to pair, the relay
 * address, and what the owner can ask of them. The server holds all of it;
 * the views it answers carry no session token and no push token, so nothing
 * here ever holds one.
 *
 * The orderings the store keeps, after the Antasphere account's store:
 *
 *  - a list answer is applied only when its revision is at least the last
 *    one applied. The server bumps the revision on every change and says so
 *    (`onDevicesChanged`), so an answer that lands behind a newer one is
 *    dropped. A list is sent at every signal even while another is out: the
 *    signal may be newer than what that list read, and the revision, not the
 *    order of arrival, decides which answer stands. Only the latest list's
 *    failure is shown; a newer list speaks for the page;
 *  - the relay address takes a sequence number per read or save, and an
 *    answer behind it is dropped, so a read sent before a save cannot put
 *    the old address back. No read is sent while a save is out: the save
 *    answers the newest address itself;
 *  - what is in flight is kept per ask (`approve:<id>`, `revoke:<id>`, …), so
 *    approving one phone leaves every other button live, and a second ask of
 *    the same key while one is out is not sent.
 *
 * A call that fails is `transportFailed` with the sentence its rejection
 * carries (`failureText`), never its stack. A failed read (the server not up
 * yet) is lifted by the next refresh that lands in full, the one the change
 * signal triggers at the server's welcome included; a failed ask stays until
 * the owner asks again. A relay address the server refuses is `relayError`,
 * shown under the relay card, and moves nothing else on the page.
 */
interface MobileState {
  /** The revision of the last list applied; an answer behind it is stale. */
  revision: number
  devices: DeviceView[]
  pending: PendingPairingView[]
  /** The relay address the server holds; empty when there is none. */
  relayUrl: string
  /** The first load answered, or failed. */
  loaded: boolean
  /** The last call did not complete; `failureText` says why when it can. */
  transportFailed: boolean
  failureText: string | null
  /** Why the server refused the last relay address saved, for the relay card alone. */
  relayError: string | null
  /** The asks on their way: `list`, `relay` (a save), `approve:<id>`, `refuse:<id>`, `revoke:<id>`. */
  inFlight: Record<string, boolean>
  approve: (pairingId: string) => Promise<void>
  refuse: (pairingId: string) => Promise<void>
  revoke: (deviceId: string) => Promise<void>
  saveRelay: (url: string) => Promise<void>
}

type MobileData = Omit<MobileState, 'approve' | 'refuse' | 'revoke' | 'saveRelay'>

const initial = (): MobileData => ({
  revision: 0,
  devices: [],
  pending: [],
  relayUrl: '',
  loaded: false,
  transportFailed: false,
  failureText: null,
  relayError: null,
  inFlight: { list: false, relay: false }
})

/** Shown when a refused save carries no sentence of its own. */
const RELAY_NOT_SAVED = 'Clave could not save the relay address. Try again.'

let subscribed = false
/** The lists sent so far, and how many of them are still out. */
let listSeq = 0
let listsOut = 0
/** The relay reads and saves sent so far: an answer behind the latest is stale. */
let relaySeq = 0
/** The failure on the page is a read's, lifted by the next refresh that lands. */
let readFailed = false

function setInFlight(key: string, value: boolean): void {
  useMobileStore.setState((s) => ({ inFlight: { ...s.inFlight, [key]: value } }))
}

/** The sentence a rejection carries, never its stack; null when it has none. */
function sentenceOf(error: unknown): string | null {
  const message =
    typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

/** One call across the bridge. A bridge without the method is a failure with no sentence. */
async function reach<T>(call: () => Promise<T> | undefined): Promise<T> {
  const answer = call()
  if (!answer) throw new Error()
  return await answer
}

function fail(error: unknown, read: boolean): void {
  readFailed = read
  useMobileStore.setState({ transportFailed: true, failureText: sentenceOf(error) })
}

function clearFailure(): void {
  readFailed = false
  useMobileStore.setState({ transportFailed: false, failureText: null })
}

/** Read the list; true when it landed, applied or stale. */
async function list(): Promise<boolean> {
  const mine = ++listSeq
  listsOut += 1
  setInFlight('list', true)
  try {
    const view = await reach(() => window.electronAPI?.devicesList?.())
    if (view.revision >= useMobileStore.getState().revision)
      useMobileStore.setState({
        revision: view.revision,
        devices: [...view.devices],
        pending: [...view.pending],
        loaded: true
      })
    return true
  } catch (error) {
    if (mine === listSeq) fail(error, true)
    return false
  } finally {
    listsOut -= 1
    if (listsOut === 0) setInFlight('list', false)
  }
}

/** Read the relay address; true when it landed, or when a save on its way answers it. */
async function readRelay(): Promise<boolean> {
  if (useMobileStore.getState().inFlight.relay) return true
  const mine = ++relaySeq
  try {
    const url = await reach(() => window.electronAPI?.mobileRelayGet?.())
    if (mine === relaySeq) useMobileStore.setState({ relayUrl: url })
    return true
  } catch (error) {
    if (mine === relaySeq) fail(error, true)
    return false
  }
}

/** The page's two reads. Landing in full, they lift the failure a read left. */
async function refresh(): Promise<void> {
  const [listed, read] = await Promise.all([list(), readRelay()])
  if (listed && read && readFailed) clearFailure()
}

/** An ask about one phone, then the list again whatever the answer: a request
 *  that lapsed, or a phone revoked elsewhere, leaves the rows beside the
 *  failure that named it. The key stays in flight until the list lands, so
 *  the row's button cannot ask twice for a phone already answered. */
async function act(key: string, call: () => Promise<unknown> | undefined): Promise<void> {
  if (useMobileStore.getState().inFlight[key]) return
  setInFlight(key, true)
  clearFailure()
  try {
    await reach(call)
  } catch (error) {
    fail(error, false)
  }
  await list()
  setInFlight(key, false)
}

/** Save the relay address. The server answers the address it stored, normalised;
 *  any rejection is the relay card's, and only a save that landed lists again. */
async function storeRelay(url: string): Promise<void> {
  if (useMobileStore.getState().inFlight.relay) return
  const mine = ++relaySeq
  setInFlight('relay', true)
  useMobileStore.setState({ relayError: null })
  let saved = false
  try {
    const stored = await reach(() => window.electronAPI?.mobileRelaySet?.(url))
    if (mine === relaySeq) useMobileStore.setState({ relayUrl: stored })
    saved = true
  } catch (error) {
    if (mine === relaySeq)
      useMobileStore.setState({ relayError: sentenceOf(error) ?? RELAY_NOT_SAVED })
  }
  setInFlight('relay', false)
  if (saved) await list()
}

export const useMobileStore = create<MobileState>(() => ({
  ...initial(),
  approve: (pairingId) =>
    act(`approve:${pairingId}`, () => window.electronAPI?.devicesApprove?.(pairingId)),
  refuse: (pairingId) =>
    act(`refuse:${pairingId}`, () => window.electronAPI?.devicesRefuse?.(pairingId)),
  revoke: (deviceId) =>
    act(`revoke:${deviceId}`, () => window.electronAPI?.devicesRevoke?.(deviceId)),
  saveRelay: (url) => storeRelay(url)
}))

/** Read the page from the server and follow every change from then on. The
 *  subscription is one per window and lives as long as the window; each
 *  signal reads the list and the relay address again. A load starts clean:
 *  the failures of the last visit, and the last refusal, are dropped. */
export async function loadMobile(): Promise<void> {
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onDevicesChanged?.(() => void refresh())
  }
  clearFailure()
  useMobileStore.setState({ relayError: null })
  await refresh()
  useMobileStore.setState({ loaded: true })
}

/** For a test: forget the subscription and every order kept, so the next load starts fresh. */
export function resetMobileStore(): void {
  subscribed = false
  listSeq = 0
  listsOut = 0
  relaySeq = 0
  readFailed = false
  useMobileStore.setState(initial())
}
