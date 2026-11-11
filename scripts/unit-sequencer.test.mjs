import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import UnitSequencer, { partitionUnitFiles } from './unit-sequencer.mjs'

const slow = [
  'src/main/antasphere-account.test.ts',
  'src/renderer/src/views/markdown-parser-reuse-correctness.test.ts',
  'tests/e2e/runner-sharding.test.mjs',
  'scripts/server-process.test.mjs'
]
const files = [...slow, ...Array.from({ length: 500 }, (_, i) => `src/new-${i}.test.ts`)]

describe('Linux unit placement', () => {
  it('loads the real CI config and executes a shard through the Vitest CLI', () => {
    const output = execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'scripts/merge-unit-reports.test.mjs',
        '--config',
        'vitest.ci.config.mjs',
        '--shard=1/1'
      ],
      { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NO_COLOR: '1' } }
    )
    expect(output).toMatch(/8 passed/)
  }, 25_000)

  it('runs every file exactly once, including files without timing hints', () => {
    for (const count of [1, 2, 4, 6, 8, 600]) {
      const shards = partitionUnitFiles(files, count)
      expect(shards.flat().sort()).toEqual([...files].sort())
      expect(partitionUnitFiles([...files].reverse(), count)).toEqual(shards)
    }
  })

  it('starts the four expensive files on separate hosts', () => {
    const shards = partitionUnitFiles(files, 4)
    expect(new Set(shards.map((shard) => shard[0]))).toEqual(new Set(slow))
    for (const shard of shards) expect(shard.filter((file) => slow.includes(file))).toHaveLength(1)
  })

  it('rejects invalid counts and duplicate input rather than omitting work', () => {
    for (const count of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => partitionUnitFiles(files, count)).toThrow()
    }
    expect(() => partitionUnitFiles(['same', 'same'], 2)).toThrow(/Duplicate/)
  })

  it('passes the complete partition through the Vitest adapter', async () => {
    const specs = files.map((file) => ({ moduleId: `/checkout/${file}` }))
    const selected = []
    for (let index = 1; index <= 4; index++) {
      const sequencer = new UnitSequencer({
        config: { root: '/checkout', shard: { index, count: 4 } }
      })
      const shard = await sequencer.shard(specs)
      const sorted = await sequencer.sort(shard)
      expect(slow.map((file) => `/checkout/${file}`)).toContain(sorted[0].moduleId)
      selected.push(...sorted)
    }
    expect(selected.map((spec) => spec.moduleId).sort()).toEqual(
      specs.map((s) => s.moduleId).sort()
    )
  })
})
