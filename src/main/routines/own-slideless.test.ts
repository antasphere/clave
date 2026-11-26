import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtefactRefusal } from '../artefacts/refusal'
import {
  CLOUD,
  DECKS,
  FakeChild,
  listedProfile,
  listingJson
} from '../artefacts/slideless.test-support'
import { ownSlideless } from './own-slideless'

/**
 * The publisher's road to the server's own copy (PRDCT-4266), over a data folder of the
 * test's own and a fake spawn: the copy under `slideless/cli` run by the Node it is told in
 * the server's environment, the « New links go to » the accounts write beside it, and the
 * origins of the saved profiles of the plain listing.
 */

const EXEC_PATH = '/Applications/Clave.app/Contents/MacOS/Clave'
const ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/srv/home' }
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'clave-own-slideless-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** A copy installed as Clave installs one; answers its script. */
function install(version: string): string {
  const cliDir = join(dataDir, 'slideless', 'cli')
  mkdirSync(join(cliDir, version), { recursive: true })
  const bin = join(cliDir, version, 'bin.js')
  writeFileSync(bin, '// slideless\n')
  writeFileSync(join(cliDir, 'current.json'), JSON.stringify({ version }))
  return bin
}

/** A spawn that records each call and answers the listing to `--json profiles`, nothing to anything else. */
function fakeSpawn(listing = listingJson([])): {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  calls: Array<{ command: string; args: string[]; options: SpawnOptions }>
} {
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = []
  return {
    calls,
    spawn: (command, args, options) => {
      const child = new FakeChild()
      calls.push({ command, args, options })
      queueMicrotask(() => {
        if (args[1] === '--json' && args[2] === 'profiles') child.print(listing)
        child.exit(0)
      })
      return child as unknown as ChildProcess
    }
  }
}

describe("the publisher's road to the server's own copy", () => {
  it('refuses every run, and lists no site, while the server has no copy', async () => {
    const { spawn, calls } = fakeSpawn()
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn })
    await expect(
      own.run(['--json', 'profiles'], { cwd: dataDir, timeoutMs: 1000 })
    ).rejects.toBeInstanceOf(ArtefactRefusal)
    await expect(own.sites()).rejects.toThrow(/not installed/)
    expect(calls).toEqual([])
  })

  it('runs the copy under the data folder with the Node it is told, in the server’s environment', async () => {
    const bin = install('0.15.0')
    const { spawn, calls } = fakeSpawn()
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn })
    const run = await own.run(['--api-url', DECKS, '--json', 'versions', 'deck-1'], {
      cwd: '/data/decks/r/run-1',
      timeoutMs: 30_000
    })
    expect(run).toMatchObject({ code: 0, timedOut: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe(EXEC_PATH)
    expect(calls[0]!.args).toEqual([bin, '--api-url', DECKS, '--json', 'versions', 'deck-1'])
    expect(calls[0]!.options.env).toEqual({ ...ENV, ELECTRON_RUN_AS_NODE: '1' })
    expect(calls[0]!.options.cwd).toBe('/data/decks/r/run-1')
  })

  it('reads the machine’s « New links go to » the accounts write in the same folder, in normal form', async () => {
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn: fakeSpawn().spawn })
    expect(await own.newLinksSite()).toBeNull()
    writeFileSync(
      join(dataDir, 'slideless-settings.json'),
      JSON.stringify({ v: 1, newLinksSite: 'HTTPS://Decks.Example.Test/' })
    )
    expect(await own.newLinksSite()).toBe(DECKS)
  })

  it('lists the origins of the machine’s saved profiles, in normal form, from the plain listing', async () => {
    install('0.15.0')
    const listing = listingJson([
      listedProfile(DECKS),
      listedProfile('HTTPS://Cloud.Example.Test/', null, 'cloud'),
      { ...listedProfile('https://env.example.test', null, 'env'), saved: false }
    ])
    const { spawn, calls } = fakeSpawn(listing)
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn })
    expect(await own.sites()).toEqual([DECKS, CLOUD])
    expect(calls.map((call) => call.args.slice(1))).toEqual([['--json', 'profiles']])
  })

  it('lists no site with a copy too old to list them: the sentence an update cures', async () => {
    install('0.14.2')
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn: fakeSpawn().spawn })
    await expect(own.sites()).rejects.toThrow(/0\.15\.0 or later/)
  })

  it('runs nothing on a copy older than 0.15.0: a routine deck names its site, which older copies cannot', async () => {
    install('0.14.1')
    const { spawn, calls } = fakeSpawn()
    const own = ownSlideless({ dataDir, execPath: EXEC_PATH, env: ENV, spawn })
    await expect(
      own.run(['--api-url', 'https://decks.example.test', '--json', 'push'], {
        cwd: dataDir,
        timeoutMs: 1000
      })
    ).rejects.toThrow("Clave's Slideless is 0.14.1; routine decks need 0.15.0 or later")
    expect(calls).toEqual([])
  })
})
