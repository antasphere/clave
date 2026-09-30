import { create } from 'zustand'
import type { ClaudeAccount, UsageError, UsageLimits } from '../../../preload/index.d'

/**
 * A Claude account: a label plus the token a session on it runs with.
 *
 * The list is the main process's (`src/main/claude-accounts.ts`), mirrored
 * here: every window sees the same accounts, and a token captured in one
 * window is known to the spawn path of every other. The renderer never holds
 * a token, only `hasToken` and the dates around it.
 *
 * Two kinds of account share the shape (ADR 0002):
 *  - a `claude setup-token` token (`hasToken`), captured by the login flow or
 *    pasted, injected into the session as `CLAUDE_CODE_OAUTH_TOKEN`;
 *    settings, plugins and history stay the shared `~/.claude`;
 *  - the built-in Default, a passthrough to whatever the machine is signed
 *    into: no token, nothing injected.
 *
 * The type keeps its historical name (`ClaudeProfile`) because the launcher,
 * the spawn path and the session record already speak it; the user-facing
 * word is "account".
 */
export type ClaudeProfile = ClaudeAccount

export const DEFAULT_CLAUDE_PROFILE_ID = 'default'

const DEFAULT_PROFILE: ClaudeProfile = {
  id: DEFAULT_CLAUDE_PROFILE_ID,
  label: 'Default',
  hasToken: false,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
}

interface ClaudeProfileState {
  profiles: ClaudeProfile[]
  /** The profile used for keybinding-launched sessions and as the picker's
   *  remembered last choice. */
  selectedProfileId: string
  /** Accounts whose config-dir shape was retired at this boot: they keep
   *  their label and need a login (ADR 0002). */
  migratedIds: string[]
  loaded: boolean
  /** A bare account, to be logged into. */
  addProfile: (label: string) => Promise<ClaudeProfile | null>
  /** A token account: created, then the token stored and proven by a usage
   *  read in one call; the read is what the form shows. */
  addTokenProfile: (
    label: string,
    token: string
  ) => Promise<{ profile: ClaudeProfile; usage: UsageLimits | UsageError }>
  updateProfile: (id: string, updates: Partial<Pick<ClaudeProfile, 'label'>>) => void
  removeProfile: (id: string) => void
  /** The pool's order (ADR 0002): every non-default id, in order. */
  reorderProfiles: (ids: string[]) => void
  setSelectedProfile: (id: string) => void
  setToken: (id: string, token: string) => Promise<UsageLimits | UsageError>
  clearToken: (id: string) => Promise<void>
}

function persistSelected(selectedProfileId: string): void {
  window.electronAPI?.preferencesSet('selectedClaudeProfileId', selectedProfileId).catch(() => {})
}

/** The list as main sent it, the Default guaranteed first. */
function withDefault(list: ClaudeProfile[]): ClaudeProfile[] {
  const custom = list.filter((p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID)
  const fromMain = list.find((p) => p.id === DEFAULT_CLAUDE_PROFILE_ID)
  return [fromMain ?? DEFAULT_PROFILE, ...custom]
}

export const useClaudeProfileStore = create<ClaudeProfileState>((set, get) => ({
  profiles: [DEFAULT_PROFILE],
  selectedProfileId: DEFAULT_CLAUDE_PROFILE_ID,
  migratedIds: [],
  loaded: false,

  addProfile: async (label) => {
    const created = await window.electronAPI?.claudeAccountAdd({ label })
    if (!created) return null
    applyList([...get().profiles, created])
    return created
  },

  addTokenProfile: async (label, token) => {
    const created = await window.electronAPI.claudeAccountAdd({ label })
    applyList([...get().profiles, created])
    try {
      const usage = await window.electronAPI.claudeAccountSetToken(created.id, token)
      const profile = get().profiles.find((p) => p.id === created.id) ?? {
        ...created,
        hasToken: true
      }
      return { profile, usage }
    } catch (err) {
      // A refused paste leaves no half-account behind.
      await window.electronAPI.claudeAccountRemove(created.id)
      applyList(get().profiles.filter((p) => p.id !== created.id))
      throw err
    }
  },

  updateProfile: (id, updates) => {
    if (id === DEFAULT_CLAUDE_PROFILE_ID) return
    // Optimistic, so typing a label never lags a round-trip; main's echo
    // (`claude-accounts:changed`) settles the same value.
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, ...(updates.label !== undefined ? { label: updates.label } : {}) } : p
      )
    }))
    void window.electronAPI?.claudeAccountUpdate(id, updates)
  },

  removeProfile: (id) => {
    if (id === DEFAULT_CLAUDE_PROFILE_ID) return
    const selectedProfileId =
      get().selectedProfileId === id ? DEFAULT_CLAUDE_PROFILE_ID : get().selectedProfileId
    if (selectedProfileId !== get().selectedProfileId) persistSelected(selectedProfileId)
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
      migratedIds: state.migratedIds.filter((m) => m !== id),
      selectedProfileId
    }))
    void window.electronAPI?.claudeAccountRemove(id)
  },

  reorderProfiles: (ids) => {
    set((state) => {
      const byId = new Map(state.profiles.map((p) => [p.id, p]))
      const next = [state.profiles[0]]
      for (const id of ids) {
        const p = byId.get(id)
        if (p && p.id !== DEFAULT_CLAUDE_PROFILE_ID && !next.includes(p)) next.push(p)
      }
      for (const p of state.profiles) if (!next.includes(p)) next.push(p)
      return { profiles: next }
    })
    void window.electronAPI?.claudeAccountReorder(ids)
  },

  setSelectedProfile: (id) =>
    set((state) => {
      if (!state.profiles.some((p) => p.id === id)) return state
      persistSelected(id)
      return { selectedProfileId: id }
    }),

  setToken: async (id, token) => {
    const usage = await window.electronAPI.claudeAccountSetToken(id, token)
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, hasToken: true, tokenInvalid: false } : p
      ),
      migratedIds: state.migratedIds.filter((m) => m !== id)
    }))
    return usage
  },

  clearToken: async (id) => {
    await window.electronAPI.claudeAccountClearToken(id)
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id
          ? { ...p, hasToken: false, tokenSetAt: null, tokenExpiresAt: null, tokenInvalid: false }
          : p
      )
    }))
  }
}))

/** Take a list from main: the selection survives when its account does. */
function applyList(list: ClaudeProfile[]): void {
  const profiles = withDefault(list)
  const { selectedProfileId, migratedIds } = useClaudeProfileStore.getState()
  const keep = profiles.some((p) => p.id === selectedProfileId)
  if (!keep) persistSelected(DEFAULT_CLAUDE_PROFILE_ID)
  useClaudeProfileStore.setState({
    profiles,
    // A migrated account that got its token is migrated no more.
    migratedIds: migratedIds.filter((id) => profiles.some((p) => p.id === id && !p.hasToken)),
    selectedProfileId: keep ? selectedProfileId : DEFAULT_CLAUDE_PROFILE_ID
  })
}

/** Resolve a profile by id, falling back to the Default profile. */
export function getClaudeProfile(id: string | undefined): ClaudeProfile {
  const { profiles } = useClaudeProfileStore.getState()
  return profiles.find((p) => p.id === id) ?? profiles[0] ?? DEFAULT_PROFILE
}

/** The profile keybinding-launched sessions should use. */
export function getSelectedClaudeProfile(): ClaudeProfile {
  const { selectedProfileId } = useClaudeProfileStore.getState()
  return getClaudeProfile(selectedProfileId)
}

/**
 * An account named by an agent (`clave_open_session`'s `account`): an id, or
 * a label exact first and case-insensitive second. Pure so the rule is
 * testable; the dispatcher throws with the list when this returns undefined.
 */
export function resolveClaudeProfile(
  profiles: ClaudeProfile[],
  ref: string
): ClaudeProfile | undefined {
  const byId = profiles.find((p) => p.id === ref)
  if (byId) return byId
  const exact = profiles.filter((p) => p.label === ref)
  if (exact.length === 1) return exact[0]
  const loose = profiles.filter((p) => p.label.toLowerCase() === ref.toLowerCase())
  return loose.length === 1 ? loose[0] : undefined
}

/** What a session says about its own account: the account as it is today, or
 *  the label the session was started with when the account has since been
 *  removed (the process keeps running on it; the readouts must not say
 *  Default). A session with no account field is the Default. */
export function sessionAccount(session: {
  claudeProfileId?: string
  claudeProfileLabel?: string
}): { id: string; label: string; removed: boolean } {
  const { profiles } = useClaudeProfileStore.getState()
  const live = profiles.find((p) => p.id === (session.claudeProfileId ?? DEFAULT_CLAUDE_PROFILE_ID))
  if (live) return { id: live.id, label: live.label, removed: false }
  return {
    id: session.claudeProfileId ?? DEFAULT_CLAUDE_PROFILE_ID,
    label: session.claudeProfileLabel ?? 'Removed account',
    removed: true
  }
}

/** The spawn fields a clone or a resume carries from its source session, so
 *  the new process runs on the same account: main reads the token by
 *  `claudeProfileId` at spawn. Empty for a session on the Default. A
 *  `claudeConfigDir` is a session started before the config-dir shape was
 *  retired: it keeps its directory for its own life. */
export function accountSpawnFields(session: {
  claudeProfileId?: string
  claudeProfileLabel?: string
  claudeConfigDir?: string
}): { configDir?: string; claudeProfileId?: string; claudeProfileLabel?: string } {
  if (!session.claudeProfileId) return {}
  return {
    configDir: session.claudeConfigDir || undefined,
    claudeProfileId: session.claudeProfileId,
    claudeProfileLabel: session.claudeProfileLabel
  }
}

/** The same account, as the new session's own record. */
export function accountSessionFields(session: {
  claudeProfileId?: string
  claudeProfileLabel?: string
  claudeConfigDir?: string
}): { claudeProfileId?: string; claudeProfileLabel?: string; claudeConfigDir?: string } {
  if (!session.claudeProfileId) return {}
  return {
    claudeProfileId: session.claudeProfileId,
    claudeProfileLabel: session.claudeProfileLabel,
    claudeConfigDir: session.claudeConfigDir || undefined
  }
}

/** The spawn fields a profile contributes. The token is not among them: main
 *  reads it by `claudeProfileId` at spawn. */
export function claudeProfileSpawnFields(profile: ClaudeProfile): {
  claudeProfileId: string
  claudeProfileLabel: string
} {
  return { claudeProfileId: profile.id, claudeProfileLabel: profile.label }
}

/** "expires in 7 months" / "expires in 12 days" / "expired". Null without a
 *  token. */
export function describeTokenLife(profile: ClaudeProfile, now: number = Date.now()): string | null {
  if (!profile.hasToken || profile.tokenExpiresAt === null) return null
  const left = profile.tokenExpiresAt - now
  if (left <= 0) return 'expired'
  const days = Math.ceil(left / 86_400_000)
  if (days >= 60) return `expires in ${Math.round(days / 30)} months`
  return `expires in ${days} day${days === 1 ? '' : 's'}`
}

/** How an account signs in, for a badge or a menu line. */
export function describeClaudeProfileAuth(profile: ClaudeProfile): string {
  if (profile.id === DEFAULT_CLAUDE_PROFILE_ID) return 'Machine login'
  if (profile.hasToken) return profile.tokenInvalid ? 'Token refused' : 'Token'
  return 'No credential yet'
}

/** Whether the pool may hand a session to this account at all: a token that
 *  works, or the machine login. */
export function claudeProfileUsable(profile: ClaudeProfile): boolean {
  if (profile.id === DEFAULT_CLAUDE_PROFILE_ID) return true
  return profile.hasToken && !profile.tokenInvalid
}

let subscribed = false

/** Load the accounts from main (call once on app start) and follow every
 *  change any window makes from then on. */
export async function loadClaudeProfiles(): Promise<void> {
  const [list, selected, migrated] = await Promise.all([
    window.electronAPI?.claudeAccountsList().catch(() => null),
    window.electronAPI?.preferencesGet('selectedClaudeProfileId') as Promise<string | null>,
    window.electronAPI?.claudeAccountsMigrated?.().catch(() => [])
  ])
  const profiles = withDefault(Array.isArray(list) ? list : [])
  const selectedProfileId =
    selected && profiles.some((p) => p.id === selected) ? selected : DEFAULT_CLAUDE_PROFILE_ID
  useClaudeProfileStore.setState({
    profiles,
    selectedProfileId,
    migratedIds: Array.isArray(migrated) ? migrated : [],
    loaded: true
  })
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onClaudeAccountsChanged?.((accounts) => applyList(accounts))
  }
}
