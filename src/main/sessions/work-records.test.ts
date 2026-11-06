import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Schema } from 'effect'
import { SessionNotFound, SessionRecord as WireRecord } from '@clave/contract/sessions'
import { WorkChangeRefusal, type WorkAssignment } from '@clave/contract/work-rules'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import type { TerminalPort } from '../ports/terminal'
import { electronTestPorts, tempDataDir } from '../ports/testing'
import { PtyBackend, SESSION_RECORDS_FOLDER, type SessionRecord } from './adapters/pty-backend'
import { ptyManager } from '../pty-manager'
import { sessionManager } from './session-manager'
import { createSessionHost } from './host'
import { restartSession } from './lifecycle'
import { sessionRecords } from './records'

/**
 * Which work a session does lives on its record (PRDCT-4123), and the record
 * is rewritten from scratch at every adoption, respawn and restart: a field
 * the spawn does not carry forward is lost at the next one, silently. These
 * hold the carry the way #259 holds the parent's, over the real backend, the
 * real manager and the real host on a temp directory behind the storage
 * port. No process is ever started, and every spawn names `tmuxMode: false`
 * so the suite never reaches a tmux server.
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
const cwd = fs.realpathSync(tempDataDir('clave-work-cwd-'))
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

const lead: WorkAssignment = {
  unit: 'stable-wave/lane-a',
  kind: 'lane',
  label: 'Lane A',
  wave: 'stable-wave',
  waveLabel: 'Stable waves',
  role: 'lead',
  standing: 'current',
  joinedAt: 1_000,
  since: 1_000
}
const superseded: WorkAssignment = { ...lead, standing: 'superseded', since: 2_000 }

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

describe('a session’s work on its record', () => {
  it('is written and read back, kept by the other setters, and cleared with null', () => {
    const backend = new PtyBackend()
    const session = backend.spawn(cwd, plain)
    expect(backend.setSessionWork(session.id, lead)).toBe(true)
    expect(readRecord(session.id).work).toEqual(lead)
    expect(backend.getSessionRecord(session.id)?.work).toEqual(lead)
    // Every setter rewrites the record from itself: the work stays.
    backend.setSessionDisplayName(session.id, 'Lead', true)
    backend.setSessionViewRecord(session.id, { url: 'http://127.0.0.1:4720' })
    expect(readRecord(session.id).work).toEqual(lead)
    expect(backend.setSessionWork(session.id, null)).toBe(true)
    expect(readRecord(session.id)).not.toHaveProperty('work')
    // No record, nothing written, and the caller is told.
    expect(backend.setSessionWork('33333333-3333-4333-8333-333333333333', lead)).toBe(false)
  })

  it('reaches a chat tab’s record, which only its id keys', () => {
    const backend = new PtyBackend()
    const id = '55555555-5555-4555-8555-555555555555'
    backend.writeEventSessionRecord({
      id,
      adapterId: 'claude-chat',
      transport: 'events',
      cwd,
      folderName: 'x',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    })
    expect(backend.setSessionWork(id, lead)).toBe(true)
    expect(backend.getSessionRecord(id)?.work).toEqual(lead)
  })

  it('is kept across a quit and an adoption; a restart’s own wins over the record’s', () => {
    const backend = new PtyBackend()
    const session = backend.spawn(cwd, plain)
    backend.setSessionWork(session.id, lead)
    backend.kill(session.id, false)
    expect(backend.listAdoptableSessions().find((r) => r.id === session.id)?.work).toEqual(lead)
    // An adoption names no work of its own: the record's is carried.
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id })
    expect(readRecord(session.id).work).toEqual(lead)
    backend.kill(session.id, false)
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id, work: superseded })
    expect(readRecord(session.id).work).toEqual(superseded)
    // A spawn's work that is not a whole valid one is dropped, never coerced.
    backend.kill(session.id, false)
    const broken = { ...lead, standing: 'unresolved' } as unknown as WorkAssignment
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id, work: broken })
    expect(readRecord(session.id).work).toEqual(superseded)
  })

  it('a record whose work is malformed still loads whole, without it', () => {
    const backend = new PtyBackend()
    const modes = {
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false
    }
    const broken = '44444444-4444-4444-8444-444444444444'
    const kept = '66666666-6666-4666-8666-666666666666'
    fs.mkdirSync(path.join(dir, SESSION_RECORDS_FOLDER), { recursive: true })
    fs.writeFileSync(
      recordFile(broken),
      JSON.stringify({
        id: broken,
        cwd,
        folderName: 'x',
        ...modes,
        work: { ...lead, unit: '', standing: 'unresolved' }
      })
    )
    fs.writeFileSync(
      recordFile(kept),
      JSON.stringify({ id: kept, cwd, folderName: 'y', ...modes, work: { ...lead, extra: 1 } })
    )
    const byId = backend.getSessionRecord(broken)
    expect(byId).toMatchObject({ id: broken, folderName: 'x' })
    expect(byId).not.toHaveProperty('work')
    const listed = backend.listAdoptableSessions()
    expect(listed.map((r) => r.id).sort()).toEqual([broken, kept])
    expect(listed.find((r) => r.id === broken)).not.toHaveProperty('work')
    // A valid one is kept as the rule keeps it: nothing unknown inside.
    expect(listed.find((r) => r.id === kept)?.work).toEqual(lead)
    // The listing crosses the wire whole.
    for (const record of listed)
      expect(() => Schema.decodeUnknownSync(WireRecord)(record)).not.toThrow()
  })
})

describe('a restart on another account carries the work', () => {
  it('restartSpawn reads it off the record, never off the spawn’s own options', async () => {
    const id = await spawn()
    ptyManager.setSessionWork(id, lead)
    expect(ptyManager.restartSpawn(id, {})?.options.work).toEqual(lead)
    // A spawn a restart made carries a work in its options; a change of work
    // since wrote the record alone, and the next restart reads the record.
    const restarted = await spawn({ work: lead })
    expect(ptyManager.getSessionRecord(restarted)?.work).toEqual(lead)
    ptyManager.setSessionWork(restarted, superseded)
    expect(ptyManager.restartSpawn(restarted, {})?.options.work).toEqual(superseded)
    ptyManager.setSessionWork(restarted, null)
    expect(ptyManager.restartSpawn(restarted, {})?.options.work).toBeUndefined()
  })

  it('the restart itself: the kill takes the record, the new one has the work again', async () => {
    const id = await spawn()
    ptyManager.setSessionWork(id, lead)
    const info = await restartSession(id, {})
    expect(info.id).toBe(id)
    expect(readRecord(id).work).toEqual(lead)
  })
})

describe('the host’s change of work (ChangeSessionWork)', () => {
  const host = createSessionHost({
    manager: sessionManager,
    lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() },
    records: sessionRecords
  })
  const assignLead = {
    type: 'assign',
    work: { unit: 'stable-wave/lane-a', kind: 'lane', label: 'Lane A', role: 'lead' }
  } as const

  it('rewrites both records of an accepted handover, the predecessor’s waiting in a record', async () => {
    const holder = await spawn()
    const successor = await spawn()
    host.changeWork(holder, assignLead)
    expect(host.changeWork(holder, { type: 'offer', to: successor })).toEqual([
      { id: successor, work: expect.objectContaining({ standing: 'pending', from: holder }) }
    ])
    // The holder quits before the successor accepts: its record stays, and
    // the rule still finds it among the records the host keeps.
    await ptyManager.kill(holder, false)
    const updates = host.changeWork(successor, { type: 'accept' })
    expect(updates.map((u) => [u.id, u.work?.standing])).toEqual([
      [successor, 'current'],
      [holder, 'superseded']
    ])
    expect(readRecord(successor).work).toMatchObject({
      unit: 'stable-wave/lane-a',
      role: 'lead',
      standing: 'current',
      from: holder
    })
    expect(readRecord(holder).work).toMatchObject({ role: 'lead', standing: 'superseded' })
  })

  it('refuses in words, writing nothing, when a session keeps no record', async () => {
    const holder = await spawn()
    const bare = await spawn()
    fs.rmSync(recordFile(bare))
    expect(() => host.changeWork(bare, assignLead)).toThrow(WorkChangeRefusal)
    expect(() => host.changeWork(bare, assignLead)).toThrow(
      'This session keeps no record, so its work cannot be kept'
    )
    host.changeWork(holder, assignLead)
    const before = readRecord(holder).work
    expect(() => host.changeWork(holder, { type: 'offer', to: bare })).toThrow(
      `The session ${bare} keeps no record, so its work cannot be kept`
    )
    expect(readRecord(holder).work).toEqual(before)
    // No live session and no record: the declared not-found, which the
    // server answers as such (no live-only check before the host).
    expect(() => host.changeWork('77777777-7777-4777-8777-777777777777', assignLead)).toThrow(
      SessionNotFound
    )
  })
})
