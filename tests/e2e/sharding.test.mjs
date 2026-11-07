import { describe, it, expect } from 'vitest'
import { parseRunArgs, selectShard, validateReports, CLIPBOARD_SPECS } from './sharding.mjs'
import { readdirSync, readFileSync } from 'node:fs'

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
  it('serializes every spec that reads or writes the system clipboard', () => {
    // This one writes through a rendered Copy button rather than a direct
    // Electron or navigator API call in the spec's own source.
    expect(CLIPBOARD_SPECS.has('chat-turn-copy.spec.mjs')).toBe(true)
    const dir = new URL('./', import.meta.url)
    const inventory = readdirSync(dir)
      .filter((f) => f.endsWith('.spec.mjs'))
      .sort()
    for (const file of inventory) {
      if (/\bclipboard\.(?:read|write)\w*\s*\(/.test(readFileSync(new URL(file, dir), 'utf8')))
        expect(CLIPBOARD_SPECS.has(file), file).toBe(true)
    }
    for (const total of [1, 2, 4, 6]) {
      const partitions = Array.from({ length: total }, (_, i) =>
        selectShard(inventory, { index: i + 1, total })
      )
      expect(partitions.flat().sort()).toEqual(inventory)
      expect(partitions.filter((p) => p.some((f) => CLIPBOARD_SPECS.has(f)))).toHaveLength(1)
      expect(partitions[0].filter((f) => CLIPBOARD_SPECS.has(f)).sort()).toEqual(
        [...CLIPBOARD_SPECS].sort()
      )
    }
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
    expect(() =>
      validateReports([reports[0], { ...reports[1], results: { 'b.spec.mjs': [] } }], selected, 2)
    ).toThrow('no assertions')
  })
})
