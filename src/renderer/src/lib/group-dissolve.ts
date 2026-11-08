import { create } from 'zustand'
import { useSessionStore } from '../store/session-store'
import { emitTabClosed } from './exchange-capture'
import { isRemoteKey } from './fleet-identity'
import { reportFleetError } from '../store/fleet-store'
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

/** Kill what dissolving the group kills, then dissolve it in the store. */
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
  const closed = await Promise.all(
    toKill.map(async (sid) => {
      const session = current.sessions.find((s) => s.id === sid)
      if (session) emitTabClosed(session, current.groups, 'user', null)
      try {
        await window.electronAPI.killSession(sid)
      } catch {
        if (isRemoteKey(sid)) {
          reportFleetError(new Error('close failed'))
          return false
        }
        // session may already be dead
      }
      return true
    })
  )
  if (closed.includes(false)) return
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
