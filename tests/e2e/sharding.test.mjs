import { describe, it, expect } from 'vitest'
import { parseRunArgs, selectShard, validateReports, CLIPBOARD_SPECS } from './sharding.mjs'
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  it('separates expensive specs instead of balancing only their count', () => {
    const inventory = ['slow-a', 'a', 'b', 'c', 'slow-b', 'd', 'e', 'f'].map(
      (name) => `${name}.spec.mjs`
    )
    const seconds = Object.fromEntries(inventory.map((name) => [name, 1]))
    seconds['slow-a.spec.mjs'] = seconds['slow-b.spec.mjs'] = 100
    const hints = { defaultSeconds: 1, seconds }
    const partitions = Array.from({ length: 4 }, (_, i) =>
      selectShard(inventory, { index: i + 1, total: 4 }, hints)
    )
    expect(partitions.flat().sort()).toEqual([...inventory].sort())
    expect(
      Math.max(...partitions.map((p) => p.reduce((sum, name) => sum + seconds[name], 0)))
    ).toBeLessThanOrEqual(103)
  })
  it('counts the clipboard group before assigning other work', () => {
    const inventory = ['chat-view.spec.mjs', 'a.spec.mjs', 'b.spec.mjs']
    const hints = {
      defaultSeconds: 1,
      seconds: { 'chat-view.spec.mjs': 100, 'a.spec.mjs': 20, 'b.spec.mjs': 20 }
    }
    expect(selectShard(inventory, { index: 1, total: 2 }, hints)).toEqual([inventory[0]])
    expect(selectShard(inventory, { index: 2, total: 2 }, hints)).toEqual(inventory.slice(1))
  })
  it('preserves order and exact coverage with unknown, renamed and removed hints', () => {
    const inventory = ['z', 'new', 'renamed', 'a', 'chat-view'].map((name) => `${name}.spec.mjs`)
    const hints = {
      defaultSeconds: 7,
      seconds: { 'z.spec.mjs': 30, 'a.spec.mjs': 10, 'removed.spec.mjs': 500 }
    }
    for (const total of [1, 2, 4, 6]) {
      const partitions = Array.from({ length: total }, (_, i) => {
        const shard = { index: i + 1, total }
        const selected = selectShard(inventory, shard, hints)
        expect(selected).toEqual(inventory.filter((name) => selected.includes(name)))
        expect(selectShard(inventory, shard, structuredClone(hints))).toEqual(selected)
        return selected
      })
      expect(partitions.flat().sort()).toEqual([...inventory].sort())
      expect(new Set(partitions.flat()).size).toBe(inventory.length)
      if (total === 1) expect(partitions[0]).toEqual(inventory)
    }
    expect(
      selectShard(
        inventory,
        { index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
        hints
      )
    ).toEqual([])
    // An absent hint receives the explicit fallback, rather than zero weight.
    expect(selectShard(['new.spec.mjs', 'a.spec.mjs'], { index: 1, total: 2 }, hints)).toEqual([
      'a.spec.mjs'
    ])
  })
  it('refuses invalid hints instead of silently using the unknown-spec fallback', () => {
    const inventory = ['a.spec.mjs']
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '2']) {
      expect(() =>
        selectShard(
          inventory,
          { index: 1, total: 1 },
          {
            defaultSeconds: 1,
            seconds: { 'a.spec.mjs': value }
          }
        )
      ).toThrow('Invalid E2E shard duration hint')
      expect(() =>
        selectShard(
          inventory,
          { index: 1, total: 1 },
          {
            defaultSeconds: value,
            seconds: {}
          }
        )
      ).toThrow('Invalid E2E shard duration hints')
    }
    for (const seconds of [undefined, null, [], 'bad'])
      expect(() =>
        selectShard(inventory, { index: 1, total: 1 }, { defaultSeconds: 1, seconds })
      ).toThrow('Invalid E2E shard duration hints')
  })
  it('fails explicitly when the checked-in hint file is missing or malformed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-shard-hints-'))
    try {
      const module = path.join(dir, 'sharding.mjs')
      copyFileSync(new URL('./sharding.mjs', import.meta.url), module)
      for (const contents of [null, '{', '{}', '{"defaultSeconds":1,"seconds":{"a.spec.mjs":0}}']) {
        if (contents !== null) writeFileSync(path.join(dir, 'shard-durations.json'), contents)
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(module).href)}`],
          { encoding: 'utf8', timeout: 10_000 }
        )
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/shard-durations.json|SyntaxError|Invalid E2E shard duration/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
