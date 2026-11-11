/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node CI tooling. */
import { relative } from 'node:path'
import { BaseSequencer } from 'vitest/node'

// Seconds from Linux run 42996565358. These are placement hints, never a test
// allowlist. Unknown files still run. Vitest's hash partition put all four
// expensive files on one host; starting them first on separate hosts avoids
// adding two real-clock sign-in/Markdown tests to the tail of that job.
const seconds = {
  'src/main/antasphere-account.test.ts': 46,
  'src/renderer/src/views/markdown-parser-reuse-correctness.test.ts': 38,
  'tests/e2e/runner-sharding.test.mjs': 15,
  'scripts/server-process.test.mjs': 11
}
const weight = (file) => seconds[file] ?? 1
const byWeight = (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0)

export function partitionUnitFiles(files, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid unit shard count')
  if (new Set(files).size !== files.length) throw new Error('Duplicate unit file')
  const shards = Array.from({ length: Math.min(count, files.length) }, () => [])
  const loads = shards.map(() => 0)
  for (const file of [...files].sort(byWeight)) {
    let target = 0
    for (let i = 1; i < loads.length; i++) if (loads[i] < loads[target]) target = i
    shards[target].push(file)
    loads[target] += weight(file)
  }
  return shards
}

export default class UnitSequencer extends BaseSequencer {
  name(spec) {
    return relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
  }

  async shard(files) {
    const { index, count } = this.ctx.config.shard
    if (!Number.isSafeInteger(index) || index < 1 || index > count) {
      throw new Error('Invalid unit shard index')
    }
    const selected = new Set(
      partitionUnitFiles(
        files.map((file) => this.name(file)),
        count
      )[index - 1]
    )
    return files.filter((file) => selected.has(this.name(file)))
  }

  async sort(files) {
    return [...files].sort((a, b) => byWeight(this.name(a), this.name(b)))
  }
}
