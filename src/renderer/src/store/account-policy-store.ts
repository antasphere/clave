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

/**
 * What automatic mode does when ONE MODEL FAMILY's cap is out while the
 * account's shared caps are open (PRDCT-4302): continue on another model of
 * the same account (`switch-model`, the default: the week is still there),
 * or leave for another account (`switch-account`). Set per workspace with a
 * global default under it; a tab pinned to its model falls to the account
 * rung whatever the setting says.
 */
export type FamilyLimitRule = 'switch-model' | 'switch-account'

const LAUNCH_KEY = 'useRecommendedAccount'
const GLOBAL_KEY = 'accountSwitchMode'
const BY_WORKSPACE_KEY = 'accountSwitchModeByWorkspace'
const FAMILY_KEY = 'onFamilyLimit'
const FAMILY_BY_WORKSPACE_KEY = 'onFamilyLimitByWorkspace'

interface AccountPolicyState {
  mode: AccountSwitchMode
  useRecommendedAccount: boolean
  setUseRecommendedAccount: (enabled: boolean) => void
  byWorkspace: Record<string, AccountSwitchMode>
  onFamilyLimit: FamilyLimitRule
  familyByWorkspace: Record<string, FamilyLimitRule>
  loaded: boolean
  setMode: (mode: AccountSwitchMode) => void
  /** null clears the workspace's own mode: it follows the global one. */
  setWorkspaceMode: (workspaceId: string, mode: AccountSwitchMode | null) => void
  setOnFamilyLimit: (rule: FamilyLimitRule) => void
  /** null clears the workspace's own rule: it follows the global one. */
  setWorkspaceOnFamilyLimit: (workspaceId: string, rule: FamilyLimitRule | null) => void
}

export function parseSwitchMode(raw: unknown): AccountSwitchMode | null {
  return raw === 'propose' || raw === 'automatic' ? raw : null
}

export function parseFamilyLimitRule(raw: unknown): FamilyLimitRule | null {
  return raw === 'switch-model' || raw === 'switch-account' ? raw : null
}

function parseByWorkspace<T>(raw: unknown, parse: (value: unknown) => T | null): Record<string, T> {
  const parsed: Record<string, T> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = parse(value)
      if (v) parsed[key] = v
    }
  }
  return parsed
}

export const useAccountPolicyStore = create<AccountPolicyState>((set, get) => ({
  mode: 'propose',
  useRecommendedAccount: false,
  setUseRecommendedAccount: (enabled) => {
    set({ useRecommendedAccount: enabled })
    window.electronAPI?.preferencesSet(LAUNCH_KEY, enabled).catch(() => {})
  },
  byWorkspace: {},
  onFamilyLimit: 'switch-model',
  familyByWorkspace: {},
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
  },

  setOnFamilyLimit: (rule) => {
    set({ onFamilyLimit: rule })
    window.electronAPI?.preferencesSet(FAMILY_KEY, rule).catch(() => {})
  },

  setWorkspaceOnFamilyLimit: (workspaceId, rule) => {
    const familyByWorkspace = { ...get().familyByWorkspace }
    if (rule) familyByWorkspace[workspaceId] = rule
    else delete familyByWorkspace[workspaceId]
    set({ familyByWorkspace })
    window.electronAPI?.preferencesSet(FAMILY_BY_WORKSPACE_KEY, familyByWorkspace).catch(() => {})
  }
}))

/** What a workspace does on a family's cap: its own rule, else the global one. */
export function workspaceFamilyLimitRule(workspaceId: string | null | undefined): FamilyLimitRule {
  const { onFamilyLimit, familyByWorkspace } = useAccountPolicyStore.getState()
  return (workspaceId && familyByWorkspace[workspaceId]) || onFamilyLimit
}

/** What a session does on a family's cap in automatic mode: its workspace's rule. */
export function effectiveFamilyLimitRule(session: Pick<Session, 'workspaceId'>): FamilyLimitRule {
  return workspaceFamilyLimitRule(session.workspaceId ?? getActiveWorkspaceId())
}

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
    const [mode, byWorkspace, useRecommendedAccount, onFamilyLimit, familyByWorkspace] =
      await Promise.all([
        window.electronAPI?.preferencesGet(GLOBAL_KEY),
        window.electronAPI?.preferencesGet(BY_WORKSPACE_KEY),
        window.electronAPI?.preferencesGet(LAUNCH_KEY),
        window.electronAPI?.preferencesGet(FAMILY_KEY),
        window.electronAPI?.preferencesGet(FAMILY_BY_WORKSPACE_KEY)
      ])
    useAccountPolicyStore.setState({
      useRecommendedAccount: useRecommendedAccount === true,
      mode: parseSwitchMode(mode) ?? 'propose',
      byWorkspace: parseByWorkspace(byWorkspace, parseSwitchMode),
      onFamilyLimit: parseFamilyLimitRule(onFamilyLimit) ?? 'switch-model',
      familyByWorkspace: parseByWorkspace(familyByWorkspace, parseFamilyLimitRule),
      loaded: true
    })
  } catch {
    useAccountPolicyStore.setState({ loaded: true })
  }
}

/** Keep already-open windows on the app-wide launch choice. */
export function subscribeAccountLaunchPolicy(): () => void {
  return (
    window.electronAPI?.onRecommendedAccountChanged?.((enabled) => {
      useAccountPolicyStore.setState({ useRecommendedAccount: enabled === true })
    }) ?? (() => {})
  )
}
