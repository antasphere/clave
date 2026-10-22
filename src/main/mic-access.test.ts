import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const system = vi.hoisted(() => ({
  status: 'not-determined',
  packaged: false,
  ask: vi.fn(async () => true),
  open: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return system.packaged
    }
  },
  systemPreferences: {
    getMediaAccessStatus: () => system.status,
    askForMediaAccess: system.ask
  },
  shell: { openExternal: system.open }
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
async function on(os: string): Promise<typeof import('./mic-access')> {
  Object.defineProperty(process, 'platform', { value: os })
  vi.resetModules()
  return import('./mic-access')
}

describe('the client machine microphone settings', () => {
  beforeEach(() => {
    system.status = 'not-determined'
    system.packaged = false
    vi.clearAllMocks()
  })
  afterEach(() => Object.defineProperty(process, 'platform', platform))

  it('asks macOS only while permission is undetermined, then reads the fresh state', async () => {
    const mic = await on('darwin')
    system.ask.mockImplementationOnce(async () => {
      system.status = 'granted'
      return true
    })
    expect((await mic.requestMicAccess()).status).toBe('granted')
    await mic.requestMicAccess()
    expect(system.ask).toHaveBeenCalledExactlyOnceWith('microphone')
    for (const status of ['denied', 'restricted', 'unknown']) {
      system.status = status
      await mic.requestMicAccess()
    }
    expect(system.ask).toHaveBeenCalledTimes(1)
  })

  it('reports the source-launch caveat only for unpackaged, ungranted macOS', async () => {
    const mic = await on('darwin')
    expect(mic.getMicAccessState().devPermissionCaveat).toBe(true)
    system.packaged = true
    expect(mic.getMicAccessState().devPermissionCaveat).toBe(false)
    system.packaged = false
    system.status = 'granted'
    expect(mic.getMicAccessState().devPermissionCaveat).toBe(false)
  })

  it.each([
    [
      'darwin',
      'x-apple.systempreferences:com.apple.preference.sound',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    ],
    ['win32', 'ms-settings:sound', 'ms-settings:privacy-microphone']
  ])('opens separate Sound and Privacy panes on %s', async (os, sound, privacy) => {
    const mic = await on(os)
    await mic.openSoundSettings()
    await mic.openMicPrivacySettings()
    expect(system.open.mock.calls).toEqual([[sound], [privacy]])
    if (os === 'win32') {
      await mic.requestMicAccess()
      expect(system.ask).not.toHaveBeenCalled()
    }
  })

  it('reports an unknown status and opens no native settings on Linux', async () => {
    const mic = await on('linux')
    expect(await mic.requestMicAccess()).toEqual({
      status: 'unknown',
      devPermissionCaveat: false,
      canOpenSettings: false
    })
    await mic.openSoundSettings()
    await mic.openMicPrivacySettings()
    expect(system.ask).not.toHaveBeenCalled()
    expect(system.open).not.toHaveBeenCalled()
  })
})
