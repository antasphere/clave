import { describe, expect, it } from 'vitest'
import UnitSequencer, { partitionUnitFiles } from './unit-sequencer.mjs'

const slow = [
  'src/main/antasphere-account.test.ts',
  'src/renderer/src/views/markdown-parser-reuse-correctness.test.ts',
  'tests/e2e/runner-sharding.test.mjs',
  'scripts/server-process.test.mjs'
]
const files = [...slow, ...Array.from({ length: 500 }, (_, i) => `src/new-${i}.test.ts`)]

describe('Linux unit placement', () => {
  it('runs every file exactly once, including files without timing hints', () => {
    for (const count of [1, 2, 4, 8, 600]) {
      const shards = partitionUnitFiles(files, count)
      expect(shards.flat().sort()).toEqual([...files].sort())
      expect(partitionUnitFiles([...files].reverse(), count)).toEqual(shards)
    }
  })

  it('starts the four expensive files on separate hosts', () => {
    const shards = partitionUnitFiles(files, 4)
    expect(shards.map((shard) => shard[0])).toEqual(slow)
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
      expect(sorted[0].moduleId).toBe(`/checkout/${slow[index - 1]}`)
      selected.push(...sorted)
    }
    expect(selected.map((spec) => spec.moduleId).sort()).toEqual(
      specs.map((s) => s.moduleId).sort()
    )
  })
})
