import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { SettingsEvent } from '@clave/contract/settings'
import { ClaudeAccountsManager } from '../claude-accounts'
import { CodexAccountsManager } from '../codex-accounts'
import { AccountUsageManager } from '../usage-manager'
import { PiUsageManager } from '../pi-usage'
import { LaunchProfileManager } from '../launch-profile-manager'
import { PreferencesManager } from '../preferences-manager'
import { WorkspaceManager } from '../workspace-manager'
import type { LoginJob } from '../account-login'
import { electronTestPorts, tempDataDir } from '../ports/testing'
import {
  DEFAULT_ACCOUNT_ID,
  type AntasphereAccountLike,
  type LoginJobsLike,
  type SettingsManagers,
  settingsSourceFromManagers
} from './source'
import type { AntasphereAccountStatus } from '../../shared/antasphere-account-types'

const TOKEN = 'sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const READ = { windows: [], fetchedAt: 1 }

let dir: string
let managers: SettingsManagers
/** Every account id the stubbed usage read was asked for. */
let reads: string[]

function build(): SettingsManagers {
  const ports = electronTestPorts(dir)
  const claudeAccounts = new ClaudeAccountsManager(ports)
  const codexAccounts = new CodexAccountsManager(ports)
  const stubRead = (id: string): Promise<typeof READ> => {
    reads.push(id)
    return Promise.resolve(READ)
  }
  return {
    claudeAccounts,
    codexAccounts,
    claudeUsage: new AccountUsageManager(
      {
        ids: () => claudeAccounts.list().map((a) => a.id),
        exists: (id) => !!claudeAccounts.get(id),
        read: stubRead
      },
      DEFAULT_ACCOUNT_ID
    ),
    codexUsage: new AccountUsageManager(
      {
        ids: () => codexAccounts.list().map((a) => a.id),
        exists: (id) => !!codexAccounts.get(id),
        read: stubRead
      },
      DEFAULT_ACCOUNT_ID
    ),
    piUsage: new PiUsageManager(),
    launchProfiles: new LaunchProfileManager(ports),
    preferences: new PreferencesManager(ports),
    workspaces: new WorkspaceManager(ports)
  }
}

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    return entry.isFile() ? [full] : []
  })
}

const job = (provider: 'claude' | 'codex', accountId: string): LoginJob => ({
  id: `job-${accountId}`,
  provider,
  accountId,
  status: 'running',
  url: null,
  awaitingCode: false,
  message: null,
  startedAt: 1
})

beforeEach(() => {
  dir = tempDataDir('clave-settings-source-')
  reads = []
  managers = build()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the settings source over the real managers', () => {
  it('emits an account change once, reads with a new token, and keeps the token sealed', async () => {
    const source = settingsSourceFromManagers(managers)
    const events: SettingsEvent[] = []
    source.subscribe((event) => events.push(event))
    const getLimits = vi.spyOn(managers.claudeUsage, 'getLimits')

    const account = await source.claudeAccounts.add('Work')
    const changes = events.filter((e) => e._tag === 'accounts.claude_changed')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({ id: account.id, label: 'Work' })])
    })

    const read = await source.claudeAccounts.setToken(account.id, TOKEN)
    expect(read).toEqual(READ)
    expect(getLimits).toHaveBeenCalledWith(account.id, { force: true })
    expect(reads).toEqual([account.id])
    const listed = await source.claudeAccounts.list()
    expect(listed.find((a) => a.id === account.id)).toMatchObject({ hasToken: true })

    const files = filesUnder(dir)
    expect(files).toContain(path.join(dir, 'claude-accounts-credentials.json'))
    for (const file of files) expect(fs.readFileSync(file, 'utf8'), file).not.toContain(TOKEN)
  })

  it('refuses a login where it has no login manager, and has no job to list', async () => {
    const source = settingsSourceFromManagers(managers)
    await expect(source.logins.start('claude', 'a')).rejects.toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'login'
    })
    await expect(source.logins.startApiKey('a', 'sk-test')).rejects.toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'login'
    })
    expect(await source.logins.list()).toEqual([])
    await expect(source.logins.input('j', 'x')).rejects.toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'login'
    })
    await expect(source.logins.cancel('j')).rejects.toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'login'
    })
  })

  it('refuses the app icon without a Dock, and paints it with one', async () => {
    const source = settingsSourceFromManagers(managers)
    await expect(
      Promise.resolve().then(() => source.preferences.setAppIcon('light'))
    ).rejects.toMatchObject({ _tag: 'CapabilityUnavailable', capability: 'appIcon' })
    expect(managers.preferences.get('appIcon')).toBe('dark')

    const applyAppIcon = vi.fn()
    const docked = settingsSourceFromManagers({ ...build(), applyAppIcon })
    await docked.preferences.setAppIcon('light')
    expect(applyAppIcon).toHaveBeenCalledTimes(1)
    expect(applyAppIcon).toHaveBeenCalledWith('light')
    // The second build shares the directory: a fresh manager reads what was written.
    expect(new PreferencesManager(electronTestPorts(dir)).get('appIcon')).toBe('light')
  })

  it('loads the login manager once, and emits its progress', async () => {
    let progress: ((job: LoginJob) => void) | null = null
    const fakeLogins: LoginJobsLike = {
      startClaudeLogin: (accountId) => job('claude', accountId),
      startCodexLogin: (accountId) => job('codex', accountId),
      startCodexApiKeyLogin: async (accountId) => job('codex', accountId),
      sendInput: () => {},
      cancel: () => {},
      list: () => [],
      onProgress: (listener) => {
        progress = listener
        return () => {}
      }
    }
    const logins = vi.fn(async () => fakeLogins)
    const source = settingsSourceFromManagers({ ...managers, logins })
    const events: SettingsEvent[] = []
    source.subscribe((event) => events.push(event))

    expect(await source.logins.start('claude', 'a')).toEqual(job('claude', 'a'))
    expect(await source.logins.start('codex', 'b')).toEqual(job('codex', 'b'))
    expect(logins).toHaveBeenCalledTimes(1)

    expect(progress).not.toBeNull()
    const landed = { ...job('claude', 'a'), status: 'done' as const }
    progress!(landed)
    expect(events).toContainEqual({ _tag: 'accounts.login_progressed', job: landed })
  })

  it('validates the workspace writes and emits a change only for one that landed', async () => {
    const source = settingsSourceFromManagers(managers)
    const events: SettingsEvent[] = []
    source.subscribe((event) => events.push(event))
    const ws1 = { id: 'ws1', name: 'One', rootDir: '/tmp/x', profileFile: null, createdAt: 1 }

    expect(await source.workspaces.updateRegistry([ws1], 'w1')).toEqual({ ok: true })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      _tag: 'workspaces.state_changed',
      origin: 'w1',
      workspaces: [ws1]
    })

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = { id: 'bad key', name: 'x', rootDir: '', profileFile: null, createdAt: 1 }
    expect(await source.workspaces.updateRegistry([bad], undefined)).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await source.workspaces.updatePins('not a key!', [], undefined)).toEqual({
      ok: false,
      reason: 'invalid-key'
    })
    expect(events).toHaveLength(1)
    error.mockRestore()

    expect(await source.workspaces.updatePins(null, [{ p: 1 }], undefined)).toEqual({ ok: true })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      _tag: 'workspaces.state_changed',
      origin: null,
      pins: expect.arrayContaining([{ p: 1 }])
    })

    await source.workspaces.setLastActive('ws1')
    expect((await source.workspaces.load()).lastActiveWorkspaceId).toBe('ws1')
    await source.workspaces.setLastActive('bad key')
    expect((await source.workspaces.load()).lastActiveWorkspaceId).toBeNull()
  })

  it('reads the machine login when the usage read names no account', async () => {
    const source = settingsSourceFromManagers(managers)
    const getLimits = vi.spyOn(managers.claudeUsage, 'getLimits')
    await source.usage.readClaude(undefined, false)
    expect(getLimits).toHaveBeenLastCalledWith(DEFAULT_ACCOUNT_ID, { force: false })
    await source.usage.readClaude('', true)
    expect(getLimits).toHaveBeenLastCalledWith('default', { force: true })
    await source.usage.readClaude('abc', true)
    expect(getLimits).toHaveBeenLastCalledWith('abc', { force: true })
  })

  it('emits every usage read, the poller’s included, as an event', async () => {
    const source = settingsSourceFromManagers(managers)
    const events: SettingsEvent[] = []
    source.subscribe((event) => events.push(event))
    const account = await source.claudeAccounts.add('Polled')
    // What the five-minute clock does: a read the window never asked for.
    await managers.claudeUsage.getLimits(account.id, { force: true })
    expect(events).toContainEqual({
      _tag: 'usage.claude_read',
      accountId: account.id,
      result: READ
    })
    await managers.codexUsage.getLimits('default', { force: true })
    expect(events.filter((e) => e._tag === 'usage.codex_read')).toHaveLength(1)
  })

  it('forgets a removed account’s cached read', async () => {
    const source = settingsSourceFromManagers(managers)
    const account = await source.claudeAccounts.add('Gone')
    await source.claudeAccounts.setToken(account.id, TOKEN)
    expect(Object.keys(await source.usage.claudeSnapshot())).toContain(account.id)
    expect(await source.claudeAccounts.remove(account.id)).toBe(true)
    expect(Object.keys(await source.usage.claudeSnapshot())).not.toContain(account.id)
  })

  it('keeps delivering to the other listeners when one throws', async () => {
    const source = settingsSourceFromManagers(managers)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    source.subscribe(() => {
      throw new Error('listener down')
    })
    const second: SettingsEvent[] = []
    source.subscribe((event) => second.push(event))
    await source.claudeAccounts.add('Work')
    expect(second.map((e) => e._tag)).toContain('accounts.claude_changed')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('the Antasphere account through the source (PRDCT-3259)', () => {
  const status = (phase: 'signed-out' | 'signing-in' | 'signed-in'): AntasphereAccountStatus => ({
    phase,
    account: null,
    issuerHost: 'issuer.test',
    signedInAt: null,
    expiresAt: null,
    renewable: false,
    loginStartedAt: null,
    lastFailure: null,
    secureStorage: true
  })

  it('refuses every account call where it has no login manager: nothing local stands in', async () => {
    const source = settingsSourceFromManagers(managers)
    expect(source.antasphere).toBeDefined()
    for (const call of [
      () => source.antasphere.status(),
      () => source.antasphere.signIn(),
      () => source.antasphere.confirmHandoff({ url: 'https://issuer.test/a', generation: 1 }),
      () => source.antasphere.cancel(),
      () => source.antasphere.signOut(),
      () => source.antasphere.dismiss()
    ]) {
      await expect((async () => call())()).rejects.toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'antasphereAccount'
      })
    }
  })

  it('owns the manager: answers from it, emits its changes once, asks nothing at build', async () => {
    let change: ((s: AntasphereAccountStatus) => void) | null = null
    const calls: string[] = []
    const fake: AntasphereAccountLike = {
      status: () => status('signed-out'),
      start: async () => {
        calls.push('start')
        return {
          status: status('signing-in'),
          handoff: { url: 'https://issuer.test/authorize?state=s', generation: 3 }
        }
      },
      confirmHandoff: (handoff) => {
        calls.push(`confirm:${handoff.generation}`)
        return handoff.generation === 3
      },
      cancel: () => {
        calls.push('cancel')
        return status('signed-out')
      },
      signOut: () => {
        calls.push('signOut')
        return status('signed-out')
      },
      dismissFailure: () => {
        calls.push('dismiss')
        return status('signed-out')
      },
      onChange: (listener) => {
        change = listener
        return () => {}
      }
    }
    const source = settingsSourceFromManagers({ ...build(), antasphere: fake })
    // Nothing is asked of the manager by building the source: the entry
    // restores the session when its ports can be used, not at module load.
    expect(calls).toEqual([])
    const events: SettingsEvent[] = []
    source.subscribe((event) => events.push(event))
    expect(await source.antasphere.status()).toMatchObject({ phase: 'signed-out' })
    const signedIn = await source.antasphere.signIn()
    expect(signedIn.handoff?.generation).toBe(3)
    expect(await source.antasphere.confirmHandoff(signedIn.handoff!)).toBe(true)
    expect(await source.antasphere.confirmHandoff({ ...signedIn.handoff!, generation: 2 })).toBe(
      false
    )
    await source.antasphere.cancel()
    await source.antasphere.dismiss()
    await source.antasphere.signOut()
    expect(calls).toEqual(['start', 'confirm:3', 'confirm:2', 'cancel', 'dismiss', 'signOut'])
    expect(change).not.toBeNull()
    change!(status('signed-in'))
    expect(events).toEqual([{ _tag: 'accounts.antasphere_changed', status: status('signed-in') }])
  })
})
