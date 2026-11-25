import { create } from 'zustand'
import {
  EMPTY_HISTORY,
  isEmptyPlace,
  moveTo,
  recordPlace,
  replaceAt,
  samePlace,
  stepTarget,
  type NavigationHistory,
  type Place
} from '../lib/navigation-history'
import { applyPlace, focusPlace, placeAlive, placeLabel, readPlace } from '../lib/navigation-place'
import { usePluginUIStore } from '../components/plugins/plugin-ui-store'
import { useSessionStore } from './session-store'
import { useWorkspaceStore } from './workspace-store'
import { useArtefactStore } from './artefact-store'
import { useLinkedDocumentStore } from './linked-document-store'

/**
 * Back and Forward (PRDCT-5155): this window's history of the places its
 * content area showed, and the moves through it. The recorder watches the
 * stores a place is read from (`readPlace`) and records the place once it
 * has settled, whoever moved: a click, a key, an agent opening a tab or an
 * artefact. A restore is never recorded as a move of its own: the entry it
 * went to is rewritten with what actually showed.
 */

/** How long a place stays on screen before it counts: one click that sets several fields
 *  records one place, not one per field. */
export const SETTLE_MS = 300

interface NavigationState {
  history: NavigationHistory
  back: () => Promise<void>
  forward: () => Promise<void>
  /** Show the place at `index` of the history. */
  go: (index: number) => Promise<void>
}

/** A restore is running: the stores move under it, and nothing is recorded. */
let restoring = false
let timer: ReturnType<typeof setTimeout> | null = null
/** The place the recorder read last. A change of the stores that leaves it as it was (a
 *  tab's state, a new document of another tab) neither schedules nor delays anything. */
let seen: Place | null = null

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function commit(): void {
  timer = null
  const place = readPlace()
  seen = place
  const { history } = useNavigationStore.getState()
  const next = recordPlace(history, place)
  if (next !== history) useNavigationStore.setState({ history: next })
}

/** Record now the place waiting to settle, if one is. */
function flush(): void {
  if (timer === null) return
  clearTimer()
  commit()
}

/** Record now the place waiting to settle, if one is: what a list of places is drawn from
 *  must already hold the place on screen. */
export function recordPendingPlace(): void {
  if (!restoring) flush()
}

/** One of the watched stores changed: when the place on screen is another one, record it
 *  once it has stayed `SETTLE_MS` (each further change of the place starts the wait over). */
function changed(): void {
  if (restoring) return
  const place = readPlace()
  if (seen !== null && samePlace(place, seen)) return
  seen = place
  clearTimer()
  timer = setTimeout(commit, SETTLE_MS)
}

async function go(index: number): Promise<void> {
  if (restoring) return
  const target = useNavigationStore.getState().history.entries[index]
  // A place that no longer exists is never gone to (its row may outlive it by a moment).
  if (!target || !placeAlive(target)) return
  // The place on screen is recorded before it is left. Recording it may drop the places
  // ahead or shift the oldest out, so the target is found again by identity.
  flush()
  const history = useNavigationStore.getState().history
  const at = history.entries.indexOf(target)
  if (at < 0 || at === history.index) return
  const from = history.index
  restoring = true
  try {
    useNavigationStore.setState({ history: moveTo(history, at) })
    let applied: boolean
    try {
      applied = await applyPlace(target)
    } catch (error) {
      // Part of it may be on screen: what shows is recorded below, as for any restore.
      console.error('[navigation] the place could not be shown again:', error)
      applied = true
    }
    const now = useNavigationStore.getState().history
    if (!applied) {
      // The workspace could not be switched to: nothing moved, nor does the history.
      useNavigationStore.setState({ history: moveTo(now, from) })
      return
    }
    // What actually showed: a closed tab left out, a stopped plugin's page left out.
    const shown = readPlace()
    seen = shown
    if (!isEmptyPlace(shown)) useNavigationStore.setState({ history: replaceAt(now, at, shown) })
    // Typing goes to the tab shown, as after a click on its row, not to the button that moved.
    focusPlace(shown)
  } finally {
    clearTimer()
    restoring = false
  }
}

async function step(delta: -1 | 1): Promise<void> {
  if (restoring) return
  flush()
  const index = stepTarget(useNavigationStore.getState().history, delta, placeAlive)
  if (index !== null) await go(index)
}

export const useNavigationStore = create<NavigationState>(() => ({
  history: EMPTY_HISTORY,
  back: () => step(-1),
  forward: () => step(1),
  go
}))

/** Start recording this window's places; returns the stop. Once, from the app shell. */
export function initNavigationHistory(): () => void {
  const stops = [
    useSessionStore.subscribe((state, prev) => {
      if (
        state.activeView !== prev.activeView ||
        state.settingsSection !== prev.settingsSection ||
        state.extensionsSection !== prev.extensionsSection ||
        state.selectedSessionIds !== prev.selectedSessionIds ||
        state.focusedSessionId !== prev.focusedSessionId ||
        state.activeGroupViewId !== prev.activeGroupViewId ||
        state.activeSessionViewId !== prev.activeSessionViewId ||
        state.sessions !== prev.sessions ||
        state.groups !== prev.groups
      ) {
        changed()
      }
    }),
    usePluginUIStore.subscribe((state, prev) => {
      if (
        state.page !== prev.page ||
        state.mainPanel !== prev.mainPanel ||
        state.records !== prev.records
      ) {
        changed()
      }
    }),
    useWorkspaceStore.subscribe((state, prev) => {
      if (state.activeWorkspaceId !== prev.activeWorkspaceId) changed()
    }),
    useArtefactStore.subscribe((state, prev) => {
      if (state.artefacts !== prev.artefacts || state.hidden !== prev.hidden) changed()
    }),
    useLinkedDocumentStore.subscribe((state, prev) => {
      if (state.documents !== prev.documents) changed()
    })
  ]
  // What already shows (a window reloaded on a tab) is the first place once it settles.
  changed()
  return () => {
    for (const stop of stops) stop()
    clearTimer()
  }
}

// ── E2E seam ──

interface NavigationSnapshot {
  index: number
  places: Array<{
    label: string
    kind: string
    workspaceId: string | null
    view: string
    tabs: string[]
    focused: string | null
    groupView: string | null
    tabView: string | null
    /** `page:<pluginId>/<actionId>` or `panel:<pluginId>/<panelId>` */
    plugin: string | null
    /** `artefact:<target>` or `document:<id>` per session tab */
    beside: Record<string, string | null> | null
  }>
}

declare global {
  interface Window {
    /**
     * E2E seam (PRDCT-5155): the history as plain data, and the moves through it, so a spec
     * reads which places were recorded and walks them without aiming at the buttons. Gated
     * on the test flag, so this handle does not exist in a user's app.
     */
    __claveNavigationForTests?: {
      snapshot: () => NavigationSnapshot
      back: () => Promise<void>
      forward: () => Promise<void>
      go: (index: number) => Promise<void>
    }
  }
}

function snapshot(): NavigationSnapshot {
  const { history } = useNavigationStore.getState()
  return {
    index: history.index,
    places: history.entries.map((p) => {
      const { label, kind } = placeLabel(p)
      return {
        label,
        kind,
        workspaceId: p.workspaceId,
        view: p.view,
        tabs: [...p.tabs],
        focused: p.focused,
        groupView: p.groupView,
        tabView: p.tabView,
        plugin:
          p.plugin === null
            ? null
            : p.plugin.kind === 'page'
              ? `page:${p.plugin.page.pluginId}/${p.plugin.page.actionId}`
              : `panel:${p.plugin.pluginId}/${p.plugin.panelId}`,
        beside:
          p.beside === null
            ? null
            : Object.fromEntries(
                Object.entries(p.beside).map(([id, card]) => [
                  id,
                  card === null ? null : `${card.kind}:${card.id}`
                ])
              )
      }
    })
  }
}

if (typeof window !== 'undefined' && window.__claveTestMode) {
  window.__claveNavigationForTests = {
    snapshot,
    back: () => useNavigationStore.getState().back(),
    forward: () => useNavigationStore.getState().forward(),
    go: (index) => useNavigationStore.getState().go(index)
  }
}
