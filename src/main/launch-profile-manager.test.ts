import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sessionManager } from './sessions/session-manager'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { syncPluginAdapters } from './sessions/plugin-adapters'
import type { PluginRecord } from './plugins/plugin-store'
import { LaunchProfileManager, eventsProfile, isEchoLaunchProfile } from './launch-profile-manager'

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

/** A store record for a plugin contributing one adapter, as the registry reads it. */
function adapterPlugin(enabled: boolean): PluginRecord {
  return {
    id: 'acme.agent',
    version: '1.0.0',
    source: 'bundled',
    enabled,
    permissionsGranted: ['sessions.write'],
    installedAt: new Date().toISOString(),
    directory: '/tmp/acme-agent',
    contentDigest: 'digest',
    status: 'active',
    panels: [],
    commands: [],
    toolbar: [],
    generation: 0,
    manifest: {
      id: 'acme.agent',
      name: 'Acme agent',
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '>=1.0.0' },
      ui: 'none',
      uiEntry: undefined,
      permissions: ['sessions.write'],
      contributes: {
        panels: [],
        commands: [],
        toolbar: [],
        sidebarSections: [],
        views: [],
        adapters: [
          {
            id: 'acme-agent',
            name: 'Acme (plugin)',
            entry: 'provider.cjs',
            command: ['acme', '--stdio'],
            capabilities: { permissions: true, questions: false, resume: false }
          }
        ]
      }
    } as PluginRecord['manifest']
  }
}

it('refuses a stored default whose plugin is switched off, instead of starting a terminal', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const echo = new EchoAdapter()
  const lookup = vi
    .spyOn(sessionManager, 'getAdapter')
    .mockImplementation((id: string) =>
      id === 'claude-chat' || id === 'codex-chat' ? echo : undefined
    )
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    syncPluginAdapters({ list: () => [adapterPlugin(true)] })
    withManager((manager) => {
      manager.setGlobalDefault('claude', 'acme-agent')
      expect(manager.resolve('claude').id).toBe('acme-agent')
      // Switched off, the stored default still points at it. The shared resolver
      // would hand back the family's built-in, which is a terminal Claude.
      syncPluginAdapters({ list: () => [adapterPlugin(false)] })
      expect(() => manager.resolve('claude')).toThrow(
        'Acme (plugin) is not enabled; enable it in Settings → Plugins'
      )
      // Uninstalled entirely, it is still named rather than silently replaced.
      syncPluginAdapters({ list: () => [] })
      expect(() => manager.resolve('claude')).toThrow('Acme (plugin) is no longer installed')
      // A workspace override is the same story.
      manager.setWorkspaceDefault('workspace-1', 'claude', null)
      expect(() => manager.resolve('claude', 'workspace-1')).toThrow('no longer installed')
    })
  } finally {
    syncPluginAdapters({ list: () => [] })
    Object.defineProperty(process, 'platform', { value: platform.value })
    lookup.mockRestore()
  }
})

it('leaves an ordinary deleted profile to the built-in fallback', () => {
  withManager((manager) => {
    manager.upsert({
      id: 'gone-custom',
      name: 'Gone',
      family: 'claude',
      command: ['x'],
      additionalArgs: []
    })
    manager.setGlobalDefault('claude', 'gone-custom')
    manager.delete('gone-custom')
    // Nothing to name and nothing to refuse: this is what the fallback is for.
    expect(manager.resolve('claude').id).toBe('builtin-claude')
  })
})

it('derives a launch profile from an enabled adapter plugin and hides it once disabled', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const echo = new EchoAdapter()
  const lookup = vi
    .spyOn(sessionManager, 'getAdapter')
    .mockImplementation((id: string) =>
      id === 'claude-chat' || id === 'codex-chat' ? echo : undefined
    )
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    syncPluginAdapters({ list: () => [adapterPlugin(true)] })
    withManager((manager) => {
      const profiles = manager.getPreferences().customProfiles
      expect(profiles.map((profile) => profile.id)).toEqual([
        'claude-chat',
        'codex-chat',
        'acme-agent'
      ])
      const acme = profiles.find((profile) => profile.id === 'acme-agent')!
      // The command is the manifest's, verbatim, and the profile joins the Claude family.
      expect(acme.command).toEqual(['acme', '--stdio'])
      expect(acme.name).toBe('Acme (plugin)')
      expect(acme.family).toBe('claude')
      expect(manager.resolve('claude', null, 'acme-agent').id).toBe('acme-agent')
      // It is an events profile, so it is reserved against a user-authored one.
      expect(() =>
        manager.upsert({
          id: 'acme-agent',
          name: 'Mine',
          family: 'claude',
          command: ['mine'],
          additionalArgs: []
        })
      ).toThrow('Reserved events profile')
    })
    syncPluginAdapters({ list: () => [adapterPlugin(false)] })
    withManager((manager) => {
      expect(manager.getPreferences().customProfiles.map((profile) => profile.id)).toEqual([
        'claude-chat',
        'codex-chat'
      ])
    })
    // Disabled hides new launches; the id still resolves to its adapter, so a
    // stale launch is refused by name instead of silently starting a shell.
    expect(eventsProfile('acme-agent')?.adapterId).toBe('acme-agent')
  } finally {
    syncPluginAdapters({ list: () => [] })
    Object.defineProperty(process, 'platform', platform)
    lookup.mockRestore()
  }
})
