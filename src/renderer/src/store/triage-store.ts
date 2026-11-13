import { createTriageStore, type TriageProvider, type TriageSelection } from '../lib/triage'
import { launchSession } from '../lib/launch-session'
import { useSessionStore } from './session-store'
import { getActiveWorkspaceId } from './workspace-store'
import { getLastAgentSetup } from './launch-prefs'
import { selectedLaunchProfile, useLaunchProfileStore } from './launch-profile-store'
import { claudeProfileUsable, useClaudeProfileStore } from './claude-profile-store'
import { codexAccountUsable, useCodexAccountStore } from './codex-account-store'
import { BUILT_IN_LAUNCH_PROFILES } from '../../../shared/agent-launch'

function selection(requested?: TriageProvider): TriageSelection {
  const workspace = getActiveWorkspaceId()
  const last = getLastAgentSetup(workspace)
  const provider = requested ?? (last.kind === 'codex' ? 'codex' : 'claude')
  const same = last.kind === provider
  return {
    provider,
    profileId:
      same && last.launchProfileId
        ? last.launchProfileId
        : selectedLaunchProfile(provider, workspace).id,
    accountId:
      provider === 'claude'
        ? (same && last.claudeProfileId) || useClaudeProfileStore.getState().selectedProfileId
        : (same && last.codexAccountId) || useCodexAccountStore.getState().selectedAccountId,
    dangerousMode: same && last.dangerousMode
  }
}

export const useTriageStore = createTriageStore({
  prepare: () => window.electronAPI.triagePrepare(),
  snapshot: () => window.electronAPI.triageSnapshot(),
  workspace: getActiveWorkspaceId,
  selection,
  choices: async () => {
    const [preferences, profiles, accounts] = await Promise.all([
      window.electronAPI.launchProfilesList(),
      window.electronAPI.claudeAccountsList(),
      window.electronAPI.codexAccountsList()
    ])
    // Refresh the ordinary launcher's read caches. No preference is written.
    useLaunchProfileStore.setState({ preferences, loaded: true })
    useClaudeProfileStore.setState({ profiles, loaded: true })
    useCodexAccountStore.setState({ accounts, loaded: true })
    return {
      profiles: [...BUILT_IN_LAUNCH_PROFILES, ...preferences.customProfiles],
      accounts: {
        claude: profiles.map((p) => ({ id: p.id, label: p.label, usable: claudeProfileUsable(p) })),
        codex: accounts.map((a) => ({ id: a.id, label: a.label, usable: codexAccountUsable(a) }))
      }
    }
  },
  launch: async (request) => {
    const id = await launchSession(request)
    if (id) useSessionStore.getState().renameSession(id, 'Clave triage')
    return id
  },
  writeText: (text) => navigator.clipboard.writeText(text),
  findSupport: async (prepared, knownId) => {
    const sessions = await window.electronAPI.sessionsList()
    if (knownId)
      return sessions.some((s) => s.id === knownId)
        ? { status: 'found', id: knownId }
        : { status: 'missing' }
    const matches = sessions.filter(
      (s) =>
        s.cwd === prepared.bundle?.dir &&
        s.windowKey === prepared.origin.windowKey &&
        (prepared.snapshot.sessions.status !== 'ok' ||
          !prepared.snapshot.sessions.value.some((old) => old.id === s.id))
    )
    return matches.length === 1 ? { status: 'found', id: matches[0].id } : { status: 'unknown' }
  }
})
