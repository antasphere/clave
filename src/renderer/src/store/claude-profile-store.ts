import { create } from 'zustand'
import type { ClaudeAccount, UsageError, UsageLimits } from '../../../preload/index.d'

/**
 * A Claude account: a label plus the credential a session on it runs with.
 *
 * The list is the main process's (`src/main/claude-accounts.ts`), mirrored
 * here: every window sees the same accounts, and a token pasted in one window
 * is known to the spawn path of every other. The renderer never holds a token,
 * only `hasToken`.
 *
 * Three kinds of account share the shape:
 *  - a pasted `claude setup-token` token (`hasToken`), injected into the
 *    session as `CLAUDE_CODE_OAUTH_TOKEN`; settings, plugins and history stay
 *    the shared `~/.claude`;
 *  - a `CLAUDE_CONFIG_DIR` of its own (`configDir`, issue #22), signed in
 *    through Claude's own login flow on its first session;
 *  - the built-in Default, a passthrough to whatever the machine is signed
 *    into: no token, no dir, nothing injected.
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
  configDir: '',
  hasToken: false
}

interface ClaudeProfileState {
  profiles: ClaudeProfile[]
  /** The profile used for keybinding-launched sessions and as the picker's
   *  remembered last choice. */
  selectedProfileId: string
  loaded: boolean
  /** A config-dir account (the pre-token shape). */
  addProfile: (label: string, configDir: string) => Promise<ClaudeProfile | null>
  /** A token account: created, then the token stored and proven by a usage
   *  read in one call; the read is what the form shows. */
  addTokenProfile: (
    label: string,
    token: string
  ) => Promise<{ profile: ClaudeProfile; usage: UsageLimits | UsageError }>
  updateProfile: (id: string, updates: Partial<Pick<ClaudeProfile, 'label' | 'configDir'>>) => void
  removeProfile: (id: string) => void
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
  loaded: false,

  addProfile: async (label, configDir) => {
    const created = await window.electronAPI?.claudeAccountAdd({ label, configDir })
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
        p.id === id
          ? {
              ...p,
              ...(updates.label !== undefined ? { label: updates.label } : {}),
              ...(updates.configDir !== undefined ? { configDir: updates.configDir.trim() } : {})
            }
          : p
      )
    }))
    void window.electronAPI?.claudeAccountUpdate(id, updates)
  },

  removeProfile: (id) => {
    if (id === DEFAULT_CLAUDE_PROFILE_ID) return
    const selectedProfileId =
      get().selectedProfileId === id ? DEFAULT_CLAUDE_PROFILE_ID : get().selectedProfileId
    if (selectedProfileId !== get().selectedProfileId) persistSelected(selectedProfileId)
    set((state) => ({ profiles: state.profiles.filter((p) => p.id !== id), selectedProfileId }))
    void window.electronAPI?.claudeAccountRemove(id)
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
      profiles: state.profiles.map((p) => (p.id === id ? { ...p, hasToken: true } : p))
    }))
    return usage
  },

  clearToken: async (id) => {
    await window.electronAPI.claudeAccountClearToken(id)
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? { ...p, hasToken: false } : p))
    }))
  }
}))

/** Take a list from main: the selection survives when its account does. */
function applyList(list: ClaudeProfile[]): void {
  const profiles = withDefault(list)
  const { selectedProfileId } = useClaudeProfileStore.getState()
  const keep = profiles.some((p) => p.id === selectedProfileId)
  if (!keep) persistSelected(DEFAULT_CLAUDE_PROFILE_ID)
  useClaudeProfileStore.setState({
    profiles,
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
 *  `claudeProfileId` at spawn. Empty for a session on the Default. */
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

/** The spawn fields a profile contributes. `configDir` is undefined for the
 *  Default profile so we never set CLAUDE_CONFIG_DIR on a passthrough session.
 *  The token is not among them: main reads it by `claudeProfileId` at spawn. */
export function claudeProfileSpawnFields(profile: ClaudeProfile): {
  configDir?: string
  claudeProfileId: string
  claudeProfileLabel: string
} {
  return {
    configDir: profile.configDir || undefined,
    claudeProfileId: profile.id,
    claudeProfileLabel: profile.label
  }
}

/** How an account signs in, for a badge or a menu line. */
export function describeClaudeProfileAuth(profile: ClaudeProfile): string {
  if (profile.id === DEFAULT_CLAUDE_PROFILE_ID) return 'Machine login'
  if (profile.hasToken) return 'Token'
  if (profile.configDir) return 'Config directory'
  return 'No credential yet'
}

let subscribed = false

/** Load the accounts from main (call once on app start) and follow every
 *  change any window makes from then on. */
export async function loadClaudeProfiles(): Promise<void> {
  const [list, selected] = await Promise.all([
    window.electronAPI?.claudeAccountsList().catch(() => null),
    window.electronAPI?.preferencesGet('selectedClaudeProfileId') as Promise<string | null>
  ])
  const profiles = withDefault(Array.isArray(list) ? list : [])
  const selectedProfileId =
    selected && profiles.some((p) => p.id === selected) ? selected : DEFAULT_CLAUDE_PROFILE_ID
  useClaudeProfileStore.setState({ profiles, selectedProfileId, loaded: true })
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onClaudeAccountsChanged?.((accounts) => applyList(accounts))
  }
}
