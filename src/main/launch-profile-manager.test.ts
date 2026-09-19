import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sessionManager } from './sessions/session-manager'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { LaunchProfileManager, isEchoLaunchProfile } from './launch-profile-manager'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

function withManager(test: (manager: LaunchProfileManager, filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-launch-profiles-'))
  try {
    const filePath = path.join(dir, 'profiles.json')
    test(new LaunchProfileManager(filePath), filePath)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('LaunchProfileManager', () => {
  it('persists custom profiles with global and workspace defaults', () => {
    withManager((manager, filePath) => {
      manager.upsert({
        id: 'tokenops-claude',
        name: 'Claude through TokenOps',
        family: 'claude',
        command: ['tokenops', 'run', '--', 'env', '-u', 'ANTHROPIC_API_KEY', 'claude'],
        additionalArgs: []
      })
      manager.setGlobalDefault('claude', 'tokenops-claude')
      manager.setWorkspaceDefault('workspace-1', 'claude', 'tokenops-claude')

      const reloaded = new LaunchProfileManager(filePath)
      expect(reloaded.resolve('claude').command).toEqual([
        'tokenops',
        'run',
        '--',
        'env',
        '-u',
        'ANTHROPIC_API_KEY',
        'claude'
      ])
      expect(reloaded.resolve('claude', 'workspace-1').id).toBe('tokenops-claude')
      if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    })
  })

  it('removes stale defaults when a custom profile is deleted', () => {
    withManager((manager) => {
      manager.upsert({
        id: 'pi-custom',
        name: 'Pi custom',
        family: 'pi',
        command: ['pi'],
        additionalArgs: []
      })
      manager.setGlobalDefault('pi', 'pi-custom')
      manager.setWorkspaceDefault('workspace-1', 'pi', 'pi-custom')

      const preferences = manager.delete('pi-custom')
      expect(preferences.customProfiles).toEqual([])
      expect(preferences.globalDefaults.pi).toBeUndefined()
      expect(preferences.workspaceOverrides['workspace-1']?.pi).toBeUndefined()
      expect(manager.resolve('pi', 'workspace-1').id).toBe('builtin-pi')
    })
  })

  it('falls back to built-ins when persisted JSON is malformed', () => {
    withManager((_manager, filePath) => {
      fs.writeFileSync(filePath, '{nope')
      expect(new LaunchProfileManager(filePath).resolve('codex').id).toBe('builtin-codex')
    })
  })

  it('does not allow a custom profile to replace an immutable built-in', () => {
    withManager((manager) => {
      expect(() =>
        manager.upsert({
          id: 'builtin-claude',
          name: 'Replaced Claude',
          family: 'claude',
          command: ['other-claude'],
          additionalArgs: []
        })
      ).toThrow('Invalid launch profile')
      expect(manager.resolve('claude').command).toEqual(['claude'])
    })
  })

  it('rejects malformed workspace override keys', () => {
    withManager((manager) => {
      expect(() => manager.setWorkspaceDefault('../other', 'pi', 'builtin-pi')).toThrow(
        'Invalid workspace id'
      )
    })
  })
})

it('echo detection is a non-throwing predicate and resolution does not clone preferences', () => {
  const clone = vi.spyOn(globalThis, 'structuredClone')
  try {
    expect(isEchoLaunchProfile('dev-echo-adapter')).toBe(false)
    expect(isEchoLaunchProfile('builtin-claude')).toBe(false)
    expect(isEchoLaunchProfile(null)).toBe(false)
    withManager((manager) => expect(manager.resolve('claude').id).toBe('builtin-claude'))
    expect(clone).not.toHaveBeenCalled()
  } finally {
    clone.mockRestore()
  }
})

it('lists event profiles only with registered adapters and hides Claude chat on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const lookup = vi.spyOn(sessionManager, 'getAdapter').mockReturnValue(undefined)
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    withManager((manager) => {
      expect(manager.getPreferences().customProfiles).toEqual([])
      lookup.mockReturnValue(new EchoAdapter())
      expect(manager.getPreferences().customProfiles.map((profile) => profile.id)).toEqual([
        'claude-chat',
        'codex-chat'
      ])
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(manager.getPreferences().customProfiles.map((profile) => profile.id)).toEqual([
        'codex-chat'
      ])
      expect(() => manager.setGlobalDefault('claude', 'claude-chat')).toThrow(
        'Unknown launch profile'
      )
    })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    lookup.mockRestore()
  }
})

it('keeps the development echo profile exclusive to the Claude family', async () => {
  const argv = process.argv.slice()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-echo-family-'))
  try {
    process.argv.push('--dev-echo-adapter')
    vi.resetModules()
    const { LaunchProfileManager: DevManager } = await import('./launch-profile-manager')
    const manager = new DevManager(path.join(dir, 'profiles.json'))
    expect(() => manager.setGlobalDefault('codex', 'dev-echo-adapter')).toThrow(/Claude-family/)
    expect(manager.setGlobalDefault('claude', 'dev-echo-adapter').globalDefaults.claude).toBe(
      'dev-echo-adapter'
    )
  } finally {
    process.argv.splice(0, process.argv.length, ...argv)
    fs.rmSync(dir, { recursive: true, force: true })
    vi.resetModules()
  }
})
