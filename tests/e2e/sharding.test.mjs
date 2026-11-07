import { describe, it, expect } from 'vitest'
import { parseRunArgs, selectShard, validateReports } from './sharding.mjs'

describe('E2E shard coverage', () => {
  const specs = Array.from({ length: 192 }, (_, i) => `${i}.spec.mjs`)
  it('executes every selected spec exactly once across eight shards', () => {
    const shards = Array.from({ length: 8 }, (_, i) =>
      selectShard(specs, { index: i + 1, total: 8 })
    )
    expect(shards.flat().sort()).toEqual([...specs].sort())
    expect(new Set(shards.flat()).size).toBe(specs.length)
    expect(shards.every((s) => s.length === 24)).toBe(true)
  })
  it('preserves filters and refuses malformed or duplicate options', () => {
    expect(parseRunArgs(['server-boot', '--shard', '2/8', '--report=out.json'])).toEqual({
      filters: ['server-boot'],
      shard: { index: 2, total: 8 },
      report: 'out.json',
      list: false
    })
    for (const value of ['0/8', '9/8', '1/0', '1.5/8', '-1/2', 'x', '1/2/3'])
      expect(() => parseRunArgs([`--shard=${value}`])).toThrow()
    for (const args of [['--shard'], ['--report'], ['--wat'], ['--shard=1/2', '--shard=2/2']])
      expect(() => parseRunArgs(args)).toThrow()
    expect(selectShard(['one.spec.mjs'], { index: 8, total: 8 })).toEqual([])
  })
  it('refuses missing, duplicated, incomplete and crashed shard results', () => {
    const selected = ['a.spec.mjs', 'b.spec.mjs']
    const make = (index, name) => ({
      version: 1,
      shard: { index, total: 2 },
      mode: 'in-process',
      selected: [name],
      results: { [name]: [{ name: 'assertion', ok: true }] },
      completed: true,
      exitCode: 0,
      durationMs: 100
    })
    const reports = [make(1, selected[0]), make(2, selected[1])]
    expect(validateReports(reports, selected, 2).complete).toBe(true)
    expect(() => validateReports(reports.slice(0, 1), selected, 2)).toThrow()
    expect(() => validateReports([reports[0], reports[0]], selected, 2)).toThrow()
    expect(() =>
      validateReports([reports[0], { ...reports[1], completed: false }], selected, 2)
    ).toThrow()
    expect(() =>
      validateReports([reports[0], { ...reports[1], results: {} }], selected, 2)
    ).toThrow()
    expect(() =>
      validateReports([reports[0], { ...reports[1], selected: ['other.spec.mjs'] }], selected, 2)
    ).toThrow()
    expect(() =>
      validateReports([reports[0], { ...reports[1], mode: 'attached' }], selected, 2)
    ).toThrow()
    expect(() =>
      validateReports([reports[0], { ...reports[1], exitCode: 2 }], selected, 2)
    ).toThrow()
  })
})
