import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LaunchProfileManager } from './launch-profile-manager'
import type { LaunchProfile } from '../shared/agent-launch'

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
  it('derives provider defaults without persisting them or losing disabled-provider preferences', () => {
    withManager((_manager, filePath) => {
      const provider = {
        id: 'builtin-test.provider',
        name: 'Installed provider',
        family: 'test.provider',
        command: ['provider-wrapper', 'serve'],
        additionalArgs: [],
        builtIn: true
      }
      let available = true
      const catalog = (): LaunchProfile[] => (available ? [provider] : [])
      const manager = new LaunchProfileManager(filePath, catalog)
      manager.upsert({
        ...provider,
        id: 'custom-provider',
        name: 'Custom provider',
        builtIn: false
      })
      manager.setGlobalDefault('test.provider', 'custom-provider')
      manager.setWorkspaceDefault('work', 'test.provider', provider.id)
      expect(manager.resolve('test.provider', 'work').command).toEqual([
        'provider-wrapper',
        'serve'
      ])
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).not.toHaveProperty('defaultProfiles')
      available = false
      const reloaded = new LaunchProfileManager(filePath, catalog)
      expect(reloaded.getPreferences().customProfiles).toHaveLength(1)
      expect(reloaded.getPreferences().workspaceOverrides.work['test.provider']).toBe(provider.id)
      expect(reloaded.getPreferences().defaultProfiles).toEqual([])
      available = true
      expect(reloaded.resolve('test.provider', 'work').id).toBe(provider.id)
      expect(() => reloaded.resolve('test.provider', 'work', 'deleted')).toThrow(
        'Unknown launch profile'
      )
      expect(() => reloaded.resolve('opencode', 'work', 'custom-provider')).toThrow(
        'does not match provider'
      )
    })
  })

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
