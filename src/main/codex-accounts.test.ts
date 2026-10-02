import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  CodexAccountsManager,
  defaultCodexHome,
  syncCodexHome,
  CODEX_AUTH_FILE
} from './codex-accounts'
import { eachTestPorts, tempDataDir } from './ports/testing'

const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-codex-machine-'))

const env = { CODEX_HOME: machineHome }

function seedMachineHome(): void {
  fs.rmSync(machineHome, { recursive: true, force: true })
  fs.mkdirSync(path.join(machineHome, 'sessions', '2026'), { recursive: true })
  fs.mkdirSync(path.join(machineHome, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(machineHome, 'config.toml'), 'model = "gpt"\n')
  fs.writeFileSync(path.join(machineHome, 'history.jsonl'), '')
  fs.writeFileSync(path.join(machineHome, CODEX_AUTH_FILE), '{"tokens":{}}')
}

beforeEach(() => {
  seedMachineHome()
})

describe('defaultCodexHome', () => {
  it("is the user's CODEX_HOME when their shell exports one, else ~/.codex", () => {
    expect(defaultCodexHome({ CODEX_HOME: '/x/codex' })).toBe('/x/codex')
    expect(defaultCodexHome({ CODEX_HOME: '  ' })).toBe(path.join(os.homedir(), '.codex'))
    expect(defaultCodexHome({})).toBe(path.join(os.homedir(), '.codex'))
  })
})

/**
 * The home is the account (ADR 0002): everything of the machine's own home
 * but the credential is a link, so config, sessions, skills and hooks stay
 * shared and `codex resume` works across accounts. Nothing here fails
 * loudly: a missing link is a session that silently runs on a different
 * config, so each rule is pinned.
 */
describe('syncCodexHome', () => {
  const dir = tempDataDir('clave-codex-homes-')

  it('links every top-level entry but auth.json, and never copies the credential', () => {
    const home = path.join(dir, 'home-a')
    const linked = syncCodexHome(home, machineHome)
    expect(linked.sort()).toEqual(['config.toml', 'history.jsonl', 'sessions', 'skills'])
    expect(fs.readlinkSync(path.join(home, 'sessions'))).toBe(path.join(machineHome, 'sessions'))
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8')).toBe('model = "gpt"\n')
    expect(fs.existsSync(path.join(home, CODEX_AUTH_FILE))).toBe(false)
    expect(fs.statSync(home).mode & 0o777).toBe(0o700)
  })

  it('is idempotent, links what appeared since, and drops a link whose target is gone', () => {
    const home = path.join(dir, 'home-b')
    syncCodexHome(home, machineHome)
    expect(syncCodexHome(home, machineHome)).toEqual([])
    fs.mkdirSync(path.join(machineHome, 'memories'))
    fs.rmSync(path.join(machineHome, 'history.jsonl'))
    expect(syncCodexHome(home, machineHome)).toEqual(['memories'])
    expect(fs.existsSync(path.join(home, 'memories'))).toBe(true)
    expect(() => fs.lstatSync(path.join(home, 'history.jsonl'))).toThrow()
  })

  it("leaves a real file Codex detached, and the account's own auth.json, alone", () => {
    const home = path.join(dir, 'home-c')
    syncCodexHome(home, machineHome)
    fs.unlinkSync(path.join(home, 'config.toml'))
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "mine"\n')
    fs.writeFileSync(path.join(home, CODEX_AUTH_FILE), '{"mine":true}')
    syncCodexHome(home, machineHome)
    expect(fs.lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8')).toBe('model = "mine"\n')
    expect(fs.readFileSync(path.join(home, CODEX_AUTH_FILE), 'utf-8')).toBe('{"mine":true}')
  })

  it('makes a bare home when the machine has no Codex home yet', () => {
    const home = path.join(dir, 'home-d')
    expect(syncCodexHome(home, path.join(dir, 'nowhere'))).toEqual([])
    expect(fs.statSync(home).isDirectory()).toBe(true)
  })
})

describe.each(eachTestPorts())('on %s', (_name, makePorts) => {
  const ports = makePorts()
  const dir = ports.dir
  const manager = new CodexAccountsManager(ports)

  beforeEach(() => {
    for (const account of manager.list(env)) {
      if (account.id !== 'default') manager.remove(account.id)
    }
  })

  describe('the account list', () => {
    it('always starts with the Default, the machine home, and says whether it is signed in', () => {
      expect(manager.list(env)[0]).toMatchObject({
        id: 'default',
        kind: 'chatgpt',
        hasCredential: true
      })
      fs.rmSync(path.join(machineHome, CODEX_AUTH_FILE))
      expect(manager.list(env)[0].hasCredential).toBe(false)
    })

    it('adds, renames, resolves by id or name, reorders and removes', () => {
      const work = manager.add({ label: 'Work', kind: 'chatgpt' })
      const team = manager.add({ label: 'Team', kind: 'apiKey' })
      expect(manager.resolve('work')?.id).toBe(work.id)
      expect(manager.resolve(team.id)?.kind).toBe('apiKey')
      manager.update(work.id, { label: 'Work (Pro)' })
      expect(manager.get(work.id)?.label).toBe('Work (Pro)')
      manager.reorder([team.id, work.id])
      expect(manager.list().map((a) => a.id)).toEqual(['default', team.id, work.id])
      manager.reorder(['nobody', work.id])
      expect(manager.list().map((a) => a.id)).toEqual(['default', work.id, team.id])
      expect(manager.remove(work.id)).toBe(true)
      expect(manager.resolve('Work (Pro)')).toBeUndefined()
    })

    it('never removes, renames or gives a home to the Default', () => {
      expect(manager.remove('default')).toBe(false)
      expect(manager.update('default', { label: 'x' })?.label).toBe('Default')
      expect(manager.homeFor('default')).toBeUndefined()
      expect(manager.syncHome('default', env)).toBeUndefined()
    })

    it('survives a reload from disk', () => {
      const work = manager.add({ label: 'Persisted', kind: 'chatgpt' })
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'codex-accounts.json'), 'utf-8'))
      expect(raw.accounts).toEqual([{ id: work.id, label: 'Persisted', kind: 'chatgpt' }])
    })
  })

  describe('the homes', () => {
    it('an account home lives under the data directory the port owns', () => {
      const work = manager.add({ label: 'Work', kind: 'chatgpt' })
      const home = manager.homeFor(work.id)!
      expect(home.startsWith(path.join(ports.dir, 'codex-homes'))).toBe(true)
      manager.syncHome(work.id, env)
      expect(fs.existsSync(home)).toBe(true)
      manager.remove(work.id)
      expect(fs.existsSync(home)).toBe(false)
    })

    it('gives every other account a home under user data, synced from the machine home', () => {
      const work = manager.add({ label: 'Work', kind: 'chatgpt' })
      const home = manager.syncHome(work.id, env)
      expect(home).toBe(path.join(dir, 'codex-homes', work.id))
      expect(fs.lstatSync(path.join(home!, 'sessions')).isSymbolicLink()).toBe(true)
      expect(manager.get(work.id)?.hasCredential).toBe(false)
      fs.writeFileSync(path.join(home!, CODEX_AUTH_FILE), '{}')
      expect(manager.get(work.id)?.hasCredential).toBe(true)
    })

    it('forgets the credential on clear, and the whole home with the account', () => {
      const work = manager.add({ label: 'Work', kind: 'chatgpt' })
      const home = manager.syncHome(work.id, env)!
      fs.writeFileSync(path.join(home, CODEX_AUTH_FILE), '{}')
      manager.clearCredential(work.id)
      expect(fs.existsSync(path.join(home, CODEX_AUTH_FILE))).toBe(false)
      expect(fs.existsSync(home)).toBe(true)
      manager.remove(work.id)
      expect(fs.existsSync(home)).toBe(false)
      // The machine's own home is never touched by a removal.
      expect(fs.existsSync(path.join(machineHome, 'sessions'))).toBe(true)
    })

    it('tells listeners on every change', () => {
      const seen: number[] = []
      const off = manager.onChange((list) => seen.push(list.length))
      const work = manager.add({ label: 'Work', kind: 'chatgpt' })
      manager.notifyChanged()
      manager.remove(work.id)
      off()
      expect(seen).toEqual([2, 2, 1])
    })
  })
})
