import type { ClaudeAccount, CodexAccount, UsageError, UsageLimits } from '../../../preload/index.d'
import type { FleetSettingsEvent } from '../../../preload/fleet-types'
import type {
  LaunchProfile,
  LaunchProfilePreferences,
  LauncherFamily
} from '../../../shared/agent-launch'
import { tightestWindow, type AccountUsageSummary } from './usage-store'
import { DEFAULT_CLAUDE_PROFILE_ID } from './claude-profile-store'
import { DEFAULT_CODEX_ACCOUNT_ID } from './codex-account-store'
import { useFleetStore } from './fleet-store'

export type { AccountUsageSummary } from './usage-store'

import {
  useServerSettingsStore,
  type ServerSettings,
  type ServerUsageProvider
} from './server-settings-state'

export { serverProfilesFor, useServerSettingsStore } from './server-settings-state'
export type { ServerSettings, ServerUsageProvider } from './server-settings-state'

// A server error can carry source details and paths of the server's disk;
// the page only needs to know it should check the connection (the stance of
// fleet-store's reportFleetError).
const LOAD_FAILED = 'The server settings could not be read. Check its connection and try again.'
const READ_FAILED = 'The server did not answer this usage read. Try again.'

const DEFAULT_CLAUDE: ClaudeAccount = {
  id: DEFAULT_CLAUDE_PROFILE_ID,
  label: 'Default',
  hasToken: false,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
}
const DEFAULT_CODEX: CodexAccount = {
  id: DEFAULT_CODEX_ACCOUNT_ID,
  label: 'Default',
  kind: 'chatgpt',
  hasCredential: false
}

// The Default is the server's own machine login, always first, as the local
// stores keep it: a server that has not listed it yet still has one.
function claudeWithDefault(list: readonly ClaudeAccount[]): ClaudeAccount[] {
  const own = list.find((a) => a.id === DEFAULT_CLAUDE_PROFILE_ID)
  return [own ?? DEFAULT_CLAUDE, ...list.filter((a) => a.id !== DEFAULT_CLAUDE_PROFILE_ID)]
}
function codexWithDefault(list: readonly CodexAccount[]): CodexAccount[] {
  const own = list.find((a) => a.id === DEFAULT_CODEX_ACCOUNT_ID)
  return [own ?? DEFAULT_CODEX, ...list.filter((a) => a.id !== DEFAULT_CODEX_ACCOUNT_ID)]
}

function emptySettings(): ServerSettings {
  return {
    status: 'idle',
    error: null,
    claude: claudeWithDefault([]),
    codex: codexWithDefault([]),
    migrated: [],
    profiles: null,
    usage: { claude: {}, codex: {} }
  }
}

/** The entry for a server, or an empty idle one; never writes. */
export function serverSettingsFor(serverId: string): ServerSettings {
  return useServerSettingsStore.getState().byServer[serverId] ?? emptySettings()
}

// Bumped when a server's entry is dropped, so a read that was in flight for
// it lands nowhere rather than bringing the entry back.
const generations = new Map<string, number>()
const generationOf = (serverId: string): number => generations.get(serverId) ?? 0

// Bumped on every pushed account list, so a load answered after a push keeps
// the pushed list (the newer one) rather than its own older answer.
const listPushes = new Map<string, { claude: number; codex: number }>()
const listPushesOf = (serverId: string): { claude: number; codex: number } => ({
  ...(listPushes.get(serverId) ?? { claude: 0, codex: 0 })
})
const bumpListPush = (serverId: string, provider: ServerUsageProvider): void => {
  const current = listPushesOf(serverId)
  listPushes.set(serverId, { ...current, [provider]: current[provider] + 1 })
}

function patch(serverId: string, change: (current: ServerSettings) => ServerSettings): void {
  useServerSettingsStore.setState((state) => ({
    byServer: {
      ...state.byServer,
      [serverId]: change(state.byServer[serverId] ?? emptySettings())
    }
  }))
}

function setSummary(
  serverId: string,
  provider: ServerUsageProvider,
  accountId: string,
  change: (previous: AccountUsageSummary | undefined) => AccountUsageSummary
): void {
  patch(serverId, (current) => ({
    ...current,
    usage: {
      ...current.usage,
      [provider]: {
        ...current.usage[provider],
        [accountId]: change(current.usage[provider][accountId])
      }
    }
  }))
}

/** One read as a summary the rows can draw. A successful read older than the
 *  one already held (a polled push landing after a forced read) keeps the
 *  newer numbers. */
export function summarizeUsageRead(
  result: UsageLimits | UsageError,
  previous?: AccountUsageSummary
): AccountUsageSummary {
  if ('error' in result) {
    // The service's own words, an unauthorized refusal included: they name
    // the account's problem and carry no credential.
    return {
      status: 'error',
      tightest: null,
      error: result.error,
      fetchedAt: Date.now(),
      refreshing: false
    }
  }
  if (
    previous?.status === 'ready' &&
    previous.fetchedAt != null &&
    previous.fetchedAt > result.fetchedAt
  )
    return { ...previous, refreshing: false }
  return {
    status: 'ready',
    tightest: tightestWindow(result.windows),
    windows: result.windows,
    error: null,
    fetchedAt: result.fetchedAt,
    refreshing: false,
    message: result.message
  }
}

const loading = (previous: AccountUsageSummary | undefined): AccountUsageSummary =>
  previous
    ? { ...previous, refreshing: true }
    : { status: 'loading', tightest: null, error: null, fetchedAt: null, refreshing: true }

/** Read one account's usage on the server; the summary says refreshing
 *  meanwhile, and a failure of the bridge itself stays a safe sentence. */
export async function readServerUsage(
  serverId: string,
  provider: ServerUsageProvider,
  accountId: string,
  force: boolean
): Promise<void> {
  const generation = generationOf(serverId)
  setSummary(serverId, provider, accountId, loading)
  let result: UsageLimits | UsageError
  try {
    result = await window.electronAPI.fleetUsage(serverId, provider, accountId, force)
  } catch {
    result = { error: READ_FAILED }
  }
  if (generationOf(serverId) !== generation) return
  setSummary(serverId, provider, accountId, (previous) => summarizeUsageRead(result, previous))
}

/** Every listed account of a provider, read again live, in parallel. */
export async function refreshServerUsage(
  serverId: string,
  provider: ServerUsageProvider
): Promise<void> {
  const accounts = serverSettingsFor(serverId)[provider]
  await Promise.all(accounts.map((a) => readServerUsage(serverId, provider, a.id, true)))
}

type LiveRead = { provider: ServerUsageProvider; accountId: string; force: boolean }

/** The snapshot's reads, taken as they are when they succeeded. A failed one
 *  is not taken: holding the server's cached error would show it for the
 *  whole freshness window, so it is read live and forced (the stance of
 *  usage-store's primeClaudeAccountsUsage); a missing one is read live. */
function fromSnapshot(
  provider: ServerUsageProvider,
  ids: string[],
  snapshot: Record<string, UsageLimits | UsageError>,
  previous: Record<string, AccountUsageSummary>,
  live: LiveRead[]
): Record<string, AccountUsageSummary> {
  const out: Record<string, AccountUsageSummary> = {}
  for (const accountId of ids) {
    const known = snapshot[accountId]
    if (known && !('error' in known)) {
      out[accountId] = summarizeUsageRead(known, previous[accountId])
      continue
    }
    out[accountId] = loading(previous[accountId])
    live.push({ provider, accountId, force: known !== undefined })
  }
  return out
}

const loads = new Map<string, Promise<void>>()

/** Read a server's accounts, profiles and usage. Two calls for one server
 *  while the first is in flight share it. */
export function loadServerSettings(serverId: string): Promise<void> {
  const running = loads.get(serverId)
  if (running) return running
  const run = (async (): Promise<void> => {
    const generation = generationOf(serverId)
    const pushesAtStart = listPushesOf(serverId)
    patch(serverId, (current) => ({ ...current, status: 'loading', error: null }))
    const api = window.electronAPI
    let answers: [
      Awaited<ReturnType<typeof api.fleetAccounts>>,
      Awaited<ReturnType<typeof api.fleetLaunchSettings>>,
      Record<string, UsageLimits | UsageError>,
      Record<string, UsageLimits | UsageError>
    ]
    try {
      answers = await Promise.all([
        api.fleetAccounts(serverId),
        api.fleetLaunchSettings(serverId),
        api.fleetUsageSnapshot(serverId, 'claude'),
        api.fleetUsageSnapshot(serverId, 'codex')
      ])
    } catch {
      if (generationOf(serverId) === generation)
        patch(serverId, (current) => ({ ...current, status: 'error', error: LOAD_FAILED }))
      return
    }
    if (generationOf(serverId) !== generation) return
    const [accounts, launch, claudeSnapshot, codexSnapshot] = answers
    const pushes = listPushesOf(serverId)
    const live: LiveRead[] = []
    patch(serverId, (current) => {
      // A list pushed while this load was out is newer than the load's answer.
      const claude =
        pushes.claude === pushesAtStart.claude ? claudeWithDefault(accounts.claude) : current.claude
      const codex =
        pushes.codex === pushesAtStart.codex ? codexWithDefault(accounts.codex) : current.codex
      return {
        status: 'ready',
        error: null,
        claude,
        codex,
        migrated: [...accounts.migrated],
        profiles: launch.profiles,
        usage: {
          claude: fromSnapshot(
            'claude',
            claude.map((a) => a.id),
            claudeSnapshot,
            current.usage.claude,
            live
          ),
          codex: fromSnapshot(
            'codex',
            codex.map((a) => a.id),
            codexSnapshot,
            current.usage.codex,
            live
          )
        }
      }
    })
    for (const read of live)
      void readServerUsage(serverId, read.provider, read.accountId, read.force)
  })().finally(() => loads.delete(serverId))
  loads.set(serverId, run)
  return run
}

function replaceProfiles(serverId: string, profiles: LaunchProfilePreferences): void {
  patch(serverId, (current) => ({ ...current, profiles }))
}

export async function saveServerLaunchProfile(
  serverId: string,
  profile: LaunchProfile
): Promise<void> {
  replaceProfiles(serverId, await window.electronAPI.fleetLaunchProfileUpsert(serverId, profile))
}

export async function deleteServerLaunchProfile(
  serverId: string,
  profileId: string
): Promise<void> {
  replaceProfiles(serverId, await window.electronAPI.fleetLaunchProfileDelete(serverId, profileId))
}

export async function setServerGlobalLaunchProfile(
  serverId: string,
  family: LauncherFamily,
  profileId: string | null
): Promise<void> {
  replaceProfiles(
    serverId,
    await window.electronAPI.fleetLaunchProfileSetGlobal(serverId, family, profileId)
  )
}

/** Apply one pushed change of a server's settings. */
export function applyServerSettingsEvent(event: FleetSettingsEvent): void {
  switch (event.kind) {
    case 'claude-accounts':
      bumpListPush(event.serverId, 'claude')
      patch(event.serverId, (current) => ({
        ...current,
        claude: claudeWithDefault(event.accounts)
      }))
      return
    case 'codex-accounts':
      bumpListPush(event.serverId, 'codex')
      patch(event.serverId, (current) => ({ ...current, codex: codexWithDefault(event.accounts) }))
      return
    case 'claude-usage':
    case 'codex-usage': {
      const provider = event.kind === 'claude-usage' ? 'claude' : 'codex'
      const { result } = event
      setSummary(event.serverId, provider, event.accountId, (previous) =>
        summarizeUsageRead(result, previous)
      )
    }
  }
}

function dropServer(serverId: string): void {
  generations.set(serverId, generationOf(serverId) + 1)
  listPushes.delete(serverId)
  loads.delete(serverId)
  useServerSettingsStore.setState((state) => {
    const byServer = { ...state.byServer }
    delete byServer[serverId]
    return { byServer }
  })
}

let started = false
/** Once per window: the servers' pushed changes land here, a reconnect reads
 *  the server again (the socket says nothing of what changed while it was
 *  down), and a server removed from the saved connections loses its entry. */
export function startServerSettingsEvents(): void {
  if (started) return
  started = true
  window.electronAPI.onFleetSettingsEvent?.(applyServerSettingsEvent)
  useFleetStore.subscribe((state, previous) => {
    const { byServer } = useServerSettingsStore.getState()
    if (state.statuses !== previous.statuses) {
      for (const [serverId, status] of Object.entries(state.statuses)) {
        if (status.state !== 'connected' || previous.statuses[serverId]?.state === 'connected')
          continue
        const entry = byServer[serverId]
        if (entry && (entry.status === 'ready' || entry.status === 'error'))
          void loadServerSettings(serverId)
      }
    }
    if (state.connections !== previous.connections) {
      const kept = new Set(state.connections.map((c) => c.id))
      for (const serverId of Object.keys(byServer)) if (!kept.has(serverId)) dropServer(serverId)
    }
  })
}
