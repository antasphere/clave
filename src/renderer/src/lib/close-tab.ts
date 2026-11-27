/**
 * Closing a tab (PRDCT-5315): the one road every close takes, the sidebar's,
 * the tab header's, the keyboard's, a group's, an agent's tool, Ongoing's end,
 * a session view's. The row leaves the sidebar the moment the close is asked,
 * and the stop runs behind it: a Claude chat's process takes about a second
 * to exit, and the row used to wait for it.
 *
 * A tab of a connected Clave server whose stop fails comes back where it sat,
 * its unsent prompt with it, and a mark before its title says why
 * (`store/close-errors-store.ts`). A tab of this Mac whose stop throws has
 * already exited, as it always was read here, and stays closed.
 */
import { useSessionStore, getDisplayOrder } from '../store/session-store'
import type { Session } from '../store/session-types'
import { emitTabClosed } from './exchange-capture'
import { isRemoteKey, ownerOf } from './fleet-identity'
import { holdClosingTab, releaseClosingTab, useFleetStore } from '../store/fleet-store'
import { clearCloseError, setCloseError } from '../store/close-errors-store'
import {
  flushLinkedDocument,
  hasLinkedFlusher,
  linkedEditorBlocksClose
} from '../store/linked-document-store'
import { setSessionDraft, useDraftStore } from '../views/draft-store'
import { tabPlaceOf } from './tab-place'

export interface CloseTabOptions {
  /** Who asked: the person, an agent's tool, or the app itself. */
  by?: 'user' | 'agent' | 'app'
  /** The tab whose agent asked, for an agent's close. */
  closer?: Session | null
}

export type CloseTabOutcome = { closed: true } | { closed: false; reason: string }

/** The longest sentence a mark carries: a server's answer can be long. */
const REASON_MAX = 240

/** The sentence on the mark of a tab whose stop failed: the failure's own
 *  words, on one line, after the server's name. */
export function closeFailureReason(error: unknown, serverName: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const words = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const said = words || 'the server did not answer'
  const clipped = said.length > REASON_MAX ? `${said.slice(0, REASON_MAX - 1)}…` : said
  return `${serverName} could not close this tab: ${clipped}`
}

function serverNameOf(id: string): string {
  const owner = ownerOf(id)
  return useFleetStore.getState().connections.find((c) => c.id === owner)?.name ?? 'Its server'
}

/** The closes under way, one per tab: a second close of a tab whose first is
 *  still running joins it rather than starting a stop of its own. */
const closing = new Map<string, Promise<CloseTabOutcome>>()

export function closeTab(id: string, options: CloseTabOptions = {}): Promise<CloseTabOutcome> {
  const running = closing.get(id)
  if (running) return running
  // Started now, so the row leaves in the caller's own task when nothing has
  // to be saved first (a group's Delete counts on it).
  const close = closeTabNow(id, options).finally(() => closing.delete(id))
  closing.set(id, close)
  return close
}

/** The tab's session view's serving process, stopped once the tab's own
 *  close went through: a close that fails keeps its page served. */
function stopServing(servingId: string | null): void {
  if (!servingId) return
  window.electronAPI.killSession(servingId).catch(() => {})
  useSessionStore.getState().removeSession(servingId)
}

async function closeTabNow(id: string, options: CloseTabOptions): Promise<CloseTabOutcome> {
  const remote = isRemoteKey(id)
  const state = useSessionStore.getState()
  const session = state.sessions.find((s) => s.id === id)
  if (session) emitTabClosed(session, state.groups, options.by ?? 'user', options.closer ?? null)

  // A tab the store does not hold, or whose linked document refuses to close:
  // the stop first, then the store, as every close used to run.
  if (!session || linkedEditorBlocksClose(id)) {
    try {
      await window.electronAPI.killSession(id)
    } catch (error) {
      if (remote) return { closed: false, reason: closeFailureReason(error, serverNameOf(id)) }
      // already exited
    }
    useSessionStore.getState().removeSession(id)
    return { closed: true }
  }

  // Where it sits, read first: a group's Delete takes the group away right
  // after it asked for its tabs' closes (lib/group-dissolve.ts).
  const place = tabPlaceOf(
    { sessions: state.sessions, groups: state.groups, displayOrder: getDisplayOrder(state) },
    id
  )
  const draft = useDraftStore.getState().drafts[id]
  const servingId = session.view?.serverSessionId ?? null
  // The linked document's last edits are saved while its panel is still
  // mounted: the stop asks the window for them, and the row is gone by then.
  // Without one, nothing is awaited before the row goes, so the row leaves in
  // the same task as the click.
  if (hasLinkedFlusher(id))
    await flushLinkedDocument(id, true).catch((error) =>
      console.error('[close] linked document not flushed before the close', error)
    )
  if (remote) holdClosingTab(id)
  clearCloseError(id)
  useSessionStore.getState().removeSession(id, { keepServing: true })
  try {
    await window.electronAPI.killSession(id)
    stopServing(servingId)
    return { closed: true }
  } catch (error) {
    if (!remote || !place) {
      stopServing(servingId)
      return { closed: true }
    }
    const reason = closeFailureReason(error, serverNameOf(id))
    releaseClosingTab(id)
    useSessionStore.getState().restoreClosedTab(place)
    if (draft) setSessionDraft(id, draft)
    setCloseError(id, reason)
    return { closed: false, reason }
  } finally {
    if (remote) releaseClosingTab(id)
  }
}
