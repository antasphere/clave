import { describe, expect, it } from 'vitest'
import type { SessionRecord } from './adapters/pty-backend'
import { recordsForIds } from './records-by-id'

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

describe('the records a window asks for by id', () => {
  it('answers an adoptable record as the listing had it, with no running mark', () => {
    const adoptable = [record('moving', { tmuxName: 'clave-x', live: true })]
    const out = recordsForIds(adoptable, ['moving'], {
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
    const out = recordsForIds(adoptable, ['b'], { recordOf: () => undefined, isAlive: () => true })
    expect(out.map((r) => r.id)).toEqual(['b'])
  })
})
