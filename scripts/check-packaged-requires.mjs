/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by the release and by CI */
// Does the PACKAGED app carry every module its bundles require? (PRDCT-3418)
//
//   node scripts/check-packaged-requires.mjs <path/to/Clave.app>
//
// The bundles in `out/` require their externals (Effect and its platform
// packages, node-pty, …) at runtime, and electron-builder decides which of
// those land in the asar: production dependencies, never the peers npm
// installs on its own (flagged `peer: true` in the lockfile). A dev run, the
// unit tests and the e2e suite all resolve from `node_modules` and never see
// the difference. 2.2.0 shipped that way: `@effect/platform-bun`'s index
// requires `@effect/cluster`, a peer nobody declared, so the in-process server
// died at boot with `Cannot find module '@effect/cluster/HttpRunner'` and
// every agent tool with it.
//
// So the check runs where the defect lives: the app's own Electron binary as
// Node (ELECTRON_RUN_AS_NODE, which still reads the asar), requiring every
// bare specifier found in `out/main` and `out/preload` from the file that
// names it, inside `app.asar`. A require pulls in what the module loads
// eagerly, so a missing package anywhere below is a failure too.
//
// What fails it: a module that cannot be FOUND (MODULE_NOT_FOUND,
// ERR_MODULE_NOT_FOUND), whoever asked for it. A module that is found and then
// throws because it is not running inside Electron proper (it wants `app`, a
// window) is reported and not counted: that is a runtime condition of this
// probe, not a packaging defect. `electron` itself and Node's builtins are
// never probed.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The probe, run INSIDE the packaged binary. CommonJS on purpose: it is
 *  handed to Electron-as-Node as a plain script. */
const PROBE = String.raw`
const fs = require('fs')
const path = require('path')
const { builtinModules, createRequire } = require('module')
const asar = process.argv[2]
const builtins = new Set(builtinModules.flatMap((m) => [m, 'node:' + m]))
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(c?js)$/.test(entry.name)) files.push(p)
  }
}
for (const sub of ['out/main', 'out/preload']) {
  const dir = path.join(asar, sub)
  if (fs.existsSync(dir)) walk(dir)
}
if (files.length === 0) {
  console.log(JSON.stringify({ error: 'no bundle under ' + asar + '/out' }))
  process.exit(0)
}
const specs = new Map()
const re = /\brequire\(\s*["']([^"'./][^"']*)["']\s*\)/g
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(re)) {
    const spec = m[1]
    if (builtins.has(spec) || spec === 'electron' || spec.startsWith('electron/')) continue
    if (!specs.has(spec)) specs.set(spec, file)
  }
}
const results = []
for (const [spec, from] of specs) {
  try {
    createRequire(from)(spec)
    results.push({ spec, from: path.relative(asar, from), ok: true })
  } catch (err) {
    const notFound = err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')
    // "Cannot find module 'electron'" from inside a dependency is the probe
    // not being Electron proper, not a missing package.
    const missingElectron = notFound && /Cannot find module ['"]electron['"]/.test(String(err.message))
    results.push({
      spec,
      from: path.relative(asar, from),
      ok: false,
      missing: notFound && !missingElectron,
      message: String(err && err.message).split('\n').slice(0, 6).join('\n')
    })
  }
}
console.log(JSON.stringify({ files: files.length, results }))
`

/** The app bundle's binary and asar, from a `.app` path. */
export function locateApp(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources')
  const asar = path.join(resources, 'app.asar')
  const macos = path.join(appPath, 'Contents', 'MacOS')
  if (!existsSync(asar)) throw new Error(`no app.asar at ${asar}`)
  if (!existsSync(macos)) throw new Error(`no Contents/MacOS in ${appPath}`)
  const bins = readdirSync(macos)
  if (bins.length !== 1)
    throw new Error(`expected one binary in ${macos}, found ${bins.join(', ')}`)
  return { binary: path.join(macos, bins[0]), asar }
}

/** Run the probe in the packaged binary; resolve to its parsed report. */
export function probePackagedApp(appPath) {
  const { binary, asar } = locateApp(appPath)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-packaged-requires-'))
  const probe = path.join(dir, 'probe.cjs')
  writeFileSync(probe, PROBE)
  try {
    const run = spawnSync(binary, [probe, asar], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024
    })
    if (run.error) throw run.error
    const line = run.stdout
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('{'))
    if (!line) {
      throw new Error(
        `the probe printed no report (exit ${run.status})\n${run.stdout}\n${run.stderr}`
      )
    }
    const report = JSON.parse(line)
    if (report.error) throw new Error(report.error)
    return report
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const appPath = process.argv[2]
  if (!appPath) {
    console.error('usage: node scripts/check-packaged-requires.mjs <path/to/Clave.app>')
    process.exit(2)
  }
  const report = probePackagedApp(path.resolve(appPath))
  const missing = report.results.filter((r) => !r.ok && r.missing)
  const runtime = report.results.filter((r) => !r.ok && !r.missing)
  console.log(
    `[packaged-requires] ${appPath}: ${report.results.length} external modules required by ${report.files} bundle files`
  )
  for (const r of runtime) {
    console.log(
      `  found, threw outside Electron (not counted): ${r.spec} — ${r.message.split('\n')[0]}`
    )
  }
  if (missing.length > 0) {
    console.error(
      `[packaged-requires] FAIL: ${missing.length} module(s) the packaged app cannot load:`
    )
    for (const r of missing)
      console.error(
        `  ${r.spec} (required by ${r.from})\n    ${r.message.replace(/\n/g, '\n    ')}`
      )
    process.exit(1)
  }
  console.log('[packaged-requires] OK: every external module loads from the asar')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[packaged-requires] ERROR: ${err.message}`)
    process.exit(1)
  })
}
