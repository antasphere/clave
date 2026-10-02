#!/usr/bin/env node
// Runner for the Electron end-to-end checks.
//
// The point of this file is the exit code. A verification script that prints
// JSON and exits 0 whatever happened is a probe, not a check — it verifies
// nothing the moment nobody is reading the output. Every spec here asserts, and
// a failed assertion fails the run.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NAMESPACE_ENV, defaultNamespace, fixtureRoot } from './namespace.mjs'
import { finishRun, killLeakedE2eTmux, serverMode, SERVER_MODE_ENV } from './harness.mjs'
import { loadKnown, classify, summarize } from './known-failures.mjs'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Every run gets its own fixture namespace (PRDCT-2615). Set before any spec
// is imported, because the specs build their fixture paths at module load.
// One given in the environment wins; otherwise the checkout names the run, so
// two worktrees running the suite at once never share a /tmp folder.
if (!process.env[NAMESPACE_ENV] || process.env[NAMESPACE_ENV].trim() === '')
  process.env[NAMESPACE_ENV] = defaultNamespace(path.resolve(DIR, '..', '..'))
// Every argument is a filter; a spec runs when its file name contains any of
// them. No argument runs the whole suite.
const only = process.argv.slice(2).filter((a) => a.trim() !== '')
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const BOLD = '\u001b[1m'
const OFF = '\u001b[0m'

// Known failures (PRDCT-1711, PRDCT-3154): see known-failures.mjs for what
// the file may say and why a crash can never be "known". A file that would
// hide something is refused here, before any spec runs.
const KNOWN_FILE = path.join(DIR, 'known-failures.json')
const known = loadKnown(
  existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf-8')) : null
)

const TAG = {
  pass: GREEN + '  PASS',
  fail: RED + '  FAIL',
  known: YELLOW + ' KNOWN',
  unstable: YELLOW + ' UNSTABLE'
}

/** Assertion collector handed to each spec. */
function createT(specName) {
  const results = []
  return {
    specName,
    results,
    /** Assert `cond`. `detail` is printed on failure — make it the actual value. */
    check(name, cond, detail) {
      results.push({ name, ok: !!cond, detail })
      const { kind } = classify(specName, name, !!cond, known)
      console.log(`${TAG[kind]}${OFF}  ${name}`)
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
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort()

if (specs.length === 0) {
  console.error(only.length ? `No spec matches ${only.join(', ')}` : 'No specs found')
  process.exit(1)
}

console.log(`fixtures under ${fixtureRoot()}  (${NAMESPACE_ENV}=${process.env[NAMESPACE_ENV]})`)
// The server mode is read ONCE here and named on both ends of the run: a
// suite that ran attached and one that ran in-process must never be confused
// in a log. A bad value throws before any spec runs.
const mode = serverMode()
console.log(`server: ${mode}  (${SERVER_MODE_ENV}=${mode})`)
if (known.unstable.length > 0)
  console.log(`unstable specs, not a gate: ${known.unstable.join(', ')}`)

// Several specs spawn tmux sessions and leave them to a later sweep, and the
// sweep is scoped to this run's namespace (harness killLeakedE2eTmux), so no
// other checkout will ever take them. The run sweeps its own at both ends:
// the start catches what an interrupted run of this checkout left.
killLeakedE2eTmux()

const results = {}

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
  results[file] = t.results
}

const { totals, recovered, unstablePassed, exitCode } = summarize(results, known)

finishRun({ failed: totals.failed })

if (recovered.length > 0) {
  console.log(
    `\n${YELLOW}${recovered.length} known failure(s) passed this run; remove them from known-failures.json:${OFF}`
  )
  for (const r of recovered) console.log(`  ${r}`)
}
if (unstablePassed.length > 0) {
  console.log(
    `\n${YELLOW}${unstablePassed.length} unstable spec(s) passed in full this run (still listed as unstable):${OFF} ${unstablePassed.join(', ')}`
  )
}
console.log(
  `\n${totals.passed} passed, ${totals.failed} failed, ${totals.known} known failures, ${totals.unstable} unstable  (server: ${mode})`
)
process.exit(exitCode)
