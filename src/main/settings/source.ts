/**
 * The settings source the server reads and writes through
 * (`SettingsSourceService`, `@clave/server`), built over the managers the
 * settings domains already are: the Claude and Codex account lists, the
 * login jobs, the three usage readers, the launch profiles, the preferences
 * and the workspace state. One factory, two callers:
 *
 *  - the shell (`shell-source.ts`), over the module singletons, with the
 *    login jobs (they run a provider's own login command in a PTY main owns)
 *    and the Dock (the app icon);
 *  - the standalone entry (`standalone-source.ts`), over the same managers
 *    on the standalone ports, with neither: a login or an icon asked of it
 *    answers the contract's `CapabilityUnavailable`, never a 500 and never
 *    a silent no-op.
 *
 * It is the ONE origin of the settings events: every change of a manager,
 * whoever caused it (a command through the server, the IPC route, the
 * five-minute poller, a login job landing its token), is emitted once here,
 * and the server (`SettingsEventsLive`) and the IPC handlers each fan it out
 * to their own windows. A window listens on one route, so nothing arrives
 * twice.
 *
 * No `electron` import here: the file builds for the standalone server. The
 * one validation a renderer's write needs (a registry entry that is a
 * workspace, a pins scope that is a key) lives here rather than in the IPC
 * handler, so both routes refuse the same thing.
 */
import type { SettingsSourceService, Unsubscribe } from '@clave/server'
import type { SettingsEvent } from '@clave/contract/settings'
import type { ClaudeAccountsManager } from '../claude-accounts'
import type { CodexAccountsManager } from '../codex-accounts'
import type { AccountUsageManager } from '../usage-manager'
import type { PiUsageManager } from '../pi-usage'
import type { LaunchProfileManager } from '../launch-profile-manager'
import type { PreferencesManager, AppIcon } from '../preferences-manager'
import type { WorkspaceManager } from '../workspace-manager'
import type { LoginJob } from '../account-login'
import type { Workspace } from '../../shared/workspace-types'
import type { LaunchProfile } from '../../shared/agent-launch'

/** The login jobs as the source needs them (`account-login.ts`'s manager). */
export interface LoginJobsLike {
  startClaudeLogin(accountId: string): LoginJob
  startCodexLogin(accountId: string): LoginJob
  startCodexApiKeyLogin(accountId: string, apiKey: string): Promise<LoginJob>
  sendInput(jobId: string, text: string): void
  cancel(jobId: string): void
  list(): LoginJob[]
  onProgress(listener: (job: LoginJob) => void): () => void
}

export interface SettingsManagers {
  claudeAccounts: ClaudeAccountsManager
  codexAccounts: CodexAccountsManager
  claudeUsage: AccountUsageManager
  codexUsage: AccountUsageManager
  piUsage: PiUsageManager
  launchProfiles: LaunchProfileManager
  preferences: PreferencesManager
  workspaces: WorkspaceManager
  /** Where the process has a PTY for a login (the shell); absent, a login is
   *  refused. Loaded on the first call, not at construction: the login
   *  manager pulls the PTY backend in, which the shell must not load from
   *  the server's start path (`server/clave-server.ts`). */
  logins?: () => Promise<LoginJobsLike>
  /** Where the process has a Dock (the shell); absent, the icon is refused. */
  applyAppIcon?: (icon: AppIcon) => void
}

/** The machine's own login, when a usage read names no account. */
export const DEFAULT_ACCOUNT_ID = 'default'

/** A layout key as `sidebar-layout-manager.ts` validates one, repeated here
 *  because that module imports Electron and this one must not. */
export const isLayoutKey = (key: unknown): key is string =>
  typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key)

/** A renderer can send anything; a registry entry that is not a workspace
 *  would take down every path that reads `rootDir` (session restore among
 *  them). The whole write is refused rather than one bad entry stored. */
export function isWorkspace(x: unknown): x is Workspace {
  if (typeof x !== 'object' || x === null) return false
  const w = x as Record<string, unknown>
  return (
    isLayoutKey(w.id) &&
    typeof w.name === 'string' &&
    typeof w.rootDir === 'string' &&
    w.rootDir.length > 0 &&
    (w.profileFile === null || typeof w.profileFile === 'string') &&
    typeof w.createdAt === 'number'
  )
}

/**
 * What this process cannot carry, said as the contract's declared failure.
 * A plain error carrying the failure's tag and fields, not the contract's
 * Schema class: this file is loaded by main at boot and must reach no Effect
 * module (`server/lazy-load.test.ts`); the server's handlers recognise the
 * tag and answer the declared failure (`packages/server/src/settings/handlers.ts`).
 */
export class SettingsUnavailable extends Error {
  readonly _tag = 'CapabilityUnavailable' as const
  constructor(
    readonly capability: string,
    message: string
  ) {
    super(message)
    this.name = 'CapabilityUnavailable'
  }
}

const refuse = (capability: string, message: string): never => {
  throw new SettingsUnavailable(capability, message)
}

export function settingsSourceFromManagers(m: SettingsManagers): SettingsSourceService {
  const listeners = new Set<(event: SettingsEvent) => void>()
  const emit = (event: SettingsEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[settings] event listener failed', error)
      }
    }
  }
  // The managers' own changes, from whichever side: one subscription each,
  // for the life of the process.
  m.claudeAccounts.onChange((accounts) => emit({ _tag: 'accounts.claude_changed', accounts }))
  m.codexAccounts.onChange((accounts) => emit({ _tag: 'accounts.codex_changed', accounts }))
  // The login jobs, loaded once on first use, their progress emitted from then on.
  let logins: Promise<LoginJobsLike> | null = null
  const loadLogins = (capability: string, why: string): Promise<LoginJobsLike> => {
    if (!m.logins) return Promise.reject(new SettingsUnavailable(capability, why))
    if (!logins) {
      logins = m.logins().then((jobs) => {
        jobs.onProgress((job) => emit({ _tag: 'accounts.login_progressed', job }))
        return jobs
      })
    }
    return logins
  }
  m.claudeUsage.onUpdate((accountId, result) =>
    emit({ _tag: 'usage.claude_read', accountId, result })
  )
  m.codexUsage.onUpdate((accountId, result) =>
    emit({ _tag: 'usage.codex_read', accountId, result })
  )
  // A removed account's read must not outlive it in the cache (the usage
  // handlers used to do this per provider).
  m.claudeAccounts.onChange(() => forgetGone(m.claudeUsage, m.claudeAccounts.list()))
  m.codexAccounts.onChange(() => forgetGone(m.codexUsage, m.codexAccounts.list()))

  const workspaceChanged = (origin: string | undefined): void => {
    const { workspaces, pins } = m.workspaces.load()
    emit({ _tag: 'workspaces.state_changed', workspaces, pins, origin: origin ?? null })
  }

  return {
    claudeAccounts: {
      list: () => m.claudeAccounts.list(),
      migrated: () => m.claudeAccounts.migratedAccountIds(),
      add: (label) => m.claudeAccounts.add({ label }),
      rename: (id, label) =>
        m.claudeAccounts.update(id, { ...(typeof label === 'string' ? { label } : {}) }),
      reorder: (ids) => m.claudeAccounts.reorder([...ids]),
      remove: (id) => m.claudeAccounts.remove(id),
      // Storing the token and reading the account's limits with it are one
      // call: the read is what tells the user the paste worked.
      setToken: (id, token) => {
        m.claudeAccounts.setToken(id, token)
        return m.claudeUsage.getLimits(id, { force: true })
      },
      clearToken: (id) => {
        m.claudeAccounts.clearToken(id)
        m.claudeUsage.forget(id)
      }
    },
    codexAccounts: {
      list: () => m.codexAccounts.list(),
      add: (label, kind) => m.codexAccounts.add({ label, kind }),
      rename: (id, label) =>
        m.codexAccounts.update(id, { ...(typeof label === 'string' ? { label } : {}) }),
      reorder: (ids) => m.codexAccounts.reorder([...ids]),
      remove: (id) => {
        const removed = m.codexAccounts.remove(id)
        if (removed) m.codexUsage.forget(id)
        return removed
      },
      clearCredential: (id) => {
        m.codexAccounts.clearCredential(id)
        m.codexUsage.forget(id)
      }
    },
    logins: {
      start: async (provider, accountId) => {
        const jobs = await loadLogins('login', 'This server has no terminal to run a login in.')
        return provider === 'claude'
          ? jobs.startClaudeLogin(accountId)
          : jobs.startCodexLogin(accountId)
      },
      startApiKey: async (accountId, apiKey) => {
        const jobs = await loadLogins('login', 'This server cannot store a Codex login.')
        return jobs.startCodexApiKeyLogin(accountId, apiKey)
      },
      // Without a login manager there is no job to feed, cancel or list.
      input: async (jobId, text) => {
        if (m.logins)
          (await loadLogins('login', 'This server runs no login.')).sendInput(jobId, text)
      },
      cancel: async (jobId) => {
        if (m.logins) (await loadLogins('login', 'This server runs no login.')).cancel(jobId)
      },
      list: async () =>
        m.logins ? (await loadLogins('login', 'This server runs no login.')).list() : []
    },
    usage: {
      readClaude: (accountId, force) =>
        m.claudeUsage.getLimits(accountId || DEFAULT_ACCOUNT_ID, { force }),
      claudeSnapshot: () => m.claudeUsage.snapshot(),
      readCodex: (accountId, force) =>
        m.codexUsage.getLimits(accountId || DEFAULT_ACCOUNT_ID, { force }),
      codexSnapshot: () => m.codexUsage.snapshot(),
      readPi: (range) => m.piUsage.get(range)
    },
    launchProfiles: {
      list: () => m.launchProfiles.getPreferences(),
      upsert: (profile) => m.launchProfiles.upsert(mutable<LaunchProfile>(profile)),
      delete: (profileId) => m.launchProfiles.delete(profileId),
      setGlobal: (family, profileId) => m.launchProfiles.setGlobalDefault(family, profileId),
      setWorkspace: (workspaceId, family, profileId) =>
        m.launchProfiles.setWorkspaceDefault(workspaceId, family, profileId)
    },
    preferences: {
      setAppIcon: (icon) => {
        if (!m.applyAppIcon) return refuse('appIcon', 'This server has no Dock to paint.')
        m.preferences.set('appIcon', icon)
        m.applyAppIcon(icon)
      }
    },
    workspaces: {
      load: () => m.workspaces.load(),
      updateRegistry: (workspaces, origin) => {
        if (!Array.isArray(workspaces) || !workspaces.every(isWorkspace)) {
          console.error('[workspace] refused: update-registry payload is not a list of workspaces')
          return { ok: false as const, reason: 'invalid' as const }
        }
        m.workspaces.updateRegistry(mutable<Workspace[]>(workspaces))
        workspaceChanged(origin)
        return { ok: true as const }
      },
      // Pins are per workspace and global to the app: any window writes the
      // partition it changed, and every other window folds the change in.
      // 'all' is the one-time localStorage import. The scope is a partition
      // key and is validated as one.
      updatePins: (scope, pins, origin) => {
        const key: string | null | 'all' | undefined =
          scope === 'all' || scope === null ? scope : isLayoutKey(scope) ? scope : undefined
        if (key === undefined || !Array.isArray(pins)) {
          console.error(`[workspace] refused: invalid pins scope ${JSON.stringify(scope)}`)
          return { ok: false as const, reason: 'invalid-key' as const }
        }
        m.workspaces.updatePins(key, [...pins])
        workspaceChanged(origin)
        return { ok: true as const }
      },
      setLastActive: (workspaceId) =>
        m.workspaces.setLastActive(isLayoutKey(workspaceId) ? workspaceId : null)
    },
    subscribe: (listener): Unsubscribe => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** The contract's values are readonly through and through, the managers'
 *  are not; the shapes are the same (the contract module was written from
 *  the managers' types), so the cast is a cast of mutability only. */
const mutable = <T>(value: unknown): T => value as T

function forgetGone(usage: AccountUsageManager, live: ReadonlyArray<{ id: string }>): void {
  const ids = new Set(live.map((a) => a.id))
  for (const id of Object.keys(usage.snapshot())) if (!ids.has(id)) usage.forget(id)
}
