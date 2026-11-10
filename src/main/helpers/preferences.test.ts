import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The helpers' preference on the host (PRDCT-4330): its defaults, what a
// write keeps, and the runner reading it at each call. The CLI is a stub:
// what is asserted is what it was asked, never a model's answer.

type Callback = (err: Error | null, stdout: string, stderr: string) => void
interface Spawned {
  args: string[]
  opts: { env: Record<string, string> }
  finish: Callback
}

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawned: [] as Spawned[]
}))
vi.mock('electron', () => {
  throw new Error('the helpers preference imported electron')
})
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async (_kind: string, id: string | undefined) =>
    id ? `sk-ant-oat01-${id}` : undefined
}))
vi.mock('../launch-profile-manager', () => ({
  launchProfileManager: {
    resolveClaudeCli: () => ({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
  }
}))
vi.mock('../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell-launch')>()),
  findExecutable: (command: string) => command
}))

import { fileStorage } from '../ports/storage'
import { tempDataDir } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import { HELPER_PREFERENCES_FILE, HelperPreferences, installHelperPreferences } from './preferences'
import { defineHelper, setHelperConfigSource } from './registry'
import { cancelAll, resetShutdownForTests, runHelper } from './runner'
import { titleHelper } from './title'

let dir: string
let preferences: HelperPreferences

const portsOn = (folder: string): SettingsPorts => ({
  storage: fileStorage(folder),
  secrets: {} as SettingsPorts['secrets']
})

async function ticks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** The last call answers a title, so the helper's own cap lets the next one start. */
async function answerLast(): Promise<void> {
  mocks.spawned[mocks.spawned.length - 1].finish(null, 'A Tab Title\n', '')
  await ticks()
}

beforeEach(() => {
  dir = tempDataDir('clave-helper-prefs-')
  preferences = new HelperPreferences(portsOn(dir))
  mocks.spawned.length = 0
  mocks.execFile.mockReset()
  mocks.execFile.mockImplementation(
    (_file: string, args: string[], opts: Spawned['opts'], finish: Callback) => {
      mocks.spawned.push({ args, opts, finish })
      return { stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), once: vi.fn() }
    }
  )
})

afterEach(async () => {
  cancelAll()
  for (const child of mocks.spawned) child.finish(new Error('killed'), '', '')
  await ticks()
  resetShutdownForTests()
  setHelperConfigSource()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the defaults', () => {
  it('lists every built-in helper, on, on its own model, on the tab’s account, and writes nothing', () => {
    const list = preferences.list()
    const ids = list.map((h) => h.id)
    for (const id of [
      'commit-message',
      'tab-title',
      'push-summary',
      'exchange-digest',
      'work-digest'
    ])
      expect(ids).toContain(id)
    const title = list.find((h) => h.id === 'tab-title')
    expect(title).toEqual({
      id: 'tab-title',
      label: 'Tab titles',
      enabled: true,
      model: 'haiku',
      defaultModel: 'haiku',
      account: { kind: 'session' }
    })
    expect(preferences.configFor('tab-title')).toBeUndefined()
    expect(fs.existsSync(path.join(dir, HELPER_PREFERENCES_FILE))).toBe(false)
  })
})

describe('a write', () => {
  it('keeps what changed, field by field, and answers the whole list', () => {
    const after = preferences.set('tab-title', { enabled: false })
    expect(after.find((h) => h.id === 'tab-title')?.enabled).toBe(false)
    preferences.set('tab-title', { model: 'sonnet' })
    preferences.set('tab-title', { account: { kind: 'account', accountId: 'helpers' } })
    expect(preferences.configFor('tab-title')).toEqual({
      enabled: false,
      model: 'sonnet',
      claudeProfileId: 'helpers'
    })
    // Another helper is untouched.
    expect(preferences.configFor('commit-message')).toBeUndefined()
    // And it is on the disk, for the other process sharing the folder.
    expect(new HelperPreferences(portsOn(dir)).configFor('tab-title')).toEqual({
      enabled: false,
      model: 'sonnet',
      claudeProfileId: 'helpers'
    })
  })

  it('the machine login is null, the tab’s own is no entry, the default model is no entry', () => {
    preferences.set('exchange-digest', { account: { kind: 'machine' }, model: 'opus' })
    expect(preferences.configFor('exchange-digest')).toEqual({
      model: 'opus',
      claudeProfileId: null
    })
    expect(preferences.list().find((h) => h.id === 'exchange-digest')?.account).toEqual({
      kind: 'machine'
    })
    preferences.set('exchange-digest', { account: { kind: 'session' }, model: null })
    expect(preferences.configFor('exchange-digest')).toBeUndefined()
    preferences.set('exchange-digest', { model: 'haiku', enabled: true })
    expect(preferences.configFor('exchange-digest')).toBeUndefined()
  })

  it('refuses a helper nobody declared and a model that is not a name', () => {
    expect(() => preferences.set('nope', { enabled: false })).toThrow(/no helper "nope"/)
    expect(() => preferences.set('tab-title', { model: '--dangerously-skip' })).toThrow(
      /not a model/
    )
    expect(() =>
      preferences.set('tab-title', { account: { kind: 'account', accountId: '' } })
    ).toThrow(/not an account/)
  })

  it('reads past a hand-edited file: a bad field costs that field only', () => {
    fs.writeFileSync(
      path.join(dir, HELPER_PREFERENCES_FILE),
      JSON.stringify({
        version: 1,
        helpers: { 'tab-title': { enabled: 'no', model: 'sonnet', claudeProfileId: 7 } }
      })
    )
    expect(preferences.configFor('tab-title')).toEqual({ model: 'sonnet' })
    fs.writeFileSync(path.join(dir, HELPER_PREFERENCES_FILE), '{ not json')
    expect(preferences.configFor('tab-title')).toBeUndefined()
  })
})

describe('the runner reads it at each call', () => {
  it('a helper switched off runs nothing', async () => {
    installHelperPreferences(preferences)
    preferences.set('tab-title', { enabled: false })
    const outcome = await runHelper(titleHelper, 'name this tab please', {})
    expect(outcome).toEqual({
      ok: false,
      reason: 'disabled',
      detail: 'Switched off in Settings › Helpers (Tab titles).'
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('another model is the one the CLI is asked for, from the next call on', async () => {
    installHelperPreferences(preferences)
    void runHelper(titleHelper, 'first message here', {})
    await ticks()
    expect(mocks.spawned[0].args.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    await answerLast()
    preferences.set('tab-title', { model: 'sonnet' })
    void runHelper(titleHelper, 'second message here', {})
    await ticks()
    expect(mocks.spawned[1].args.slice(0, 3)).toEqual(['-p', '--model', 'sonnet'])
  })

  it('a fixed account replaces the tab’s, and the machine login carries no token', async () => {
    installHelperPreferences(preferences)
    preferences.set('tab-title', { account: { kind: 'account', accountId: 'helpers' } })
    void runHelper(titleHelper, 'a message', { claudeProfileId: 'tab-acct' })
    await ticks()
    expect(mocks.spawned[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-helpers')
    await answerLast()
    preferences.set('tab-title', { account: { kind: 'machine' } })
    void runHelper(titleHelper, 'another message', { claudeProfileId: 'tab-acct' })
    await ticks()
    expect(mocks.spawned[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    await answerLast()
    preferences.set('tab-title', { account: { kind: 'session' } })
    void runHelper(titleHelper, 'a third message', { claudeProfileId: 'tab-acct' })
    await ticks()
    expect(mocks.spawned[2].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-tab-acct')
  })
})

describe('the list', () => {
  it('reads in a person’s order: titles, digests, git, then any later helper by label', () => {
    defineHelper({
      id: 'zz-throwaway-explainer',
      label: 'A throwaway explainer',
      systemPrompt: 'x',
      buildPrompt: () => 'x',
      parseReply: () => null,
      model: 'haiku',
      timeoutMs: 1000,
      priority: 999
    })
    const ids = preferences.list().map((h) => h.id)
    expect(ids.slice(0, 5)).toEqual([
      'tab-title',
      'exchange-digest',
      'work-digest',
      'commit-message',
      'push-summary'
    ])
    // Declared in the registry and nowhere else: it shows, and can be set.
    expect(ids).toContain('zz-throwaway-explainer')
    expect(ids.indexOf('zz-throwaway-explainer')).toBeGreaterThan(4)
    preferences.set('zz-throwaway-explainer', { enabled: false })
    expect(preferences.configFor('zz-throwaway-explainer')).toEqual({ enabled: false })
  })
})

describe('an account that was removed', () => {
  it('falls back to the tab’s own, the row says so, and any pick clears it', () => {
    const gone = new HelperPreferences(portsOn(dir), { accountExists: (id) => id !== 'gone' })
    gone.set('tab-title', { account: { kind: 'account', accountId: 'gone' }, model: 'sonnet' })
    expect(gone.configFor('tab-title')).toEqual({ model: 'sonnet' })
    expect(gone.list().find((h) => h.id === 'tab-title')).toMatchObject({
      account: { kind: 'session' },
      accountRemoved: true
    })
    gone.set('tab-title', { account: { kind: 'session' } })
    const row = gone.list().find((h) => h.id === 'tab-title')
    expect(row?.accountRemoved).toBeUndefined()
    expect(preferences.configFor('tab-title')).toEqual({ model: 'sonnet' })
  })

  it('a helper on a removed account runs on the tab’s, not a failure each call', async () => {
    const gone = new HelperPreferences(portsOn(dir), { accountExists: () => false })
    installHelperPreferences(gone)
    gone.set('tab-title', { account: { kind: 'account', accountId: 'gone' } })
    void runHelper(titleHelper, 'a message', { claudeProfileId: 'tab-acct' })
    await ticks()
    expect(mocks.spawned[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-tab-acct')
  })
})
