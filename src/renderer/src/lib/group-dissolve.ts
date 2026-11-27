import { create } from 'zustand'
import { getDisplayOrder, useSessionStore } from '../store/session-store'
import { closeTab } from './close-tab'
import { groupPlaceOf } from './tab-place'
import { useOngoingStore } from '../store/ongoing-store'
import { ongoingSessionIds } from './ongoing'

/**
 * A group goes away two ways — Delete (its tabs die with it) and Ungroup
 * (its tabs become top-level) — and both used to leave its quick-launch
 * terminals behind: the store forgot them, nothing called killSession, and
 * the `npm run dev` kept running with no UI handle until the next boot
 * brought it back as a mystery tab (PRDCT-2038). A terminal belongs to its
 * group: when the group dissolves, either way, its terminals stop.
 *
 * The rules are pure (what to kill, whether to ask first) so vitest pins
 * them; `performGroupDissolve` is the one impure step both entry points
 * (the sidebar's context menu, the ungroup keybinding) share, and
 * `requestGroupDissolve` is what they call: it asks first when a running
 * terminal would be stopped, and otherwise just does it.
 */

import {
  dissolveConfirmation,
  sessionsToKillOnDissolve,
  type DissolveConfirmation,
  type DissolveMode
} from './group-dissolve-rules'

export {
  dissolveConfirmation,
  runningTerminalSessions,
  sessionsToKillOnDissolve,
  type DissolveConfirmation,
  type DissolveMode
} from './group-dissolve-rules'

/** Close what dissolving the group closes, and dissolve it in the store at
 *  once: the rows leave with the group, the stops run behind (PRDCT-5315). A
 *  server tab whose stop fails comes back with the mark that says why, and
 *  the group comes back around it, in its place. */
export async function performGroupDissolve(groupId: string, mode: DissolveMode): Promise<void> {
  const current = useSessionStore.getState()
  const group = current.groups.find((g) => g.id === groupId)
  if (!group) return
  // An ongoing conversation (PRDCT-4190) only sits hidden in the group: a
  // Delete never closes it. It leaves the group first, to the top level,
  // where it stays hidden and ongoing.
  const ongoing = ongoingSessionIds(useOngoingStore.getState().entries, current.sessions)
  const kept = group.sessionIds.filter((sid) => ongoing.has(sid))
  const toKill = sessionsToKillOnDissolve(group, mode).filter((sid) => !ongoing.has(sid))
  if (mode === 'delete' && kept.length > 0)
    useSessionStore.getState().moveItems(kept, null, 'after')
  const place = groupPlaceOf(
    { sessions: current.sessions, groups: current.groups, displayOrder: getDisplayOrder(current) },
    groupId
  )
  // A group whose server refused to close a tab of it stays, holding that
  // tab: put back the moment each refusal lands.
  const closing = toKill.map((sid) =>
    closeTab(sid).then((outcome) => {
      if (!outcome.closed && place)
        useSessionStore.getState().restoreClosedGroup(place, new Set([sid]))
    })
  )
  const store = useSessionStore.getState()
  if (mode === 'delete') store.deleteGroup(groupId)
  else store.ungroupSessions(groupId)
  // The store falls back to the last tab when the selection empties: never
  // to an ongoing conversation the sidebar does not show.
  const after = useSessionStore.getState()
  if (after.selectedSessionIds.some((sid) => ongoing.has(sid))) {
    const selected = after.selectedSessionIds.filter((sid) => !ongoing.has(sid))
    useSessionStore.setState({
      selectedSessionIds: selected,
      focusedSessionId: selected.includes(after.focusedSessionId ?? '')
        ? after.focusedSessionId
        : (selected[0] ?? null)
    })
  }
  await Promise.all(closing)
}

interface DissolveState {
  /** A dissolve waiting on the user's answer; the sidebar renders the dialog. */
  pending: { groupId: string; mode: DissolveMode; confirmation: DissolveConfirmation } | null
  confirm: () => Promise<void>
  cancel: () => void
}

export const useDissolveStore = create<DissolveState>((set, get) => ({
  pending: null,
  confirm: async () => {
    const p = get().pending
    set({ pending: null })
    if (p) await performGroupDissolve(p.groupId, p.mode)
  },
  cancel: () => set({ pending: null })
}))

/** Dissolve the group now, or ask first when a running terminal would stop. */
export async function requestGroupDissolve(groupId: string, mode: DissolveMode): Promise<void> {
  const state = useSessionStore.getState()
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) return
  const confirmation = dissolveConfirmation(group, state.sessions, mode)
  if (confirmation) {
    useDissolveStore.setState({ pending: { groupId, mode, confirmation } })
    return
  }
  await performGroupDissolve(groupId, mode)
}
