import { describe, expect, it } from 'vitest'
import type { SessionRecord } from './adapters/pty-backend'
import { hostedListing, markHosted, recordsForIds } from './records-by-id'

const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  cwd: '/w',
  folderName: 'w',
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  ...extra
})

const hostsNone = { hosts: () => false, recordOf: () => undefined, isAlive: () => false }

describe('the records a window asks for by id', () => {
  it('answers an adoptable record as the listing had it, with no running mark', () => {
    const adoptable = [record('moving', { tmuxName: 'clave-x', live: true })]
    const out = recordsForIds(adoptable, ['moving'], {
      hosts: () => false,
      recordOf: () => {
        throw new Error('the listing already had it')
      },
      isAlive: () => true
    })
    expect(out).toEqual([record('moving', { tmuxName: 'clave-x', live: true })])
    expect(out[0].running).toBeUndefined()
  })
  it('answers the record of a session this process runs, marked running, with the process state', () => {
    const out = recordsForIds([], ['served', 'dead', 'unknown', 7], {
      hosts: (id) => id !== 'unknown',
      recordOf: (id) => (id === 'unknown' ? undefined : record(id)),
      isAlive: (id) => id === 'served'
    })
    expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
      ['served', true, true],
      ['dead', true, false]
    ])
  })
  it('answers only the ids asked for', () => {
    const adoptable = [record('a'), record('b')]
    const out = recordsForIds(adoptable, ['b'], hostsNone)
    expect(out.map((r) => r.id)).toEqual(['b'])
  })

  // Issue #183: a chat session the server already holds is listed (its record
  // is on disk and no PTY of the backend names it), so a by-id read used to
  // answer it as the listing had it — live:false, no running — and the window
  // skipped it, or spawned it a second time.
  it('marks a session this process hosts as running even when the listing has it', () => {
    const adoptable = [
      record('dormant', { transport: 'events', live: false }),
      record('started', { transport: 'events', live: false }),
      record('cold', { transport: 'events', live: false })
    ]
    const out = recordsForIds(adoptable, ['dormant', 'started', 'cold'], {
      hosts: (id) => id !== 'cold',
      recordOf: (id) => record(id, { displayName: 'stale copy' }),
      isAlive: (id) => id === 'started'
    })
    expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
      ['dormant', true, false],
      ['started', true, true],
      ['cold', undefined, false]
    ])
    // The listing's record is kept: names and refs are not re-read.
    expect(out.every((r) => r.displayName === undefined)).toBe(true)
  })

  it('never marks running from a record file alone: only what the host holds', () => {
    // A cold chat's record is readable by id (getSessionRecord reads its
    // file), which is not a session this process runs.
    const out = recordsForIds([], ['cold'], {
      hosts: () => false,
      recordOf: (id) => record(id, { transport: 'events' }),
      isAlive: () => true
    })
    expect(out).toEqual([])
  })
})

describe('the whole listing', () => {
  it('marks the sessions this process hosts as running, their liveness the host’s', () => {
    const listing = [
      record('hosted', { transport: 'events', live: false }),
      record('cold', { transport: 'events', live: false }),
      record('tmux', { tmuxName: 'clave-t', live: true })
    ]
    const out = markHosted(listing, {
      hosts: (id) => id === 'hosted',
      isAlive: () => false
    })
    expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
      ['hosted', true, false],
      ['cold', undefined, false],
      ['tmux', undefined, true]
    ])
  })

  it('returns the listing itself when this process hosts none of it', () => {
    const listing = [record('a')]
    expect(markHosted(listing, { hosts: () => false, isAlive: () => false })).toBe(listing)
  })

  // The backend leaves out the PTYs it runs: a reload lost every live
  // terminal tab with the chats (issue #183).
  it('carries the live terminal tabs the host runs, and only those', () => {
    const listing = [record('chat', { transport: 'events', live: false })]
    const records: Record<string, SessionRecord> = {
      tab: record('tab', { tmuxName: 'clave-tab' }),
      plain: record('plain'),
      ended: record('ended'),
      groupTerminal: record('groupTerminal', {
        link: { kind: 'group-terminal', groupId: 'g', terminalId: 't' }
      }),
      toolbar: record('toolbar', { link: { kind: 'toolbar', key: 'k' } })
    }
    const hostedIds = ['chat', 'tab', 'plain', 'ended', 'groupTerminal', 'toolbar', 'unrecorded']
    const out = hostedListing(listing, {
      hosts: (id) => hostedIds.includes(id),
      isAlive: (id) => id !== 'ended' && id !== 'chat',
      ids: () => hostedIds,
      recordOf: (id) => records[id]
    })
    expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
      ['chat', true, false],
      ['tab', true, true],
      ['plain', true, true]
    ])
  })

  it('returns the listing itself when the host runs no tab it left out', () => {
    const listing = [record('a')]
    const out = hostedListing(listing, {
      hosts: () => false,
      isAlive: () => true,
      ids: () => [],
      recordOf: () => undefined
    })
    expect(out).toBe(listing)
  })
})
