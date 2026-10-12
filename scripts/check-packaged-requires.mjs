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
// bare specifier found in `out/main` and `out/preload` (`require("x")` and
// `import("x")`, both quote styles) from the file that names it, inside
// `app.asar`. A require pulls in what the module loads eagerly, so a missing
// package anywhere below is a failure too. `electron` answers with a stub
// inside the probe, so a dependency that loads it first still goes on to its
// other requires.
//
// What it cannot see: a specifier built at runtime (a variable, a template
// literal), a require a dependency makes lazily inside a function, an
// `import()` of an ESM-only package (probed with require, it throws a
// not-exported error and is not counted; today's two import() targets both
// export a require entry), and the other architecture's slice of a
// universal binary. It proves the eager
// load graph of every literal external, not every code path.
//
// What fails it: a module that cannot be FOUND (MODULE_NOT_FOUND,
// ERR_MODULE_NOT_FOUND), whoever asked for it. A module that is found and then
// throws for another reason (the stub is not the real Electron) is reported
// and not counted: a runtime condition of this probe, not a packaging defect.
// `electron` itself and Node's builtins are never probed.
//
//   node scripts/check-packaged-requires.mjs --dist dist
//
// picks the app electron-builder just wrote, the universal one first: a
// `dist/` that still holds an arm64 `--dir` package from an earlier run must
// not be what a universal release is checked on.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The probe, run INSIDE the packaged binary. CommonJS on purpose: it is
 *  handed to Electron-as-Node as a plain script. */
const PROBE = String.raw`
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { builtinModules, createRequire } = Module
// Electron-as-Node has no 'electron' module. A stub that answers every
// property and every call keeps a dependency that loads it going, so the
// requires it makes after it are probed too.
const stub = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub
})
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron' || request.startsWith('electron/')) return stub
  return load.call(this, request, ...rest)
}
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
// Not after a dot: \`ObjC.import('AppKit')\` in a JXA script the main
// process carries as a string is a member call, never a module load.
const re = /(?<![.\w$])(?:require|import)\(\s*["']([^"'./][^"']*)["']\s*\)/g
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

/** The packaged app under an electron-builder output folder, the universal
 *  build first (what a release publishes), then the single-architecture ones. */
export const DIST_APPS = ['mac-universal', 'mac-arm64', 'mac']
export function pickPackagedApp(distDir) {
  for (const sub of DIST_APPS) {
    const app = path.join(distDir, sub, 'Clave.app')
    if (existsSync(app)) return app
  }
  throw new Error(`no Clave.app under ${DIST_APPS.map((s) => path.join(distDir, s)).join(', ')}`)
}

/** Run the probe in the packaged binary; resolve to its parsed report. */
export function probePackagedApp(appPath) {
  const { binary, asar } = locateApp(path.resolve(appPath))
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
  const args = process.argv.slice(2)
  const appPath = args[0] === '--dist' && args[1] ? pickPackagedApp(args[1]) : args[0]
  if (!appPath || appPath === '--dist') {
    console.error(
      'usage: node scripts/check-packaged-requires.mjs <path/to/Clave.app> | --dist <dir>'
    )
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
      `  found, threw in the probe (not counted): ${r.spec} — ${r.message.split('\n')[0]}`
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
