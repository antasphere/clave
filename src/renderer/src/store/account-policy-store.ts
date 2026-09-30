import { create } from 'zustand'
import type { Session } from './session-types'
import { getActiveWorkspaceId } from './workspace-store'

/**
 * The switching policy's knobs (ADR 0002): what happens when a tab's account
 * is about to hit its limit.
 *
 *  - `propose` (the default): the tab shows the move and waits for the user.
 *  - `automatic`: the tab is moved once its agent is idle.
 *
 * Set per workspace, with a global default under it, and a session may carry
 * its own. A pinned session is never moved and never proposed a move; the
 * pin is the session's own (see `Session.accountPinned`).
 */
export type AccountSwitchMode = 'propose' | 'automatic'

const GLOBAL_KEY = 'accountSwitchMode'
const BY_WORKSPACE_KEY = 'accountSwitchModeByWorkspace'

interface AccountPolicyState {
  mode: AccountSwitchMode
  byWorkspace: Record<string, AccountSwitchMode>
  loaded: boolean
  setMode: (mode: AccountSwitchMode) => void
  /** null clears the workspace's own mode: it follows the global one. */
  setWorkspaceMode: (workspaceId: string, mode: AccountSwitchMode | null) => void
}

export function parseSwitchMode(raw: unknown): AccountSwitchMode | null {
  return raw === 'propose' || raw === 'automatic' ? raw : null
}

export const useAccountPolicyStore = create<AccountPolicyState>((set, get) => ({
  mode: 'propose',
  byWorkspace: {},
  loaded: false,

  setMode: (mode) => {
    set({ mode })
    window.electronAPI?.preferencesSet(GLOBAL_KEY, mode).catch(() => {})
  },

  setWorkspaceMode: (workspaceId, mode) => {
    const byWorkspace = { ...get().byWorkspace }
    if (mode) byWorkspace[workspaceId] = mode
    else delete byWorkspace[workspaceId]
    set({ byWorkspace })
    window.electronAPI?.preferencesSet(BY_WORKSPACE_KEY, byWorkspace).catch(() => {})
  }
}))

/** The mode a workspace runs under: its own, else the global one. */
export function workspaceSwitchMode(workspaceId: string | null | undefined): AccountSwitchMode {
  const { mode, byWorkspace } = useAccountPolicyStore.getState()
  return (workspaceId && byWorkspace[workspaceId]) || mode
}

/** The mode a session runs under: its own, else its workspace's. */
export function effectiveSwitchMode(
  session: Pick<Session, 'accountSwitchMode' | 'workspaceId'>
): AccountSwitchMode {
  return (
    session.accountSwitchMode ?? workspaceSwitchMode(session.workspaceId ?? getActiveWorkspaceId())
  )
}

export async function loadAccountPolicy(): Promise<void> {
  try {
    const [mode, byWorkspace] = await Promise.all([
      window.electronAPI?.preferencesGet(GLOBAL_KEY),
      window.electronAPI?.preferencesGet(BY_WORKSPACE_KEY)
    ])
    const parsed: Record<string, AccountSwitchMode> = {}
    if (byWorkspace && typeof byWorkspace === 'object') {
      for (const [key, value] of Object.entries(byWorkspace as Record<string, unknown>)) {
        const m = parseSwitchMode(value)
        if (m) parsed[key] = m
      }
    }
    useAccountPolicyStore.setState({
      mode: parseSwitchMode(mode) ?? 'propose',
      byWorkspace: parsed,
      loaded: true
    })
  } catch {
    useAccountPolicyStore.setState({ loaded: true })
  }
}
