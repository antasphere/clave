#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReports } from './sharding.mjs'
import { loadKnown, summarize } from './known-failures.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function mergeReports(reports, specs, total) {
  validateReports(reports, specs, total)
  const known = loadKnown(JSON.parse(readFileSync(path.join(HERE, 'known-failures.json'), 'utf8')))
  for (const report of reports) {
    if (summarize(report.results, known).exitCode !== report.exitCode)
      throw new Error(`Shard ${report.shard.index} exit code disagrees with its assertions`)
  }
  const results = Object.assign({}, ...reports.map((r) => r.results))
  return { ...summarize(results, known), specs: Object.keys(results).length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, count, output] = process.argv.slice(2)
  const specs = readdirSync(HERE)
    .filter((f) => f.endsWith('.spec.mjs'))
    .sort()
  const reports = readdirSync(directory)
    .filter((f) => /^shard-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(path.join(directory, f), 'utf8')))
  const result = mergeReports(reports, specs, Number(count))
  const { totals } = result
  const text = `${result.specs} specs; ${totals.passed} passed, ${totals.failed} failed, ${totals.known} known failures, ${totals.unstable} unstable`
  console.log(text)
  if (output)
    writeFileSync(
      output,
      `## Full Electron suite\n\n${text}\n\nAll ${count} shards completed. Assertion failures remain a report, as before. Missing or incomplete shards fail the aggregate check.\n`
    )
}
