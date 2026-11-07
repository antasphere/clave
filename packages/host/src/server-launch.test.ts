import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The launch decision the whole shell reads (`server-launch.ts`): taken from
 * the environment, the command line, whether the app is packaged and the
 * platform, the same four inputs main's boot used to read on its own. The
 * settings source reads this module too, so what a packaged app decides here
 * is what decides whether the shell builds an Antasphere account manager
 * (`settings/shell-source.test.ts` pins that side).
 */
const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))
vi.mock('electron', () => electron)

const original = { argv: process.argv, platform: process.platform }
const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

async function launch({
  argv = [] as string[],
  packaged = false,
  platform = 'darwin' as NodeJS.Platform,
  env = {} as Record<string, string>
} = {}): Promise<typeof import('./server-launch').serverLaunch> {
  vi.resetModules()
  electron.app.isPackaged = packaged
  process.argv = ['electron', '.', ...argv]
  setPlatform(platform)
  delete process.env.CLAVE_SERVER_URL
  delete process.env.CLAVE_SERVER_TOKEN
  Object.assign(process.env, env)
  return (await import('./server-launch')).serverLaunch
}

afterEach(() => {
  process.argv = original.argv
  setPlatform(original.platform)
  delete process.env.CLAVE_SERVER_URL
  delete process.env.CLAVE_SERVER_TOKEN
  vi.restoreAllMocks()
})

describe('the launch decision the whole shell reads', () => {
  it('a packaged app on macOS with no flag runs the separate server: what the installed app decides', async () => {
    expect(await launch({ packaged: true, platform: 'darwin' })).toEqual({ mode: 'separate' })
  })

  it('a development run is in-process, and the flag wins over the packaged default', async () => {
    expect(await launch({ packaged: false })).toEqual({ mode: 'in-process' })
    expect(await launch({ packaged: true, argv: ['--server=in-process'] })).toEqual({
      mode: 'in-process'
    })
    expect(await launch({ packaged: false, argv: ['--server=separate'] })).toEqual({
      mode: 'separate'
    })
  })

  it('a packaged app elsewhere than macOS stays in-process', async () => {
    expect(await launch({ packaged: true, platform: 'win32' })).toEqual({ mode: 'in-process' })
    expect(await launch({ packaged: true, platform: 'linux' })).toEqual({ mode: 'in-process' })
  })

  it('the environment attaches, and the two variables are taken out of it', async () => {
    expect(
      await launch({
        packaged: true,
        env: { CLAVE_SERVER_URL: 'http://127.0.0.1:4790/', CLAVE_SERVER_TOKEN: 'abc' }
      })
    ).toEqual({ mode: 'attached', url: 'http://127.0.0.1:4790', token: 'abc' })
    expect(process.env.CLAVE_SERVER_URL).toBeUndefined()
    expect(process.env.CLAVE_SERVER_TOKEN).toBeUndefined()
  })

  it('a read that throws fails as itself, never as a flag error with exit 2 (an Electron with no app)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stand = electron as { app?: { isPackaged: boolean } }
    stand.app = undefined
    try {
      vi.resetModules()
      process.argv = ['electron', '.']
      await expect(import('./server-launch')).rejects.toThrow(/isPackaged/)
      expect(exit).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stand.app = { isPackaged: false }
    }
  })

  it('a flag that is not a mode ends the launch with the sentence on stderr and exit code 2', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(launch({ argv: ['--server=standalone'] })).rejects.toThrow('exited')
    expect(exit).toHaveBeenCalledWith(2)
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('--server must be in-process or separate, got "standalone"')
    )
  })
})
