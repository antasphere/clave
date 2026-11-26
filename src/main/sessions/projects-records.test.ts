import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Schema } from 'effect'
import { SessionRecord as WireRecord } from '@clave/contract/sessions'
import type { TabProjects } from '@clave/contract/tab-projects-rules'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import type { TerminalPort } from '../ports/terminal'
import { electronTestPorts, tempDataDir } from '../ports/testing'
import { PtyBackend, SESSION_RECORDS_FOLDER, type SessionRecord } from './adapters/pty-backend'
import { ptyManager } from '../pty-manager'
import { restartSession } from './lifecycle'

/**
 * Which projects a tab works on lives on its record (PRDCT-5179), the way its
 * work does (`work-records.test.ts`), and the record is rewritten from
 * scratch at every adoption, respawn and restart: a field the spawn does not
 * carry forward is lost at the next one, silently. Over the real backend and
 * the real manager on a temp directory; no process is ever started.
 */
vi.mock('electron', () => {
  throw new Error('the session records imported electron')
})
process.env.SHELL = '/bin/sh'

const noProcesses: TerminalPort = {
  spawn: () => {
    throw new Error('this suite starts no process')
  }
}

let dir: string
const cwd = fs.realpathSync(tempDataDir('clave-projects-cwd-'))
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

const quill: TabProjects = {
  status: 'decided',
  picks: [{ file: '/w/quill/.clave/workspaces/default.clave', name: 'Quill', p: 0.95 }],
  fits: 0.92,
  readAt: 1_000,
  model: 'jev-1.14.0',
  basis: 'basis-quill'
}
const torn: TabProjects = {
  status: 'undecided',
  picks: [
    { file: '/w/quill/.clave/workspaces/default.clave', name: 'Quill', p: 0.5 },
    { file: '/w/atlas/.clave/workspaces/default.clave', name: 'Atlas', p: 0.3 }
  ],
  fits: 0.8,
  readAt: 2_000,
  model: 'jev-1.14.0',
  basis: 'basis-torn'
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

describe('a tab’s reading on its record', () => {
  it('is written and read back, kept by the other setters, and cleared with null', () => {
    const backend = new PtyBackend()
    const session = backend.spawn(cwd, plain)
    expect(backend.setSessionProjects(session.id, quill)).toBe(true)
    expect(readRecord(session.id).projects).toEqual(quill)
    expect(backend.getSessionRecord(session.id)?.projects).toEqual(quill)
    backend.setSessionDisplayName(session.id, 'Quill', true)
    backend.setSessionWork(session.id, null)
    expect(readRecord(session.id).projects).toEqual(quill)
    expect(backend.setSessionProjects(session.id, null)).toBe(true)
    expect(readRecord(session.id)).not.toHaveProperty('projects')
    expect(backend.setSessionProjects('33333333-3333-4333-8333-333333333333', quill)).toBe(false)
  })

  it('is kept across a quit and an adoption; a restart’s own wins over the record’s', () => {
    const backend = new PtyBackend()
    const session = backend.spawn(cwd, plain)
    backend.setSessionProjects(session.id, quill)
    backend.kill(session.id, false)
    expect(backend.listAdoptableSessions().find((r) => r.id === session.id)?.projects).toEqual(
      quill
    )
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id })
    expect(readRecord(session.id).projects).toEqual(quill)
    backend.kill(session.id, false)
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id, projects: torn })
    expect(readRecord(session.id).projects).toEqual(torn)
    // A spawn's reading that is not whole is dropped, never coerced.
    backend.kill(session.id, false)
    const broken = { ...quill, status: 'maybe' } as unknown as TabProjects
    backend.spawn(cwd, { ...plain, adoptSessionId: session.id, projects: broken })
    expect(readRecord(session.id).projects).toEqual(torn)
  })

  it('a record whose reading is malformed still loads whole, without it', () => {
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
        projects: { ...quill, picks: [] }
      })
    )
    fs.writeFileSync(
      recordFile(kept),
      JSON.stringify({ id: kept, cwd, folderName: 'y', ...modes, projects: { ...quill, extra: 1 } })
    )
    const byId = backend.getSessionRecord(broken)
    expect(byId).toMatchObject({ id: broken, folderName: 'x' })
    expect(byId).not.toHaveProperty('projects')
    const listed = backend.listAdoptableSessions()
    expect(listed.find((r) => r.id === broken)).not.toHaveProperty('projects')
    expect(listed.find((r) => r.id === kept)?.projects).toEqual(quill)
    for (const record of listed)
      expect(() => Schema.decodeUnknownSync(WireRecord)(record)).not.toThrow()
  })
})

describe('a restart carries the reading', () => {
  it('restartSpawn reads it off the record, never off the spawn’s own options', async () => {
    const id = await spawn()
    expect(ptyManager.setSessionProjects(id, quill)).toBe(true)
    expect(ptyManager.restartSpawn(id, {})?.options.projects).toEqual(quill)
    const restarted = await spawn({ projects: quill })
    expect(ptyManager.getSessionRecord(restarted)?.projects).toEqual(quill)
    ptyManager.setSessionProjects(restarted, torn)
    expect(ptyManager.restartSpawn(restarted, {})?.options.projects).toEqual(torn)
    ptyManager.setSessionProjects(restarted, null)
    expect(ptyManager.restartSpawn(restarted, {})?.options.projects).toBeUndefined()
  })

  it('the restart itself: the kill takes the record, the new one has the reading again', async () => {
    const id = await spawn()
    ptyManager.setSessionProjects(id, quill)
    const info = await restartSession(id, {})
    expect(info.id).toBe(id)
    expect(readRecord(id).projects).toEqual(quill)
  })
})
