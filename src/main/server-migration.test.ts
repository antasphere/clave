/**
 * The one-time migration of the app's data into its separate server's
 * (PRDCT-3434, the second pull request), over two fake secret adapters: the
 * app's opens what it sealed (`app:` + base64), the server's seals its own
 * way (`kc:` + a counter), so what is pinned is the carrying, never a real
 * keychain. The real adapters are `ports/electron.ts` and `ports/secrets.ts`,
 * tested on their own.
 */
import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  existsSync,
  readlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ANTASPHERE_SESSION_FILE,
  CLAUDE_CREDENTIALS_FILE,
  CODEX_HOMES_DIR,
  MIGRATION_MARKER,
  migrateAppDataToServer
} from './server-migration'

const appSeal = (plain: string): string => `app:${Buffer.from(plain).toString('base64')}`
const from = {
  open: (sealed: string) =>
    sealed.startsWith('app:') ? Buffer.from(sealed.slice(4), 'base64').toString() : undefined
}
const server = (): {
  sealed: string[]
  to: { available: () => boolean; seal: (p: string) => string }
} => {
  const sealed: string[] = []
  return {
    sealed,
    to: {
      available: () => true,
      seal: (plain) => {
        sealed.push(plain)
        return `kc:${sealed.length}`
      }
    }
  }
}

function dirs(): { app: string; srv: string; clean: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-migration-'))
  const app = path.join(root, 'app')
  const srv = path.join(root, 'app', 'server')
  mkdirSync(app, { recursive: true })
  return { app, srv, clean: () => rmSync(root, { recursive: true, force: true }) }
}

const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf-8'))

describe('the migration of the app data into the server directory', () => {
  it('copies the plain documents with their mode, re-seals the secrets, copies the Codex homes with their symlinks, and writes the marker', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(path.join(app, 'workspace-state.json'), '{"workspaces":[1]}', { mode: 0o644 })
      writeFileSync(path.join(app, 'claude-accounts.json'), '{"v":1}', { mode: 0o600 })
      writeFileSync(
        path.join(app, CLAUDE_CREDENTIALS_FILE),
        JSON.stringify({
          work: { token: appSeal('sk-ant-oat01-work'), setAt: 1 },
          home: { token: appSeal('sk-ant-oat01-home'), setAt: 2, invalidAt: 3 },
          broken: { token: 'kc:somebody-elses', setAt: 4 }
        }),
        { mode: 0o600 }
      )
      writeFileSync(
        path.join(app, ANTASPHERE_SESSION_FILE),
        JSON.stringify({
          v: 1,
          issuer: 'https://i',
          clientId: 'c',
          sealed: appSeal('{"s":1}'),
          savedAt: 9
        })
      )
      const home = path.join(app, CODEX_HOMES_DIR, 'acct')
      mkdirSync(home, { recursive: true })
      writeFileSync(path.join(home, 'auth.json'), '{"t":1}')
      symlinkSync('/somewhere/sessions', path.join(home, 'sessions'))
      const { sealed, to } = server()
      const log: string[] = []
      const report = migrateAppDataToServer({
        appDir: app,
        serverDir: srv,
        from,
        to,
        log: (l) => log.push(l),
        now: () => new Date('2026-10-13T00:00:00Z')
      })
      expect(report.outcome).toBe('migrated')
      expect(report.copied.sort()).toEqual(
        [
          'workspace-state.json',
          'claude-accounts.json',
          CLAUDE_CREDENTIALS_FILE,
          ANTASPHERE_SESSION_FILE,
          CODEX_HOMES_DIR
        ].sort()
      )
      expect(report.kept).toEqual([])
      expect(report.failed).toEqual([])
      // The plain documents, mode kept.
      expect(json(path.join(srv, 'workspace-state.json'))).toEqual({ workspaces: [1] })
      expect(statSync(path.join(srv, 'workspace-state.json')).mode & 0o777).toBe(0o644)
      expect(statSync(path.join(srv, 'claude-accounts.json')).mode & 0o777).toBe(0o600)
      // The tokens re-sealed, in memory only: the server's file holds the new
      // opaque strings and the rest of each credential; the one the app
      // could not open is left out and named.
      expect(sealed).toEqual(['sk-ant-oat01-work', 'sk-ant-oat01-home', '{"s":1}'])
      expect(json(path.join(srv, CLAUDE_CREDENTIALS_FILE))).toEqual({
        work: { token: 'kc:1', setAt: 1 },
        home: { token: 'kc:2', setAt: 2, invalidAt: 3 }
      })
      expect(statSync(path.join(srv, CLAUDE_CREDENTIALS_FILE)).mode & 0o777).toBe(0o600)
      expect(report.resealed).toEqual({ claude: 2, antasphere: true })
      expect(report.unopened).toEqual(['claude:broken'])
      expect(json(path.join(srv, ANTASPHERE_SESSION_FILE))).toEqual({
        v: 1,
        issuer: 'https://i',
        clientId: 'c',
        sealed: 'kc:3',
        savedAt: 9
      })
      // No plaintext token on disk anywhere under the server directory.
      for (const name of [CLAUDE_CREDENTIALS_FILE, ANTASPHERE_SESSION_FILE, MIGRATION_MARKER])
        expect(readFileSync(path.join(srv, name), 'utf-8')).not.toMatch(/sk-ant-oat01|"s":1/)
      // The Codex home, its symlink a symlink still.
      expect(json(path.join(srv, CODEX_HOMES_DIR, 'acct', 'auth.json'))).toEqual({ t: 1 })
      expect(lstatSync(path.join(srv, CODEX_HOMES_DIR, 'acct', 'sessions')).isSymbolicLink()).toBe(
        true
      )
      expect(readlinkSync(path.join(srv, CODEX_HOMES_DIR, 'acct', 'sessions'))).toBe(
        '/somewhere/sessions'
      )
      expect(report.codexHomes).toBe(1)
      // The marker, and the app's own files untouched.
      expect(json(path.join(srv, MIGRATION_MARKER))).toMatchObject({
        v: 1,
        at: '2026-10-13T00:00:00.000Z',
        outcome: 'migrated',
        resealed: { claude: 2, antasphere: true },
        unopened: ['claude:broken']
      })
      expect(json(path.join(app, CLAUDE_CREDENTIALS_FILE))).toMatchObject({
        work: { token: appSeal('sk-ant-oat01-work') }
      })
      expect(log.join('\n')).toMatch(
        /5 document\(s\) copied, 0 kept, 2 Claude token\(s\) re-sealed, the Antasphere session re-sealed, not opened here: claude:broken, 1 Codex home\(s\)/
      )
    } finally {
      clean()
    }
  })

  it('is done once: the marker stops a second run, and a document the server already has is kept', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(path.join(app, 'preferences.json'), '{"theme":"dark"}')
      mkdirSync(srv, { recursive: true })
      writeFileSync(path.join(srv, 'preferences.json'), '{"theme":"light"}')
      const first = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(first.outcome).toBe('migrated')
      expect(first.kept).toEqual(['preferences.json'])
      expect(first.copied).toEqual([])
      expect(json(path.join(srv, 'preferences.json'))).toEqual({ theme: 'light' })
      const second = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(second.outcome).toBe('already')
      expect(second.copied).toEqual([])
    } finally {
      clean()
    }
  })

  it('an app with no data of its own writes the marker and migrates nothing', () => {
    const { app, srv, clean } = dirs()
    try {
      const report = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(report.outcome).toBe('nothing')
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(true)
      expect(json(path.join(srv, MIGRATION_MARKER))).toMatchObject({ outcome: 'nothing' })
    } finally {
      clean()
    }
  })

  it('a step that fails writes no marker, and the next run resumes where it stopped', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(path.join(app, 'workspace-state.json'), '{"w":1}')
      writeFileSync(
        path.join(app, CLAUDE_CREDENTIALS_FILE),
        JSON.stringify({ work: { token: appSeal('t'), setAt: 1 } })
      )
      const refusing = {
        available: () => true,
        seal: () => {
          throw new Error('The macOS Keychain is unavailable here.')
        }
      }
      const log: string[] = []
      const first = migrateAppDataToServer({
        appDir: app,
        serverDir: srv,
        from,
        to: refusing,
        log: (l) => log.push(l)
      })
      expect(first.outcome).toBe('migrated')
      expect(first.copied).toEqual(['workspace-state.json'])
      expect(first.failed).toEqual([
        `${CLAUDE_CREDENTIALS_FILE}: The macOS Keychain is unavailable here.`
      ])
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(false)
      expect(existsSync(path.join(srv, CLAUDE_CREDENTIALS_FILE))).toBe(false)
      expect(log.some((l) => /tried again at the next start/.test(l))).toBe(true)
      const { sealed, to } = server()
      const second = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to })
      expect(second.kept).toEqual(['workspace-state.json'])
      expect(second.copied).toEqual([CLAUDE_CREDENTIALS_FILE])
      expect(sealed).toEqual(['t'])
      expect(second.failed).toEqual([])
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(true)
    } finally {
      clean()
    }
  })

  it('a server adapter that cannot seal fails the secret step: nothing dropped, no marker, the rest copied', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(path.join(app, 'preferences.json'), '{"p":1}')
      writeFileSync(
        path.join(app, CLAUDE_CREDENTIALS_FILE),
        JSON.stringify({ work: { token: appSeal('t'), setAt: 1 } })
      )
      writeFileSync(
        path.join(app, ANTASPHERE_SESSION_FILE),
        JSON.stringify({ v: 1, revoked: true })
      )
      const report = migrateAppDataToServer({
        appDir: app,
        serverDir: srv,
        from,
        to: { available: () => false, seal: () => 'never' }
      })
      // The token is not dropped as "not opened" and the marker not written,
      // so a later boot on a machine that can seal still carries it.
      expect(report.unopened).toEqual([])
      expect(report.failed).toEqual([
        `${CLAUDE_CREDENTIALS_FILE}: the server cannot seal a secret on this machine`
      ])
      expect(existsSync(path.join(srv, CLAUDE_CREDENTIALS_FILE))).toBe(false)
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(false)
      // A revoked session has nothing to re-seal and is copied as it is.
      expect(json(path.join(srv, ANTASPHERE_SESSION_FILE))).toEqual({ v: 1, revoked: true })
      expect(json(path.join(srv, 'preferences.json'))).toEqual({ p: 1 })
    } finally {
      clean()
    }
  })

  it('a seal that throws half way discards the items it filed before, so a retry leaves no orphan', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(
        path.join(app, CLAUDE_CREDENTIALS_FILE),
        JSON.stringify({
          a: { token: appSeal('first'), setAt: 1 },
          b: { token: appSeal('second'), setAt: 2 }
        })
      )
      const filed = new Set<string>()
      let calls = 0
      const flaky = {
        available: () => true,
        seal: (plain: string) => {
          calls += 1
          if (calls === 2) throw new Error('the Keychain refused the item')
          const handle = `kc:${plain}`
          filed.add(handle)
          return handle
        },
        discard: (sealed: string) => {
          filed.delete(sealed)
        }
      }
      const first = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: flaky })
      expect(first.failed).toEqual([`${CLAUDE_CREDENTIALS_FILE}: the Keychain refused the item`])
      expect(filed.size).toBe(0)
      expect(existsSync(path.join(srv, CLAUDE_CREDENTIALS_FILE))).toBe(false)
      const second = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: flaky })
      expect(second.failed).toEqual([])
      expect([...filed].sort()).toEqual(['kc:first', 'kc:second'])
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(true)
    } finally {
      clean()
    }
  })

  it('a Codex homes copy that fails half way is copied again whole at the next run', () => {
    const { app, srv, clean } = dirs()
    try {
      const a = path.join(app, CODEX_HOMES_DIR, 'a')
      const b = path.join(app, CODEX_HOMES_DIR, 'b')
      mkdirSync(a, { recursive: true })
      mkdirSync(b, { recursive: true })
      writeFileSync(path.join(a, 'auth.json'), '{"a":1}')
      writeFileSync(path.join(b, 'auth.json'), '{"b":1}')
      chmodSync(path.join(b, 'auth.json'), 0o000)
      const first = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(first.failed.some((f) => f.startsWith(`${CODEX_HOMES_DIR}:`))).toBe(true)
      expect(existsSync(path.join(srv, CODEX_HOMES_DIR))).toBe(false)
      expect(existsSync(path.join(srv, MIGRATION_MARKER))).toBe(false)
      chmodSync(path.join(b, 'auth.json'), 0o600)
      const second = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(second.failed).toEqual([])
      expect(second.copied).toContain(CODEX_HOMES_DIR)
      expect(json(path.join(srv, CODEX_HOMES_DIR, 'b', 'auth.json'))).toEqual({ b: 1 })
      expect(existsSync(path.join(srv, `${CODEX_HOMES_DIR}.partial`))).toBe(false)
    } finally {
      clean()
    }
  })
  it('the Antasphere session whose write fails discards the item it filed', () => {
    const { app, srv, clean } = dirs()
    try {
      writeFileSync(
        path.join(app, ANTASPHERE_SESSION_FILE),
        JSON.stringify({
          v: 1,
          issuer: 'https://i',
          clientId: 'c',
          sealed: appSeal('{"s":1}'),
          savedAt: 1
        })
      )
      // The server's folder made read-only, so the write throws after the seal.
      mkdirSync(srv, { recursive: true })
      const filed = new Set<string>()
      const to = {
        available: () => true,
        seal: (plain: string) => {
          const h = `kc:${plain}`
          filed.add(h)
          return h
        },
        discard: (sealed: string) => {
          filed.delete(sealed)
        }
      }
      chmodSync(srv, 0o500)
      const report = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to })
      chmodSync(srv, 0o700)
      expect(report.failed.some((f) => f.startsWith(`${ANTASPHERE_SESSION_FILE}:`))).toBe(true)
      expect(filed.size).toBe(0)
      expect(report.resealed.antasphere).toBe(false)
    } finally {
      chmodSync(srv, 0o700)
      clean()
    }
  })

  it('a stale partial Codex copy from a killed run is cleared before the next copy', () => {
    const { app, srv, clean } = dirs()
    try {
      mkdirSync(path.join(app, CODEX_HOMES_DIR, 'a'), { recursive: true })
      writeFileSync(path.join(app, CODEX_HOMES_DIR, 'a', 'auth.json'), '{"a":1}')
      // What a run killed mid-copy leaves: a partial folder with a stray file.
      mkdirSync(path.join(srv, `${CODEX_HOMES_DIR}.partial`, 'gone'), { recursive: true })
      writeFileSync(path.join(srv, `${CODEX_HOMES_DIR}.partial`, 'gone', 'auth.json'), '{"gone":1}')
      const report = migrateAppDataToServer({ appDir: app, serverDir: srv, from, to: server().to })
      expect(report.failed).toEqual([])
      expect(existsSync(path.join(srv, CODEX_HOMES_DIR, 'gone'))).toBe(false)
      expect(json(path.join(srv, CODEX_HOMES_DIR, 'a', 'auth.json'))).toEqual({ a: 1 })
    } finally {
      clean()
    }
  })
})
