import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLedger, emptyTally } from './ledger'
import { newCursor } from './reader'
import { Store, isSessionRow } from './store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-store-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const row = (id: string): Record<string, unknown> => ({
  id,
  provider: 'claude',
  providerSessionId: `p-${id}`,
  cwd: '/work',
  name: id,
  model: null,
  state: 'idle',
  group: null,
  workspaceId: null,
  createdAt: 1,
  seenAt: '2026-10-02T10:00:00.000Z',
  root: { tally: emptyTally(), file: newCursor(`/x/${id}.jsonl`) },
  subagents: [],
  stateSpans: []
})

describe('Store', () => {
  it('writes the ledger to a temporary file and renames it over the old one', () => {
    const calls: string[] = []
    const fs = {
      ...nodeFs,
      writeFileSync: ((file: string, data: string) => {
        calls.push(`write ${file}`)
        nodeFs.writeFileSync(file, data)
      }) as typeof nodeFs.writeFileSync,
      renameSync: ((from: string, to: string) => {
        calls.push(`rename ${from} -> ${to}`)
        nodeFs.renameSync(from, to)
      }) as typeof nodeFs.renameSync
    }
    const store = new Store(dir, () => {}, fs)
    store.writeLedger(emptyLedger(15, new Date('2026-10-02T10:00:00.000Z')))
    const file = join(dir, 'ledger.json')
    expect(calls).toEqual([`write ${file}.tmp`, `rename ${file}.tmp -> ${file}`])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 2, gapMinutes: 15 })
  })

  it('reloads the rows it can draw and leaves a malformed one out, with one warning', () => {
    const warnings: string[] = []
    const ledger = emptyLedger(15, new Date('2026-10-02T10:00:00.000Z'))
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({ ...ledger, sessions: { a: row('a'), x: { id: 'x', name: 'x' } } })
    )
    const store = new Store(dir, (level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    const loaded = store.readLedger(15)
    expect(Object.keys(loaded.sessions)).toEqual(['a'])
    expect(warnings).toHaveLength(1)
    expect(isSessionRow(row('a'))).toBe(true)
    expect(isSessionRow({ id: 'x', name: 'x' })).toBe(false)
  })

  it('starts from an empty ledger when the file is missing or unreadable', () => {
    expect(new Store(dir).readLedger(15).sessions).toEqual({})
    writeFileSync(join(dir, 'ledger.json'), '{not json')
    expect(new Store(dir).readLedger(15).sessions).toEqual({})
  })
  it('leaves out a row whose tally or cursor is not whole, so no page is blanked by it', () => {
    const warnings: string[] = []
    const ledger = emptyLedger(15, new Date('2026-10-02T10:00:00.000Z'))
    const hollow = { ...row('h'), root: { tally: {}, file: {} } }
    const halfSub = { ...row('s'), subagents: [{ id: 'x', tally: emptyTally(), file: {} }] }
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({ ...ledger, sessions: { a: row('a'), h: hollow, s: halfSub } })
    )
    const store = new Store(dir, (level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    expect(Object.keys(store.readLedger(15).sessions)).toEqual(['a'])
    expect(warnings).toEqual([expect.stringContaining('2 row(s)')])
  })

  it('counts the transcripts again rather than read a ledger of an earlier version', () => {
    const warnings: string[] = []
    const ledger = { ...emptyLedger(15, new Date('2026-10-02T10:00:00.000Z')), v: 1 }
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({ ...ledger, sessions: { a: row('a') } })
    )
    const store = new Store(dir, (level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    expect(store.readLedger(15).sessions).toEqual({})
    expect(warnings).toEqual([expect.stringContaining('version 1')])
  })
})
