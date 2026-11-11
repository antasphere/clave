/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node CI script. */
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Read the runner's actual Vitest inventory rather than a hand-maintained count.
// A green shard that silently drops a file must not make the required check green.
export function mergeUnitReports(inventory, reports, shards) {
  if (!Number.isInteger(shards) || shards < 1 || reports.length !== shards) {
    throw new Error(`Expected ${shards} shards, received ${reports.length}`)
  }
  const expected = new Set(inventory)
  if (!expected.size || expected.size !== inventory.length)
    throw new Error('Invalid test inventory')
  const seen = new Set()
  const result = { files: 0, tests: 0, passed: 0, skipped: 0 }
  for (const report of reports) {
    if (report.success !== true || !Array.isArray(report.testResults)) {
      throw new Error('Unit shard failed or has no results')
    }
    for (const file of report.testResults) {
      if (!expected.has(file.name)) throw new Error(`Unexpected test file: ${file.name}`)
      if (seen.has(file.name)) throw new Error(`Duplicate test file: ${file.name}`)
      if (!['passed', 'pending', 'skipped', 'todo'].includes(file.status)) {
        throw new Error(`Test file failed: ${file.name}`)
      }
      seen.add(file.name)
      result.files++
      for (const assertion of file.assertionResults) {
        result.tests++
        if (assertion.status === 'passed') result.passed++
        else if (['pending', 'skipped', 'todo'].includes(assertion.status)) result.skipped++
        else throw new Error(`Test assertion failed in ${file.name}: ${assertion.status}`)
      }
    }
  }
  const missing = [...expected].filter((file) => !seen.has(file))
  if (missing.length) throw new Error(`Test files missing from shards: ${missing.join(', ')}`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, count] = process.argv.slice(2)
  const shards = Number(count)
  const read = (name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
  const inventory = read('inventory.json').map(({ file }) => file)
  const reports = Array.from({ length: shards }, (_, i) => read(`shard-${i + 1}.json`))
  const result = mergeUnitReports(inventory, reports, shards)
  const summary = `Unit tests: ${result.files} files, ${result.passed} passed, ${result.skipped} skipped, ${result.tests} total.\n`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}
