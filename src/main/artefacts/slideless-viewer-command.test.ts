import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NOTES } from '../../../plugins/analytics/src/viewer'
import { PREVIEW_HOST_SOURCE, previewHostPath } from './preview-host'
import { viewerCommand } from './slideless-viewer-command'

/**
 * The command a viewer runs (PRDCT-4499): the server's own copy under its data folder, or the
 * override, run by the Node it was told under the preview host, in the server's own
 * environment and `ELECTRON_RUN_AS_NODE`; no copy, nothing to run. Files in a folder of the
 * test's own, no process started.
 */

const EXEC_PATH = '/Applications/Clave.app/Contents/MacOS/Clave'
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'clave-viewer-command-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** A copy installed as Clave installs one. */
function install(version: string): string {
  const cliDir = join(dataDir, 'slideless', 'cli')
  mkdirSync(join(cliDir, version), { recursive: true })
  const bin = join(cliDir, version, 'bin.js')
  writeFileSync(bin, '// slideless\n')
  writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version }))
  return bin
}

describe("a viewer's command", () => {
  it('has nothing to run while the server has no copy, and writes no host for it', async () => {
    const env = { PATH: '/usr/bin:/bin' }
    expect(await viewerCommand({ dataDir, execPath: EXEC_PATH, env })).toEqual({
      missing: NOTES.missing
    })
    expect(existsSync(previewHostPath(dataDir))).toBe(false)
    // A copy older than the previews need is no copy to run either.
    install('0.13.12')
    expect(await viewerCommand({ dataDir, execPath: EXEC_PATH, env })).toEqual({
      missing: NOTES.missing
    })
  })

  it('runs the installed copy with the Node it is told, under the preview host it writes', async () => {
    const bin = install('0.15.0')
    const command = await viewerCommand({ dataDir, execPath: EXEC_PATH, env: { PATH: '/bin' } })
    const host = previewHostPath(dataDir)
    expect(command).toEqual({
      file: EXEC_PATH,
      args: [host, bin],
      env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(readFileSync(host, 'utf8')).toBe(PREVIEW_HOST_SOURCE)
  })

  it('runs the override when the server’s environment names one that exists', async () => {
    install('0.15.0')
    const override = join(dataDir, 'checkout-bin.js')
    writeFileSync(override, '// a checkout\n')
    const command = await viewerCommand({
      dataDir,
      execPath: EXEC_PATH,
      env: { CLAVE_SLIDELESS_CLI: override }
    })
    expect(command).toMatchObject({ args: [previewHostPath(dataDir), override] })
    // An override that names no file is no copy to run.
    expect(
      await viewerCommand({
        dataDir,
        execPath: EXEC_PATH,
        env: { CLAVE_SLIDELESS_CLI: join(dataDir, 'nope.js') }
      })
    ).toEqual({ missing: NOTES.missing })
  })

  it('hands the child the server’s own environment, as strings, with ELECTRON_RUN_AS_NODE set', async () => {
    install('0.15.0')
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/srv/home',
      ELECTRON_RUN_AS_NODE: undefined,
      UNSET: undefined
    }
    const command = await viewerCommand({ dataDir, execPath: EXEC_PATH, env })
    expect('missing' in command).toBe(false)
    if ('missing' in command) return
    expect(command.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/srv/home',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })
})
