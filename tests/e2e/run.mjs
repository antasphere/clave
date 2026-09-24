#!/usr/bin/env node
// Runner for the Electron end-to-end checks.
//
// The point of this file is the exit code. A verification script that prints
// JSON and exits 0 whatever happened is a probe, not a check — it verifies
// nothing the moment nobody is reading the output. Every spec here asserts, and
// a failed assertion fails the run.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NAMESPACE_ENV, defaultNamespace, fixtureRoot } from './namespace.mjs'
import { finishRun, killLeakedE2eTmux } from './harness.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Every run gets its own fixture namespace (PRDCT-2615). Set before any spec
// is imported, because the specs build their fixture paths at module load.
// One given in the environment wins; otherwise the checkout names the run, so
// two worktrees running the suite at once never share a /tmp folder.
if (!process.env[NAMESPACE_ENV] || process.env[NAMESPACE_ENV].trim() === '')
  process.env[NAMESPACE_ENV] = defaultNamespace(path.resolve(DIR, '..', '..'))
const only = process.argv[2]
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const BOLD = '\u001b[1m'
const OFF = '\u001b[0m'

/** Assertion collector handed to each spec. */
function createT(specName) {
  const results = []
  return {
    specName,
    results,
    /** Assert `cond`. `detail` is printed on failure — make it the actual value. */
    check(name, cond, detail) {
      results.push({ name, ok: !!cond, detail })
      console.log(`${cond ? GREEN + '  PASS' : RED + '  FAIL'}${OFF}  ${name}`)
      if (!cond && detail !== undefined) {
        console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
      }
    },
    equal(name, actual, expected) {
      this.check(
        name,
        Object.is(actual, expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
      )
    }
  }
}

const specs = readdirSync(DIR)
  .filter((f) => f.endsWith('.spec.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort()

if (specs.length === 0) {
  console.error(only ? `No spec matches "${only}"` : 'No specs found')
  process.exit(1)
}

console.log(`fixtures under ${fixtureRoot()}  (${NAMESPACE_ENV}=${process.env[NAMESPACE_ENV]})`)

// Several specs spawn tmux sessions and leave them to a later sweep, and the
// sweep is scoped to this run's namespace (harness killLeakedE2eTmux), so no
// other checkout will ever take them. The run sweeps its own at both ends:
// the start catches what an interrupted run of this checkout left.
killLeakedE2eTmux()

let failed = 0
let passed = 0

for (const file of specs) {
  console.log(`\n${BOLD}${file}${OFF}`)
  const t = createT(file)
  try {
    const mod = await import(pathToFileURL(path.join(DIR, file)).href)
    await mod.run(t)
  } catch (err) {
    // A spec that throws is a failure, not a silent skip — the two dead
    // PRDCT-1663 scripts exited 0 on a missing selector for exactly this reason.
    t.check(`${file} ran to completion`, false, err?.stack ?? String(err))
  }
  // A spec that asserts nothing is not a passing spec. Emptying one `run()`
  // used to drop the suite from 20 checks to 13 and still exit 0 — the round-1
  // failure at file granularity instead of statement granularity.
  if (t.results.length === 0) {
    t.check(`${file} made at least one assertion`, false, 'the spec ran but asserted nothing')
  }
  passed += t.results.filter((r) => r.ok).length
  failed += t.results.filter((r) => !r.ok).length
}

finishRun({ failed })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
