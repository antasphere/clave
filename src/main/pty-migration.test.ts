import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  directory: '',
  alive: true,
  failKill: false,
  calls: [] as string[][]
}))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./agent-state-manager', () => ({ stateFilePath: vi.fn() }))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: vi.fn(),
  writeSessionMcpConfig: vi.fn(),
  deleteSessionMcpConfig: vi.fn()
}))
vi.mock('./workspace-manager', () => ({ workspaceManager: {} }))
vi.mock('./copy-offer-manager', () => ({ dismissSessionOffers: vi.fn() }))
vi.mock('./launch-profile-manager', () => ({ launchProfileManager: {} }))
vi.mock('./claude-accounts', () => ({ claudeAccountsManager: {} }))
vi.mock('child_process', () => ({
  execFileSync: (_command: string, args: string[]) => {
    if (args.includes('list-sessions')) return state.alive ? 'clave-test\n' : ''
    return '/fake/tmux\n'
  },
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void
  ) => {
    state.calls.push(args)
    if (args.includes('kill-session')) {
      if (state.failKill) return callback({ code: 1 }, '', 'permission denied')
      state.alive = false
    }
    if (args.includes('has-session') && !state.alive)
      return callback({ code: 1 }, '', "can't find session: clave-test")
    callback(null, '', '')
  }
}))
import { ptyManager } from './pty-manager'

const id = '11111111-1111-4111-8111-111111111111'
const identity = { sourceId: id, recordKey: 'clave-test', tmuxName: 'clave-test', complete: false }
afterEach(() => {
  if (state.directory) rmSync(state.directory, { recursive: true, force: true })
})
function fixture(): { dir: string; file: string } {
  state.directory = mkdtempSync(join(tmpdir(), 'clave-pty-migration-'))
  state.alive = true
  state.failKill = false
  state.calls = []
  const dir = join(state.directory, 'session-records')
  mkdirSync(dir)
  const file = join(dir, 'clave-test.json')
  writeFileSync(
    file,
    JSON.stringify({ id, tmuxName: 'clave-test', claudeMode: true, cwd: '/project' })
  )
  return { dir, file }
}

test('owned source lookup includes records and exact tmux stop is verified before deletion', async () => {
  const f = fixture()
  expect(ptyManager.readLegacyMigrationRecord(id)?.recordKey).toBe('clave-test')
  await ptyManager.stopAndForgetLegacyRecord(identity)
  expect(state.calls).toEqual([
    ['-L', 'clave', 'has-session', '-t', '=clave-test'],
    ['-L', 'clave', 'kill-session', '-t', '=clave-test'],
    ['-L', 'clave', 'has-session', '-t', '=clave-test']
  ])
  expect(existsSync(f.file)).toBe(false)
  await ptyManager.stopAndForgetLegacyRecord(identity)
  expect(state.calls.filter((args) => args.includes('kill-session'))).toHaveLength(1)
})

test('failed kill retains the owned record and does not match a neighbouring tmux name', async () => {
  const f = fixture()
  state.failKill = true
  await expect(ptyManager.stopAndForgetLegacyRecord(identity)).rejects.toBeDefined()
  expect(existsSync(f.file)).toBe(true)
  expect(state.alive).toBe(true)
  expect(state.calls.every((args) => args.at(-1) === '=clave-test')).toBe(true)
})

test('metadata-only migration tabs persist renames, views and window moves without a PTY', () => {
  const f = fixture()
  expect(ptyManager.getSession(id)).toBeUndefined()
  ptyManager.setSessionDisplayName(id, 'Renamed agent', true)
  ptyManager.setSessionWorkspace(id, 'new-workspace')
  ptyManager.setSessionWindowKey(id, 'new-window')
  ptyManager.setSessionViewRecord(id, { url: 'http://localhost:3000', title: 'Preview' })
  expect(JSON.parse(readFileSync(f.file, 'utf8'))).toMatchObject({
    displayName: 'Renamed agent',
    userRenamed: true,
    workspaceId: 'new-workspace',
    windowKey: 'new-window',
    view: { url: 'http://localhost:3000', title: 'Preview' }
  })
  expect(state.calls).toEqual([])
})

test('linked view records remap idempotently without stopping their serving process', () => {
  const f = fixture()
  const linked = join(f.dir, 'clave-view.json')
  writeFileSync(
    linked,
    JSON.stringify({
      id: 'view',
      tmuxName: 'clave-view',
      link: { kind: 'session-view', ownerId: id }
    })
  )
  ptyManager.remapSessionViewOwner(id, `conversation-${id}`)
  ptyManager.remapSessionViewOwner(id, `conversation-${id}`)
  expect(JSON.parse(readFileSync(linked, 'utf8')).link.ownerId).toBe(`conversation-${id}`)
  expect(state.calls).toEqual([])
})
