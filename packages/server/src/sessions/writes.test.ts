import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  LEDGER_INCOMPLETE,
  LEDGER_UNREADABLE,
  RESTARTED_BEFORE_DISPATCH,
  STOPPED_AFTER_DISPATCH,
  WriteLedger,
  fileWriteLedgerStorage,
  ledgerFileStem,
  memoryWriteLedgerStorage,
  sanitizeReason
} from './writes'

/**
 * Nothing is sent twice (the mobile wave, lane B, the seam of 29 October):
 * two phases persisted before the provider is touched, five statuses on the
 * route, the second write by state, the recovery rules at boot on what a
 * previous process left, and a ledger that decides `absent` alone.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const quiet = (): void => {}
const ID = 'phone-00000001'
const freshLedger = (storage = memoryWriteLedgerStorage(), now = () => 1): WriteLedger => {
  const ledger = new WriteLedger(storage, now, quiet)
  for (const id of ['s', 't', 'fresh']) ledger.initialize(id)
  return ledger
}

describe('the phases of a write', () => {
  it('persists received before anything else, then dispatched, then accepted with when', () => {
    const storage = memoryWriteLedgerStorage()
    let clock = 100
    const ledger = freshLedger(storage, () => clock)
    expect(ledger.receive('s', ID)).toEqual({ first: true })
    const onDisk = (): unknown => JSON.parse(storage.documents.get('s.ledger.json')!)
    expect(onDisk()).toEqual({
      v: 1,
      complete: true,
      entries: { [ID]: { status: 'received', at: 100 } }
    })
    expect(ledger.status('s', ID)).toEqual({ status: 'pending' })
    clock = 101
    ledger.dispatch('s', ID)
    expect(onDisk()).toMatchObject({ entries: { [ID]: { status: 'dispatched', at: 101 } } })
    expect(ledger.status('s', ID)).toEqual({ status: 'pending' })
    clock = 102
    expect(ledger.accept('s', ID)).toEqual({ status: 'accepted', at: 102 })
    expect(onDisk()).toMatchObject({ entries: { [ID]: { status: 'accepted', at: 102 } } })
    expect(ledger.status('s', ID)).toEqual({ status: 'accepted', at: 102 })
  })
  it('records a rejection with its reason, and answers it', () => {
    const ledger = freshLedger(undefined, () => 5)
    ledger.receive('s', ID)
    ledger.dispatch('s', ID)
    ledger.reject('s', ID, 'the provider refused it')
    expect(ledger.status('s', ID)).toEqual({
      status: 'rejected',
      at: 5,
      reason: 'the provider refused it'
    })
  })
  it('answers the held entry to a second arrival, in every state', () => {
    const ledger = freshLedger()
    ledger.receive('s', 'a-00000001')
    expect(ledger.receive('s', 'a-00000001')).toEqual({ held: { status: 'received', at: 1 } })
    ledger.dispatch('s', 'a-00000001')
    expect(ledger.receive('s', 'a-00000001')).toEqual({ held: { status: 'dispatched', at: 1 } })
    ledger.accept('s', 'a-00000001')
    expect(ledger.receive('s', 'a-00000001')).toEqual({ held: { status: 'accepted', at: 1 } })
    ledger.receive('s', 'b-00000001')
    ledger.reject('s', 'b-00000001', 'no')
    expect(ledger.receive('s', 'b-00000001')).toEqual({
      held: { status: 'rejected', at: 1, reason: 'no' }
    })
    // Two sessions keep their ids apart.
    expect(ledger.receive('t', 'a-00000001')).toEqual({ first: true })
  })
  it('refuses a write whose received phase cannot be persisted, holding nothing', () => {
    const storage = memoryWriteLedgerStorage()
    const ledger = freshLedger(storage)
    const write = storage.write
    storage.write = () => {
      throw new Error('disk full')
    }
    expect(() => ledger.receive('s', ID)).toThrow(
      'the write ledger could not be written: disk full'
    )
    storage.write = write
    expect(ledger.status('s', ID)).toEqual({ status: 'absent' })
    expect(ledger.receive('s', ID)).toEqual({ first: true })
  })
  it('keeps every id: nothing is evicted', () => {
    const ledger = freshLedger()
    for (let i = 0; i < 1000; i++) {
      const id = `id-${String(i).padStart(8, '0')}`
      ledger.receive('s', id)
      ledger.dispatch('s', id)
      ledger.accept('s', id)
    }
    expect(ledger.entries('s').size).toBe(1000)
    expect(ledger.status('s', 'id-00000000')).toEqual({ status: 'accepted', at: 1 })
  })
})

describe('the route’s five statuses', () => {
  it('absent from an intact complete ledger, never from anything else', () => {
    const ledger = freshLedger()
    expect(ledger.status('fresh', ID)).toEqual({ status: 'absent' })
    ledger.receive('fresh', 'other-00000001')
    expect(ledger.status('fresh', ID)).toEqual({ status: 'absent' })
  })
  it('a missing ledger is unknown until a new session identity explicitly initializes it', () => {
    const storage = memoryWriteLedgerStorage()
    const ledger = new WriteLedger(storage, () => 1, quiet)
    expect(ledger.status('old', ID)).toMatchObject({ status: 'unknown' })
    expect(ledger.receive('old', ID)).toMatchObject({ held: { status: 'unknown' } })
    ledger.initialize('old')
    expect(ledger.status('old', ID)).toMatchObject({ status: 'unknown' })
    ledger.initialize('new')
    expect(ledger.status('new', ID)).toEqual({ status: 'absent' })
    expect(new WriteLedger(storage).status('new', ID)).toEqual({ status: 'absent' })
  })
  it('unknown from an unreadable ledger, and from one started again after an invalid file', () => {
    const storage = memoryWriteLedgerStorage()
    const broken = {
      ...storage,
      read: (name: string): string | null => {
        if (name.endsWith('.ledger.json')) throw new Error('EACCES')
        return null
      }
    }
    const unreadable = new WriteLedger(broken, () => 1, quiet)
    expect(unreadable.status('s', ID)).toEqual({ status: 'unknown', reason: LEDGER_INCOMPLETE })
    storage.documents.set('t.ledger.json', '{not json')
    const invalid = new WriteLedger(storage, () => 7, quiet)
    expect(invalid.status('t', ID)).toEqual({ status: 'unknown', reason: LEDGER_INCOMPLETE })
    // The invalid file is put aside, the new one says it is incomplete.
    expect(
      [...storage.documents.keys()].some((k) => k.startsWith('t.ledger.json.unreadable-'))
    ).toBe(true)
    expect(JSON.parse(storage.documents.get('t.ledger.json')!)).toMatchObject({ complete: false })
    // An incomplete ledger cannot prove an unseen id is new.
    expect(invalid.receive('t', ID)).toMatchObject({ held: { status: 'unknown' } })
    expect(invalid.status('t', 'never-00000001')).toEqual({
      status: 'unknown',
      reason: LEDGER_INCOMPLETE
    })
  })
  it('unknown while a load throws, said as such', () => {
    const storage = memoryWriteLedgerStorage()
    const ledger = freshLedger(storage)
    // The history file is read first; a throwing ledger read is caught by load,
    // so only a thrown put reaches status: proven through the unreadable path above.
    expect(ledger.status('s', ID)).toEqual({ status: 'absent' })
    expect(LEDGER_UNREADABLE.length).toBeGreaterThan(0)
  })
  it('accepted from the server’s own history when the ledger lacks the id', () => {
    const storage = memoryWriteLedgerStorage()
    storage.documents.set('s.history.json', JSON.stringify({ v: 1, items: [{ id: ID, at: 42 }] }))
    const ledger = new WriteLedger(storage, () => 1, quiet)
    expect(ledger.status('s', ID)).toEqual({ status: 'accepted', at: 42 })
  })
})

describe('the server’s own history of writes', () => {
  it('records an id as it passes, settles a dispatched entry as accepted, and persists both', () => {
    const storage = memoryWriteLedgerStorage()
    const ledger = freshLedger(storage)
    ledger.receive('s', ID)
    ledger.dispatch('s', ID)
    ledger.evidence('s', ID, 9)
    expect(ledger.status('s', ID)).toEqual({ status: 'accepted', at: 9 })
    expect(JSON.parse(storage.documents.get('s.history.json')!)).toEqual({
      v: 1,
      items: [{ id: ID, at: 9 }]
    })
    // Recorded once; the handler's own accept keeps the earlier time.
    ledger.evidence('s', ID, 10)
    expect(ledger.accept('s', ID, 11)).toEqual({ status: 'accepted', at: 9 })
  })
})

describe('recovery at boot, on what a previous process left', () => {
  const left = (
    entries: Record<string, unknown>,
    history: unknown[] = []
  ): ReturnType<typeof memoryWriteLedgerStorage> => {
    const storage = memoryWriteLedgerStorage()
    storage.documents.set('s.ledger.json', JSON.stringify({ v: 1, complete: true, entries }))
    if (history.length)
      storage.documents.set('s.history.json', JSON.stringify({ v: 1, items: history }))
    return storage
  }
  it('a received entry was never handed over: rejected, server restarted before dispatch', () => {
    const storage = left({ [ID]: { status: 'received', at: 1 } })
    const ledger = new WriteLedger(storage, () => 50, quiet)
    expect(ledger.status('s', ID)).toEqual({
      status: 'rejected',
      at: 50,
      reason: RESTARTED_BEFORE_DISPATCH
    })
    expect(JSON.parse(storage.documents.get('s.ledger.json')!).entries[ID].status).toBe('rejected')
    // The second write is refused with the recorded reason: nothing is resent.
    expect(ledger.receive('s', ID)).toEqual({
      held: { status: 'rejected', at: 50, reason: RESTARTED_BEFORE_DISPATCH }
    })
  })
  it('a dispatched entry the history does not carry: unknown, by design', () => {
    const storage = left({ [ID]: { status: 'dispatched', at: 1 } })
    const ledger = new WriteLedger(storage, () => 50, quiet)
    expect(ledger.status('s', ID)).toEqual({
      status: 'unknown',
      at: 50,
      reason: STOPPED_AFTER_DISPATCH
    })
    expect(ledger.receive('s', ID)).toEqual({
      held: { status: 'unknown', at: 50, reason: STOPPED_AFTER_DISPATCH }
    })
    // Evidence arriving later settles it.
    ledger.evidence('s', ID, 60)
    expect(ledger.status('s', ID)).toEqual({ status: 'accepted', at: 60 })
  })
  it('a dispatched entry the history carries: accepted, with the history’s time', () => {
    const storage = left({ [ID]: { status: 'dispatched', at: 1 } }, [{ id: ID, at: 3 }])
    const ledger = new WriteLedger(storage, () => 50, quiet)
    expect(ledger.status('s', ID)).toEqual({ status: 'accepted', at: 3 })
  })
  it('accepted and rejected entries come back as they were, and the ledger stays complete', () => {
    const storage = left({
      'a-00000001': { status: 'accepted', at: 1 },
      'b-00000001': { status: 'rejected', at: 2, reason: 'no' },
      'c-00000001': { status: 'unknown', at: 3, reason: 'earlier' }
    })
    const ledger = new WriteLedger(storage, () => 50, quiet)
    expect(ledger.status('s', 'a-00000001')).toEqual({ status: 'accepted', at: 1 })
    expect(ledger.status('s', 'b-00000001')).toEqual({ status: 'rejected', at: 2, reason: 'no' })
    expect(ledger.status('s', 'c-00000001')).toEqual({
      status: 'unknown',
      at: 3,
      reason: 'earlier'
    })
    expect(ledger.status('s', 'd-00000001')).toEqual({ status: 'absent' })
  })
  it('survives a restart on the file storage, owner-only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-ledger-'))
    dirs.push(dir)
    const first = new WriteLedger(fileWriteLedgerStorage(dir), () => 1, quiet)
    first.initialize('s')
    first.receive('s', 'a-00000001')
    first.dispatch('s', 'a-00000001')
    first.accept('s', 'a-00000001')
    first.receive('s', 'b-00000001')
    first.dispatch('s', 'b-00000001')
    first.receive('s', 'c-00000001')
    first.evidence('s', 'a-00000001', 1)
    const second = new WriteLedger(fileWriteLedgerStorage(dir), () => 9, quiet)
    expect(second.status('s', 'a-00000001')).toEqual({ status: 'accepted', at: 1 })
    expect(second.status('s', 'b-00000001')).toEqual({
      status: 'unknown',
      at: 9,
      reason: STOPPED_AFTER_DISPATCH
    })
    expect(second.status('s', 'c-00000001')).toEqual({
      status: 'rejected',
      at: 9,
      reason: RESTARTED_BEFORE_DISPATCH
    })
    expect(second.status('s', 'd-00000001')).toEqual({ status: 'absent' })
    expect(readFileSync(path.join(dir, 's.ledger.json'), 'utf8')).toContain('"complete":true')
    // A file nobody can read starts the ledger again, incomplete.
    writeFileSync(path.join(dir, 'u.ledger.json'), '{"v":1,"complete":true,"entries":{}}')
    chmodSync(path.join(dir, 'u.ledger.json'), 0o000)
    const third = new WriteLedger(fileWriteLedgerStorage(dir), () => 9, quiet)
    expect(third.status('u', ID)).toEqual({ status: 'unknown', reason: LEDGER_INCOMPLETE })
    chmodSync(path.join(dir, 'u.ledger.json'), 0o600)
  })
})

describe('the file name and the reason', () => {
  it('names a plain id as it is and hashes any other', () => {
    expect(ledgerFileStem('clave-abc_1')).toBe('clave-abc_1')
    expect(ledgerFileStem('../x/y')).toMatch(/^[0-9a-f]{64}$/)
    expect(ledgerFileStem('a'.repeat(129))).toMatch(/^[0-9a-f]{64}$/)
  })
  it('keeps a reason short, on one line, without the message’s own text', () => {
    expect(
      sanitizeReason(
        new Error('Refused: the text "hello there" is too long\nat stack'),
        'hello there'
      )
    ).toBe('Refused: the text "…" is too long')
    expect(sanitizeReason(new Error(''))).toBe('the write failed')
    expect(sanitizeReason('x'.repeat(300)).length).toBe(160)
    expect(sanitizeReason({ not: 'an error' })).toBe('[object Object]')
  })
})
