import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLedger, emptyTally } from './ledger'
import { newCursor } from './reader'
import { Store, isPublishedDeck, isSessionRow } from './store'

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
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 3, gapMinutes: 15 })
  })

  it('reloads the published decks it can read, drops the rest, and keeps them across a recount', () => {
    const ledger = emptyLedger(15, new Date('2026-10-02T10:00:00.000Z'))
    const deck = {
      deckId: 'deck-1',
      baseUrl: 'https://share.example',
      url: 'https://share.example/p/deck-1',
      version: 3,
      n: 1,
      at: '2026-11-04T10:00:00.000Z',
      title: 'Theme · Analytics',
      names: false
    }
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({
        ...ledger,
        sessions: { a: row('a') },
        published: { 'group:g1': deck, 'group:g2': { deckId: 'x' }, 'group:g3': 'nope' }
      })
    )
    expect(new Store(dir).readLedger(15).published).toEqual({ 'group:g1': deck })
    expect(isPublishedDeck(deck)).toBe(true)
    expect(isPublishedDeck({ ...deck, version: '3' })).toBe(false)
    expect(isPublishedDeck({ ...deck, deckId: '' })).toBe(false)
    // A ledger of an earlier version is recounted, but the decks it was published as stay:
    // a share link keeps pointing at the same deck.
    writeFileSync(
      join(dir, 'ledger.json'),
      JSON.stringify({
        ...ledger,
        v: 2,
        sessions: { a: row('a') },
        published: { 'group:g1': deck }
      })
    )
    const recounted = new Store(dir).readLedger(15)
    expect(recounted.sessions).toEqual({})
    expect(recounted.published).toEqual({ 'group:g1': deck })
  })

  it('reads the settings with their defaults and writes them back, and keeps the price override', () => {
    const store = new Store(dir)
    expect(store.readSettings()).toEqual({ gapMinutes: 15 })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gapMinutes: 90 }))
    expect(store.readSettings()).toEqual({ gapMinutes: 90 })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gapMinutes: 0 }))
    expect(store.readSettings()).toEqual({ gapMinutes: 15 })
    writeFileSync(join(dir, 'settings.json'), '{oops')
    expect(store.readSettings()).toEqual({ gapMinutes: 15 })
    store.writeSettings({ gapMinutes: 45 })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ gapMinutes: 45 })

    expect(store.hasPrices()).toBe(false)
    const table = {
      source: 'edited',
      date: '2026-11-04',
      models: {
        'claude-x': {
          name: 'X',
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite5m: 1.25,
          cacheWrite1h: 2
        }
      }
    }
    store.writePrices(table)
    expect(store.hasPrices()).toBe(true)
    expect(JSON.parse(readFileSync(store.pricesPath, 'utf8'))).toEqual(table)
    store.removePrices()
    expect(store.hasPrices()).toBe(false)
    store.removePrices()
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
  it('refuses a row for each field the check names, one at a time', () => {
    const whole = row('w')
    const tally = (): Record<string, unknown> => ({ ...emptyTally() })
    const cursor = (): Record<string, unknown> => ({ ...newCursor('/x/w.jsonl') })
    const without = (base: Record<string, unknown>, key: string): Record<string, unknown> => {
      const copy = { ...base }
      delete copy[key]
      return copy
    }
    const broken: [string, Record<string, unknown>][] = [
      ['no seenAt', without(whole, 'seenAt')],
      ['no createdAt', without(whole, 'createdAt')],
      ['a group without a name', { ...whole, group: { id: 'g' } }],
      [
        'a tally without stamps',
        { ...whole, root: { tally: without(tally(), 'stamps'), file: cursor() } }
      ],
      [
        'a tally without tokens',
        { ...whole, root: { tally: without(tally(), 'tokens'), file: cursor() } }
      ],
      [
        'a tally with a half token set',
        { ...whole, root: { tally: { ...tally(), tokens: { input: 1 } }, file: cursor() } }
      ],
      [
        'a model entry that is not a token set',
        { ...whole, root: { tally: { ...tally(), byModel: { m: { input: 1 } } }, file: cursor() } }
      ],
      [
        'a day bucket without counts',
        {
          ...whole,
          root: { tally: { ...tally(), days: { '2026-10-02': { input: 1 } } }, file: cursor() }
        }
      ],
      [
        'a cursor without seen',
        { ...whole, root: { tally: tally(), file: without(cursor(), 'seen') } }
      ],
      [
        'a cursor without an offset',
        { ...whole, root: { tally: tally(), file: without(cursor(), 'offset') } }
      ],
      [
        'a subagent without a cursor',
        { ...whole, subagents: [{ id: 'x', tally: tally(), file: {} }] }
      ],
      ['state spans that are not a list', { ...whole, stateSpans: {} }]
    ]
    expect(isSessionRow(whole)).toBe(true)
    for (const [why, candidate] of broken) expect(isSessionRow(candidate), why).toBe(false)
  })
})
