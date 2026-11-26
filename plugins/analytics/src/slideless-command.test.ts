import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SLIDELESS_ENV, installedBin, slidelessCommand } from './slideless-command'
import { NOTES } from './viewer'

/**
 * The viewer's command from what the plugin host tells the plugin process (PRDCT-4499): the
 * override when its file exists, else the copy installed under the folder named, run by the
 * Node named under the host named; any of them missing, nothing to run. Files in a folder of
 * the test's own, no process started.
 */

let dir: string
let node: string
let host: string
let cliDir: string
/** The plugin's own environment, as the host hands it. */
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clave-analytics-slideless-'))
  node = join(dir, 'Clave')
  host = join(dir, 'slideless', 'preview-host.mjs')
  cliDir = join(dir, 'slideless', 'cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(node, '')
  writeFileSync(host, '// the preview host\n')
  env = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    CLAVE_PLUGIN_DATA_DIR: join(dir, 'data'),
    [SLIDELESS_ENV.node]: node,
    [SLIDELESS_ENV.host]: host,
    [SLIDELESS_ENV.cliDir]: cliDir
  }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A copy installed the way Clave installs one: its folder, then `current.json` naming it. */
function install(version: string): string {
  mkdirSync(join(cliDir, version), { recursive: true })
  const bin = join(cliDir, version, 'bin.js')
  writeFileSync(bin, '// slideless\n')
  writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version }))
  return bin
}

describe("the Analytics viewer's command", () => {
  it('runs the installed copy with the Node named, under the host, in the plugin’s own environment', () => {
    const bin = install('0.15.0')
    expect(slidelessCommand(env)).toEqual({
      file: node,
      args: [host, bin],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('runs the override when its file exists, else the installed copy', () => {
    const bin = install('0.15.0')
    const override = join(dir, 'checkout', 'dist', 'bin.js')
    mkdirSync(join(dir, 'checkout', 'dist'), { recursive: true })
    writeFileSync(override, '// a checkout\n')
    const told = { ...env, [SLIDELESS_ENV.override]: override }
    expect(slidelessCommand(told)).toMatchObject({ file: node, args: [host, override] })
    rmSync(override)
    expect(slidelessCommand(told)).toMatchObject({ file: node, args: [host, bin] })
  })

  it('has nothing to run when the Node, the host or a copy is missing', () => {
    const missing = { missing: NOTES.missing }
    // No copy installed, and no override.
    expect(slidelessCommand(env)).toEqual(missing)
    install('0.15.0')
    expect(slidelessCommand(env)).not.toEqual(missing)
    // Each variable the host sets, absent or blank.
    for (const key of [SLIDELESS_ENV.node, SLIDELESS_ENV.host, SLIDELESS_ENV.cliDir]) {
      expect(slidelessCommand({ ...env, [key]: undefined })).toEqual(missing)
      expect(slidelessCommand({ ...env, [key]: '  ' })).toEqual(missing)
    }
    // A variable naming a file that is not there.
    expect(slidelessCommand({ ...env, [SLIDELESS_ENV.node]: join(dir, 'gone') })).toEqual(missing)
    expect(slidelessCommand({ ...env, [SLIDELESS_ENV.host]: join(dir, 'gone.mjs') })).toEqual(
      missing
    )
    // An override that names no file, with no copy installed either.
    rmSync(join(cliDir, 'current.json'))
    expect(slidelessCommand({ ...env, [SLIDELESS_ENV.override]: join(dir, 'nope.js') })).toEqual(
      missing
    )
  })

  it('reads the installed copy as Clave writes it: current.json naming a version whose bin.js is there', () => {
    expect(installedBin(cliDir)).toBeNull()
    const bin = install('0.15.2')
    expect(installedBin(cliDir)).toBe(bin)
    // A version whose folder lost its file, a name that is no version, a document that is no JSON.
    writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version: '0.16.0' }))
    expect(installedBin(cliDir)).toBeNull()
    writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version: '../../elsewhere' }))
    expect(installedBin(cliDir)).toBeNull()
    writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version: 15 }))
    expect(installedBin(cliDir)).toBeNull()
    writeFileSync(join(cliDir, 'current.json'), '{ not json')
    expect(installedBin(cliDir)).toBeNull()
  })

  it('reads the folder again at every start: a copy installed between two starts is the one the second runs', () => {
    expect(slidelessCommand(env)).toEqual({ missing: NOTES.missing })
    const bin = install('0.15.0')
    expect(slidelessCommand(env)).toMatchObject({ args: [host, bin] })
    // An update swaps current.json to the new version: the next start runs it.
    const next = install('0.15.1')
    expect(slidelessCommand(env)).toMatchObject({ args: [host, next] })
  })
})
