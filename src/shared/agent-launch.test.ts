import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITIES,
  buildAgentArgv,
  codexProfilePolicy,
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

  it('resumes a Codex thread through the resume subcommand, the id last', () => {
    const profile = {
      id: 'codex',
      name: 'Codex',
      family: 'codex' as const,
      command: ['codex'],
      additionalArgs: ['--search']
    }
    expect(
      buildAgentArgv({
        kind: 'codex',
        profile,
        resumeSessionId: 'thread-1',
        dangerousMode: true,
        model: 'gpt-5.5'
      })
    ).toEqual([
      'codex',
      '--search',
      'resume',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.5',
      '-c',
      'tui.terminal_title=["app-name","status","spinner"]',
      'thread-1'
    ])
    expect(buildAgentArgv({ kind: 'codex', profile, resumeSessionId: 'thread-1' })).toEqual([
      'codex',
      '--search',
      'resume',
      '-c',
      'tui.terminal_title=["app-name","status","spinner"]',
      'thread-1'
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

describe('Codex profile policy', () => {
  const codex = (command: string[], additionalArgs: string[] = []): LaunchProfile => ({
    id: 'p',
    name: 'P',
    family: 'codex',
    command,
    additionalArgs
  })
  it('reads yolo, and its long spelling, as full access without approvals', () => {
    const full = { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    expect(codexProfilePolicy(codex(['codex', '--yolo']))).toEqual(full)
    expect(
      codexProfilePolicy(codex(['codex'], ['--dangerously-bypass-approvals-and-sandbox']))
    ).toEqual(full)
  })
  it('reads the sandbox and approval flags in both spellings, the later winning', () => {
    expect(
      codexProfilePolicy(
        codex(['codex', '-s', 'workspace-write'], ['--ask-for-approval=untrusted'])
      )
    ).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
    expect(
      codexProfilePolicy(codex(['codex', '--yolo'], ['--sandbox=read-only', '-a', 'on-request']))
    ).toEqual({ sandbox: 'read-only', approvalPolicy: 'on-request' })
  })
  it('routes approvals to the reviewer for approve-for-me', () => {
    expect(codexProfilePolicy(codex(['codex', '--approve-for-me']))).toEqual({
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review'
    })
  })
  it('asks for nothing when the profile names no permission, or an unknown value', () => {
    expect(codexProfilePolicy(codex(['env', '-u', 'OPENAI_API_KEY', 'codex']))).toEqual({})
    expect(codexProfilePolicy(codex(['codex', '-s', 'everything', '-a']))).toEqual({})
  })
})
