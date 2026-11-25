import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NestRefusal, NestSessionUnknown } from '@clave/contract/nest-rules'
import type { WorkAssignment } from '@clave/contract/work-rules'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import type { TerminalPort } from '../ports/terminal'
import { electronTestPorts, tempDataDir } from '../ports/testing'
import { PtyBackend, SESSION_RECORDS_FOLDER, type SessionRecord } from './adapters/pty-backend'
import { ptyManager } from '../pty-manager'
import { sessionManager } from './session-manager'
import { createSessionHost } from './host'
import { sessionRecords } from './records'

/**
 * Which tab a tab is nested under lives on its record, as `spawnedBy`
 * (PRDCT-4997), and the server's NestSession rewrites it through the host's
 * `nest`. These hold the write for a terminal and for a chat, the clear, and
 * the respawn that must read the record's link and never the spawn's own,
 * over the real backend, the real manager and the real host on a temp
 * directory behind the storage port, on the harness of `work-records.test.ts`.
 * No process is ever started, and every spawn names `tmuxMode: false`.
 */
vi.mock('electron', () => {
  throw new Error('the session records imported electron')
})
// The backend reads the login shell's environment through the user's shell.
process.env.SHELL = '/bin/sh'

const noProcesses: TerminalPort = {
  spawn: () => {
    throw new Error('this suite starts no process')
  }
}

let dir: string
const cwd = fs.realpathSync(tempDataDir('clave-nest-cwd-'))
const plain = { claudeMode: false, tmuxMode: false } as const
const spawned: string[] = []

const recordFile = (key: string): string => path.join(dir, SESSION_RECORDS_FOLDER, `${key}.json`)
const readRecord = (key: string): SessionRecord =>
  JSON.parse(fs.readFileSync(recordFile(key), 'utf-8')) as SessionRecord
const spawn = async (options: Parameters<typeof ptyManager.spawn>[1] = {}): Promise<string> => {
  const session = await ptyManager.spawn(cwd, { ...plain, ...options })
  spawned.push(session.id)
  return session.id
}
const modes = {
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false
}
const writeRecordFile = (record: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(dir, SESSION_RECORDS_FOLDER), { recursive: true })
  fs.writeFileSync(recordFile(String(record.id)), JSON.stringify(record))
}

const lead: WorkAssignment = {
  unit: 'stable-wave/lane-a',
  kind: 'lane',
  label: 'Lane A',
  role: 'lead',
  standing: 'current',
  joinedAt: 1_000,
  since: 1_000
}

beforeEach(() => {
  dir = tempDataDir()
  installSettingsPorts(electronTestPorts(dir))
  installTerminalPorts({ storage: fileStorage(dir), terminals: noProcesses })
})
afterEach(async () => {
  for (const id of spawned.splice(0)) await ptyManager.kill(id, true)
  resetTerminalPorts()
  resetSettingsPorts()
})

const host = createSessionHost({
  manager: sessionManager,
  lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() },
  records: sessionRecords
})

describe('the host’s nesting (NestSession) on a terminal’s record', () => {
  it('writes spawnedBy on a nest, clears it on a detach, and leaves openedBy alone', async () => {
    const parent = await spawn()
    const opener = await spawn()
    const child = await spawn({ openedBy: opener })
    expect(host.nest(child, parent)).toEqual({ id: child, under: parent, changed: true })
    expect(readRecord(child).spawnedBy).toBe(parent)
    expect(readRecord(child).openedBy).toBe(opener)
    // The same link again changes nothing, and says so.
    expect(host.nest(child, parent).changed).toBe(false)
    expect(host.nest(child, null)).toEqual({ id: child, under: null, changed: true })
    expect(readRecord(child)).not.toHaveProperty('spawnedBy')
    expect(readRecord(child).openedBy).toBe(opener)
  })

  it('a respawn after a detach carries no parent, and after a nest the new one', async () => {
    const opener = await spawn()
    const other = await spawn()
    // Opened nested: the spawn's own options carry the link.
    const child = await spawn({ spawnedBy: opener, openedBy: opener })
    expect(readRecord(child).spawnedBy).toBe(opener)
    host.nest(child, null)
    const detached = ptyManager.restartSpawn(child, {})?.options
    expect(detached?.spawnedBy).toBeUndefined()
    expect(detached?.openedBy).toBe(opener)
    host.nest(child, other)
    expect(ptyManager.restartSpawn(child, {})?.options.spawnedBy).toBe(other)
  })

  it('the record wins over a spawn that still names the old parent', async () => {
    const opener = await spawn()
    const child = await spawn({ spawnedBy: opener })
    // The record changed under the manager (another writer of the record,
    // a backend's own write): the respawn reads the record, not the spawn.
    new PtyBackend().setSessionSpawnedBy(child, null)
    expect(ptyManager.restartSpawn(child, {})?.options.spawnedBy).toBeUndefined()
  })

  it('refuses in words, writing nothing, when the session keeps no record', async () => {
    const parent = await spawn()
    const bare = await spawn()
    fs.rmSync(recordFile(bare))
    expect(() => host.nest(bare, parent)).toThrow(NestRefusal)
    expect(() => host.nest(bare, parent)).toThrow(
      'This session keeps no record, so where it is nested cannot be kept'
    )
    expect(fs.existsSync(recordFile(bare))).toBe(false)
    expect(() => host.nest('77777777-7777-4777-8777-777777777777', parent)).toThrow(
      NestSessionUnknown
    )
  })
})

describe('the host’s nesting on a chat’s record, which only its id keys', () => {
  it('writes and clears spawnedBy on the chat record', async () => {
    const parent = await spawn()
    const id = '55555555-5555-4555-8555-555555555555'
    new PtyBackend().writeEventSessionRecord({
      id,
      adapterId: 'claude-chat',
      transport: 'events',
      cwd,
      folderName: 'x',
      ...modes,
      claudeMode: true
    })
    expect(host.nest(id, parent)).toEqual({ id, under: parent, changed: true })
    expect(readRecord(id).spawnedBy).toBe(parent)
    expect(host.nest(id, null).changed).toBe(true)
    expect(readRecord(id)).not.toHaveProperty('spawnedBy')
  })
})

describe('listNestRecords', () => {
  it('reads the link, marks a linked record hidden and reads the work', () => {
    const parent = '11111111-1111-4111-8111-111111111111'
    const child = '22222222-2222-4222-8222-222222222222'
    const page = '33333333-3333-4333-8333-333333333333'
    const worker = '44444444-4444-4444-8444-444444444444'
    writeRecordFile({
      id: parent,
      cwd,
      folderName: 'p',
      ...modes,
      workspaceId: 'ws',
      windowKey: 'w1'
    })
    writeRecordFile({ id: child, cwd, folderName: 'c', ...modes, spawnedBy: parent })
    writeRecordFile({
      id: page,
      cwd,
      folderName: 'v',
      ...modes,
      link: { kind: 'session-view', ownerId: parent },
      spawnedBy: 'not-a-session-id'
    })
    writeRecordFile({ id: worker, cwd, folderName: 'w', ...modes, work: lead })
    const byId = new Map(new PtyBackend().listNestRecords().map((r) => [r.id, r]))
    expect(byId.get(parent)).toEqual({
      id: parent,
      under: null,
      workspaceId: 'ws',
      windowKey: 'w1'
    })
    expect(byId.get(child)).toMatchObject({ id: child, under: parent })
    expect(byId.get(child)).not.toHaveProperty('hidden')
    expect(byId.get(page)).toMatchObject({ id: page, under: null, hidden: true })
    expect(byId.get(worker)?.work).toEqual({ label: 'Lane A', kind: 'lane' })
  })
})
