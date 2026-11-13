import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { syncPiConnectionDir } from './provider-injection-pi-dir'

/**
 * A Pi connection's agent directory (PRDCT-4496): the person's own entries
 * linked, settings.json copied rather than linked, no auth.json at all (Pi reads it before models.json, so one there
 * would be the credential instead of the connection), and a models.json whose
 * entry for the provider names the variable. The person's directory is read
 * only. All values here are made up.
 */

let tmp: string
let home: string
let root: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-conn-'))
  home = path.join(tmp, 'home-agent')
  root = path.join(tmp, 'pi-connections')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(home, 'extensions'))
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}\n')
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({ deepseek: { type: 'api_key', key: 'made-up-stored-key' } })
  )
  fs.writeFileSync(
    path.join(home, 'models.json'),
    JSON.stringify({
      providers: {
        deepseek: { baseUrl: 'https://made-up.invalid/v1', apiKey: 'made-up-own-key' },
        mine: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '$MINE' }
      }
    })
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function sync(entry = { apiKey: '$DEEPSEEK_API_KEY' }, providerId = 'deepseek'): string {
  return syncPiConnectionDir({
    root,
    homeAgentDir: home,
    connectionId: 'conn-1',
    providerId,
    entry
  })
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    out[name] = fs.statSync(file).isDirectory() ? '<dir>' : fs.readFileSync(file, 'utf8')
  }
  return out
}

describe('syncPiConnectionDir', () => {
  it('links every entry of the home but auth.json, models.json and settings.json', () => {
    const dir = sync()
    expect(dir).toBe(path.join(root, 'conn-1'))
    for (const name of ['sessions', 'extensions']) {
      const target = path.join(dir, name)
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(target)).toBe(path.join(home, name))
    }
    expect(fs.lstatSync(path.join(dir, 'models.json')).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(
      ['extensions', 'models.json', 'sessions', 'settings.json'].sort()
    )
  })

  it('both credentials: the stored one stays out, models.json names the variable', () => {
    const dir = sync()
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(false)
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'))
    // The person's own entry kept under the connection's key; theirs untouched.
    expect(models.providers.deepseek).toEqual({
      baseUrl: 'https://made-up.invalid/v1',
      apiKey: '$DEEPSEEK_API_KEY'
    })
    expect(models.providers.mine).toEqual({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '$MINE' })
  })

  it('takes out an auth.json found in the directory (a link, or one Pi wrote)', () => {
    const dir = sync()
    fs.symlinkSync(path.join(home, 'auth.json'), path.join(dir, 'auth.json'))
    sync()
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(false)
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}')
    sync()
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(false)
  })

  it("never changes the person's own files", () => {
    const before = snapshot(home)
    sync()
    sync({ apiKey: '$OTHER' }, 'mine')
    expect(snapshot(home)).toEqual(before)
  })

  it('is idempotent', () => {
    const dir = sync()
    const first = snapshot(dir)
    const links = fs
      .readdirSync(dir)
      .map((n) => [n, fs.lstatSync(path.join(dir, n)).isSymbolicLink()])
    expect(sync()).toBe(dir)
    expect(snapshot(dir)).toEqual(first)
    expect(
      fs.readdirSync(dir).map((n) => [n, fs.lstatSync(path.join(dir, n)).isSymbolicLink()])
    ).toEqual(links)
  })

  it('remakes a wrong link and leaves a real entry alone', () => {
    const dir = sync()
    fs.unlinkSync(path.join(dir, 'sessions'))
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dir, 'sessions'))
    fs.unlinkSync(path.join(dir, 'extensions'))
    fs.writeFileSync(path.join(dir, 'extensions'), 'own')
    sync()
    expect(fs.readlinkSync(path.join(dir, 'sessions'))).toBe(path.join(home, 'sessions'))
    expect(fs.readFileSync(path.join(dir, 'extensions'), 'utf8')).toBe('own')
  })

  // Lane C of the harness wave (PRDCT-4496), N3: a default provider or model
  // Pi saves in a connection tab never lands in the person's own settings.
  describe('settings.json is a copy, never a link (N3)', () => {
    const own = '{"theme":"dark"}\n'

    it("copies the person's settings as they are, readable by its owner alone", () => {
      const dir = sync()
      const copy = path.join(dir, 'settings.json')
      expect(fs.lstatSync(copy).isFile()).toBe(true)
      expect(fs.readFileSync(copy, 'utf8')).toBe(own)
      expect(fs.statSync(copy).mode & 0o777).toBe(0o600)
    })

    it("keeps the person's settings.json byte-identical after a write into the copy", () => {
      const dir = sync()
      const before = fs.readFileSync(path.join(home, 'settings.json'))
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        '{"defaultProvider":"deepseek","defaultModel":"made-up-model"}\n'
      )
      expect(fs.readFileSync(path.join(home, 'settings.json')).equals(before)).toBe(true)
      // The next sync puts the person's settings back in the copy.
      sync()
      expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(own)
      expect(fs.readFileSync(path.join(home, 'settings.json')).equals(before)).toBe(true)
    })

    it('replaces a stale link to the person’s settings with the copy', () => {
      const dir = sync()
      const copy = path.join(dir, 'settings.json')
      fs.unlinkSync(copy)
      fs.symlinkSync(path.join(home, 'settings.json'), copy)
      fs.chmodSync(path.join(home, 'settings.json'), 0o644)
      sync()
      expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(copy, 'utf8')).toBe(own)
      expect(fs.statSync(copy).mode & 0o777).toBe(0o600)
      // The person's own file keeps its mode: the copy was never written through the link.
      expect(fs.statSync(path.join(home, 'settings.json')).mode & 0o777).toBe(0o644)
    })

    it('has no settings.json when the person has none, and drops a copy left from before', () => {
      const dir = sync()
      fs.rmSync(path.join(home, 'settings.json'))
      sync()
      // Neither a file nor a link (a dangling one included) is left there.
      expect(fs.readdirSync(dir)).not.toContain('settings.json')
    })
  })

  it('a missing home gives a directory with models.json alone', () => {
    fs.rmSync(home, { recursive: true, force: true })
    const dir = sync()
    expect(fs.readdirSync(dir)).toEqual(['models.json'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'))).toEqual({
      providers: { deepseek: { apiKey: '$DEEPSEEK_API_KEY' } }
    })
  })

  it('writes models.json readable by its owner alone', () => {
    const dir = sync()
    fs.chmodSync(path.join(dir, 'models.json'), 0o644)
    sync()
    expect(fs.statSync(path.join(dir, 'models.json')).mode & 0o777).toBe(0o600)
  })

  it('refuses a connection id that is not one path segment', () => {
    for (const connectionId of ['', '..', 'a/b'])
      expect(() =>
        syncPiConnectionDir({
          root,
          homeAgentDir: home,
          connectionId,
          providerId: 'x',
          entry: { apiKey: '$X' }
        })
      ).toThrow('The connection id cannot name a directory.')
  })
})
