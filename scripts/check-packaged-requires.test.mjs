/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test helpers */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probePackagedApp } from './check-packaged-requires.mjs'

// The checker against a fake app bundle: `Contents/MacOS/<bin>` is this Node
// (which ignores ELECTRON_RUN_AS_NODE and runs the probe all the same) and
// `app.asar` is a plain DIRECTORY, which Node reads where Electron would read
// the archive. The real thing, the packaged app under its own Electron, is
// what the release and CI run (scripts/release.sh, checks.yml); this pins the
// checker's own logic on any machine. The case that matters is the 2.2.0
// one: a package that IS packed and whose index requires a peer that is NOT.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-packaged-requires.mjs'
)

let root
function fakeApp(files) {
  const app = path.join(root, 'Fake.app')
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar')
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  symlinkSync(process.execPath, path.join(app, 'Contents', 'MacOS', 'Fake'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(asar, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return app
}
const pkg = (name, main = 'index.js') => JSON.stringify({ name, version: '1.0.0', main })

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'clave-packaged-requires-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('check-packaged-requires', () => {
  it('flags a packed package whose index requires a peer that was not packed (the 2.2.0 defect)', () => {
    const app = fakeApp({
      'out/main/index.js': 'require("./chunks/server.js")\n',
      'out/main/chunks/server.js':
        'require("platform-x"); require("node:fs"); require("electron")\n',
      'node_modules/platform-x/package.json': pkg('platform-x'),
      'node_modules/platform-x/index.js': 'require("./ClusterHttp.js")\n',
      'node_modules/platform-x/ClusterHttp.js': 'require("cluster-x/HttpRunner")\n'
    })
    const report = probePackagedApp(app)
    const bad = report.results.filter((r) => !r.ok && r.missing)
    expect(bad.map((r) => r.spec)).toEqual(['platform-x'])
    expect(bad[0].from).toBe(path.join('out', 'main', 'chunks', 'server.js'))
    expect(bad[0].message).toMatch(/Cannot find module 'cluster-x\/HttpRunner'/)
    // Builtins and electron are never probed.
    expect(report.results.map((r) => r.spec)).toEqual(['platform-x'])

    const cli = spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8' })
    expect(cli.status).toBe(1)
    expect(cli.stderr).toMatch(/FAIL: 1 module\(s\) the packaged app cannot load/)
  })

  it('passes once the peer is packed, and scans out/preload too', () => {
    const app = fakeApp({
      'out/main/index.js': "require('platform-x')\n",
      'out/preload/index.js': 'require("preload-dep")\n',
      'node_modules/platform-x/package.json': pkg('platform-x'),
      'node_modules/platform-x/index.js': 'require("cluster-x/HttpRunner")\n',
      'node_modules/cluster-x/package.json': pkg('cluster-x'),
      'node_modules/cluster-x/HttpRunner.js': 'module.exports = {}\n',
      'node_modules/preload-dep/package.json': pkg('preload-dep'),
      'node_modules/preload-dep/index.js': 'module.exports = {}\n'
    })
    const report = probePackagedApp(app)
    expect(report.results.map((r) => [r.spec, r.ok])).toEqual([
      ['platform-x', true],
      ['preload-dep', true]
    ])
    const cli = spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8' })
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/OK: every external module loads from the asar/)
  })

  it('flags a top-level external that is missing outright', () => {
    const app = fakeApp({ 'out/main/index.js': 'require("not-packed")\n' })
    const report = probePackagedApp(app)
    expect(report.results).toEqual([
      expect.objectContaining({ spec: 'not-packed', ok: false, missing: true })
    ])
  })

  it('does not count a module that is found and only fails for want of Electron', () => {
    const app = fakeApp({
      'out/main/index.js': 'require("wants-electron")\n',
      'node_modules/wants-electron/package.json': pkg('wants-electron'),
      'node_modules/wants-electron/index.js': 'require("electron").app.getPath("userData")\n'
    })
    const report = probePackagedApp(app)
    expect(report.results).toEqual([
      expect.objectContaining({ spec: 'wants-electron', ok: false, missing: false })
    ])
    const cli = spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8' })
    expect(cli.status).toBe(0)
  })

  it('refuses an app with no bundle rather than passing it empty', () => {
    const app = fakeApp({ 'package.json': pkg('clave') })
    expect(() => probePackagedApp(app)).toThrow(/no bundle under/)
    const cli = spawnSync(process.execPath, [SCRIPT, app], { encoding: 'utf8' })
    expect(cli.status).toBe(1)
  })
})
