import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  buildAgentArgv,
  resolveLaunchProfile,
  sanitizeLaunchProfilePreferences,
  type LaunchProfile,
  type LaunchProfilePreferences
} from './agent-launch'

const prefs: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [
    {
      id: 'tokenops-claude',
      name: 'Claude through TokenOps',
      family: 'claude',
      command: ['tokenops', 'run', '--', 'env', '-u', 'ANTHROPIC_API_KEY', 'claude'],
      additionalArgs: ['--verbose']
    },
    {
      id: 'work-claude',
      name: 'Work Claude',
      family: 'claude',
      command: ['work-claude'],
      additionalArgs: []
    }
  ],
  globalDefaults: { claude: 'tokenops-claude' },
  workspaceOverrides: { workspace: { claude: 'work-claude' } }
}

describe('launch profile policy', () => {
  it('fails closed for explicit missing profiles, wrong families, and unknown providers', () => {
    expect(() => resolveLaunchProfile(prefs, 'claude', 'workspace', 'missing')).toThrow(
      'Unknown launch profile'
    )
    expect(() => resolveLaunchProfile(prefs, 'pi', 'workspace', 'tokenops-claude')).toThrow(
      'does not match provider pi'
    )
    expect(() => resolveLaunchProfile(prefs, 'missing.provider')).toThrow('No launch profile')
  })

  it.each(['opencode', 'test.installed-provider'])(
    'resolves all priority levels for %s',
    (family) => {
      const profile = (id: string): LaunchProfile => ({
        id,
        family,
        name: id,
        command: ['wrapper', id],
        additionalArgs: ['--custom']
      })
      const preferences: LaunchProfilePreferences = {
        version: 1,
        defaultProfiles: [{ ...profile(`builtin-${family}`), builtIn: true }],
        customProfiles: ['global', 'workspace', 'explicit'].map(profile),
        globalDefaults: { [family]: 'global' },
        workspaceOverrides: { work: { [family]: 'workspace' } }
      }
      expect(resolveLaunchProfile(preferences, family, 'work', 'explicit').id).toBe('explicit')
      expect(resolveLaunchProfile(preferences, family, 'work').id).toBe('workspace')
      expect(resolveLaunchProfile(preferences, family).id).toBe('global')
      expect(resolveLaunchProfile({ ...preferences, globalDefaults: {} }, family).id).toBe(
        `builtin-${family}`
      )
      const saved = sanitizeLaunchProfilePreferences(JSON.parse(JSON.stringify(preferences)))
      expect(saved).toEqual({ ...preferences, defaultProfiles: undefined })
    }
  )

  it('resolves explicit, workspace, global, then built-in profiles', () => {
    expect(resolveLaunchProfile(prefs, 'claude', 'workspace', 'tokenops-claude').id).toBe(
      'tokenops-claude'
    )
    expect(resolveLaunchProfile(prefs, 'claude', 'workspace').id).toBe('work-claude')
    expect(resolveLaunchProfile(prefs, 'claude', 'other').id).toBe('tokenops-claude')
    expect(resolveLaunchProfile(prefs, 'pi', 'workspace').id).toBe('builtin-pi')
  })

  it('falls back after a selected custom profile is deleted', () => {
    const deleted = { ...prefs, customProfiles: prefs.customProfiles.slice(0, 1) }
    expect(resolveLaunchProfile(deleted, 'claude', 'workspace').id).toBe('tokenops-claude')
  })

  it('drops malformed and conflicting persisted profiles', () => {
    const parsed = sanitizeLaunchProfilePreferences({
      version: 1,
      customProfiles: [
        { id: 'ok', name: 'OK', family: 'pi', command: ['pi'], additionalArgs: ['--color'] },
        { id: 'bad', name: 'Bad', family: 'pi', command: [], additionalArgs: [] },
        {
          id: 'managed',
          name: 'Managed',
          family: 'pi',
          command: ['pi'],
          additionalArgs: ['--session-dir', '/tmp']
        },
        {
          id: 'managed-command',
          name: 'Managed in command',
          family: 'pi',
          command: ['pi', '--session-dir=/tmp'],
          additionalArgs: []
        }
      ],
      globalDefaults: { pi: 'ok' },
      workspaceOverrides: {}
    })
    expect(parsed.customProfiles.map((profile) => profile.id)).toEqual(['ok'])
  })
})

describe('agent argv', () => {
  it('adds the Clave-owned YOLO flag to elevated Codex sessions', () => {
    expect(
      buildAgentArgv({
        kind: 'codex',
        profile: {
          id: 'codex',
          name: 'Codex',
          family: 'codex',
          command: ['codex'],
          additionalArgs: []
        },
        dangerousMode: true,
        model: 'gpt-5.5'
      })
    ).toEqual([
      'codex',
      '--yolo',
      '-m',
      'gpt-5.5',
      '-c',
      'tui.terminal_title=["app-name","status","spinner"]'
    ])
  })

  it('preserves the TokenOps command vector and appends Clave-owned Claude args', () => {
    const profile = prefs.customProfiles[0]
    expect(
      buildAgentArgv({
        kind: 'claude',
        profile,
        sessionId: 'session-1',
        model: 'opus',
        claudeSettings: '{"hooks":{}}',
        mcpConfigPath: '/tmp/clave mcp.json',
        initialPrompt: '-fix this'
      })
    ).toEqual([
      'tokenops',
      'run',
      '--',
      'env',
      '-u',
      'ANTHROPIC_API_KEY',
      'claude',
      '--verbose',
      '--session-id',
      'session-1',
      '--model',
      'opus',
      '--settings',
      '{"hooks":{}}',
      '--mcp-config',
      '/tmp/clave mcp.json',
      '--',
      '-fix this'
    ])
  })

  it('builds new and resumed Pi sessions with managed provider settings', () => {
    const profile = {
      id: 'pi-work',
      name: 'Pi work',
      family: 'pi' as const,
      command: ['pi'],
      additionalArgs: ['--no-skills']
    }
    expect(
      buildAgentArgv({
        kind: 'pi',
        profile,
        sessionId: 'pi-id',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        thinking: 'high',
        piStateExtensionPath: '/app/pi-state.js',
        initialPrompt: 'hello'
      })
    ).toEqual([
      'pi',
      '--no-skills',
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4',
      '--thinking',
      'high',
      '--session-id',
      'pi-id',
      '--extension',
      '/app/pi-state.js',
      '--',
      'hello'
    ])
    expect(
      buildAgentArgv({
        kind: 'pi',
        profile,
        resumeSessionId: 'pi-id',
        provider: 'openai',
        model: 'gpt-5'
      })
    ).toEqual([
      'pi',
      '--no-skills',
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--session',
      'pi-id'
    ])
  })

  it('keeps unsupported Pi capabilities explicit', () => {
    expect(AGENT_CAPABILITIES.pi).toEqual({
      claveTools: 'unsupported',
      exchangeCapture: 'unsupported',
      blockedState: 'unsupported'
    })
  })
})
