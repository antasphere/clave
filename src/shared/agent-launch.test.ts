import { describe, expect, it } from 'vitest'
import {
  antigravityProfileMode,
  BUILT_IN_LAUNCH_PROFILES,
  AGENT_CAPABILITIES,
  buildAgentArgv,
  capturesExchange,
  exchangeCaptureRefusal,
  chatProfileSource,
  codexProfilePolicy,
  codexRungPolicy,
  profileEffort,
  profileModel,
  resolveLaunchProfile,
  sanitizeCarriedLaunchProfile,
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

describe('a carried launch profile', () => {
  const profile: LaunchProfile = {
    id: 'work',
    name: 'Work',
    family: 'claude',
    command: ['wrapper', 'claude'],
    additionalArgs: ['--verbose']
  }

  it('accepts a custom profile and a chat variant with its source', () => {
    expect(sanitizeCarriedLaunchProfile(profile)).toEqual(profile)
    const chat = { ...profile, id: 'chat:claude:work', sourceProfileId: 'work' }
    expect(sanitizeCarriedLaunchProfile(chat)).toEqual(chat)
    expect(sanitizeCarriedLaunchProfile({ ...profile, id: ' work ', name: ' Work ' })).toEqual(
      profile
    )
  })

  it('requires a carried chat variant id to match its family', () => {
    const codex = {
      id: 'chat:codex:x',
      name: 'X',
      family: 'codex',
      command: ['codex'],
      additionalArgs: []
    }
    expect(sanitizeCarriedLaunchProfile(codex)).toEqual(codex)
    expect(sanitizeCarriedLaunchProfile({ ...codex, id: 'chat:claude:x' })).toBeNull()
  })

  // Lane D (PRDCT-4427): OpenCode's saved profiles have a chat form too.
  it('accepts the chat form of a saved OpenCode profile, for its own family only', () => {
    const opencode = {
      id: 'chat:opencode:x',
      name: 'X (chat)',
      family: 'opencode',
      command: ['opencode'],
      additionalArgs: [],
      sourceProfileId: 'x'
    }
    expect(sanitizeCarriedLaunchProfile(opencode)).toEqual(opencode)
    expect(sanitizeCarriedLaunchProfile({ ...opencode, family: 'codex' })).toBeNull()
    expect(chatProfileSource('chat:opencode:x')).toEqual({ family: 'opencode', id: 'x' })
    expect(chatProfileSource('chat:antigravity:x')).toEqual({ family: 'antigravity', id: 'x' })
    expect(chatProfileSource('chat:terminal:x')).toBeUndefined()
  })

  // Lane D (PRDCT-4427): Pi's saved profiles have a chat form too.
  it('accepts the chat form of a saved Pi profile, its Pi settings kept, for its own family only', () => {
    const pi = {
      id: 'chat:pi:x',
      name: 'X (chat)',
      family: 'pi',
      command: ['pi'],
      additionalArgs: [],
      sourceProfileId: 'x',
      pi: { provider: 'anthropic', model: 'sonnet', thinking: 'high' }
    }
    expect(sanitizeCarriedLaunchProfile(pi)).toEqual(pi)
    expect(sanitizeCarriedLaunchProfile({ ...pi, family: 'opencode' })).toBeNull()
    expect(chatProfileSource('chat:pi:x')).toEqual({ family: 'pi', id: 'x' })
  })

  it.each([
    { command: ['claude', '--model=opus'] },
    { additionalArgs: ['--model', 'opus'] },
    { family: 'other' },
    { command: [] },
    { command: ['claude\u0000'] },
    { name: 'Work\u0001profile' },
    { command: ['x'.repeat(4097)] }
  ])('refuses invalid carried data %j', (changes) => {
    expect(sanitizeCarriedLaunchProfile({ ...profile, ...changes })).toBeNull()
  })

  it('drops builtIn, invalid sources and Pi options on another family', () => {
    expect(
      sanitizeCarriedLaunchProfile({
        ...profile,
        builtIn: true,
        sourceProfileId: '../invalid',
        pi: { provider: 'anthropic', thinking: 'high' }
      })
    ).toEqual(profile)
  })

  it('keeps Pi options only for Pi and leaves stored-profile rules unchanged', () => {
    const pi = { ...profile, family: 'pi', pi: { provider: 'anthropic', thinking: 'high' } }
    expect(sanitizeCarriedLaunchProfile(pi)).toEqual(pi)
    const parsed = sanitizeLaunchProfilePreferences({
      customProfiles: [
        { ...profile, builtIn: true, sourceProfileId: 'work' },
        { ...profile, id: 'chat:claude:work', sourceProfileId: 'work' }
      ]
    })
    expect(parsed.customProfiles).toEqual([profile])
  })
})

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

  it("launches OpenCode's TUI with the flags it has: --session, --auto, --prompt, never a model", () => {
    const profile = BUILT_IN_LAUNCH_PROFILES.find((p) => p.family === 'opencode')!
    expect(profile.command).toEqual(['opencode'])
    expect(buildAgentArgv({ kind: 'opencode', profile, model: 'x/y' })).toEqual(['opencode'])
    // PRDCT-4551: a fresh terminal on the session Clave named, which
    // `--session` creates; a resume wins over it.
    expect(buildAgentArgv({ kind: 'opencode', profile, sessionId: 'ses_fresh' })).toEqual([
      'opencode',
      '--session',
      'ses_fresh'
    ])
    expect(
      buildAgentArgv({
        kind: 'opencode',
        profile,
        sessionId: 'ses_fresh',
        resumeSessionId: 'ses_old'
      })
    ).toEqual(['opencode', '--session', 'ses_old'])
    expect(
      buildAgentArgv({
        kind: 'opencode',
        profile,
        resumeSessionId: 'ses_abc',
        dangerousMode: true,
        initialPrompt: 'hello'
      })
    ).toEqual(['opencode', '--session', 'ses_abc', '--auto', '--prompt', 'hello'])
    const auto = { ...profile, id: 'oc-auto', builtIn: false, additionalArgs: ['--auto'] }
    expect(buildAgentArgv({ kind: 'opencode', profile: auto, dangerousMode: true })).toEqual([
      'opencode',
      '--auto'
    ])
    // A tab's connection and model ride in its environment, read only by a
    // standalone TUI (PRDCT-4496): pushed once, never twice.
    expect(buildAgentArgv({ kind: 'opencode', profile, opencodeStandalone: true })).toEqual([
      'opencode',
      '--standalone'
    ])
    const standalone = {
      ...profile,
      id: 'oc-standalone',
      builtIn: false,
      additionalArgs: ['--standalone']
    }
    expect(
      buildAgentArgv({ kind: 'opencode', profile: standalone, opencodeStandalone: true })
    ).toEqual(['opencode', '--standalone'])
    expect(buildAgentArgv({ kind: 'opencode', profile, opencodeStandalone: false })).toEqual([
      'opencode'
    ])
    const managed = { ...profile, id: 'oc-bad', builtIn: false, additionalArgs: ['--prompt=x'] }
    expect(() => buildAgentArgv({ kind: 'opencode', profile: managed })).toThrow(
      'Clave-managed flag'
    )
    // PRDCT-4507: OpenCode is handed Clave's tools; the rest stays explicit.
    expect(AGENT_CAPABILITIES.opencode).toEqual({
      claveTools: 'supported',
      exchangeCapture: 'unsupported',
      blockedState: 'unsupported'
    })
  })

  it('keeps unsupported Pi capabilities explicit, Clave tools supported (PRDCT-4507)', () => {
    expect(AGENT_CAPABILITIES.antigravity.claveTools).toBe('unsupported')
    expect(AGENT_CAPABILITIES.pi).toEqual({
      claveTools: 'supported',
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

describe('the permission default reaches the argv (PRDCT-4424)', () => {
  const TITLE = 'tui.terminal_title=["app-name","status","spinner"]'
  const profileOf = (family: LaunchProfile['family'], command: string): LaunchProfile => ({
    id: `builtin-${family}`,
    name: family,
    family,
    command: [command],
    additionalArgs: []
  })
  const claude = profileOf('claude', 'claude')
  const codex = profileOf('codex', 'codex')
  const agy = profileOf('antigravity', 'agy')
  const pi = profileOf('pi', 'pi')

  it('claude: a rung is --permission-mode, bypass is the skip flag and never a mode', () => {
    expect(
      buildAgentArgv({ kind: 'claude', profile: claude, permissionMode: 'acceptEdits' })
    ).toEqual(['claude', '--permission-mode', 'acceptEdits'])
    expect(buildAgentArgv({ kind: 'claude', profile: claude, permissionMode: 'default' })).toEqual([
      'claude',
      '--permission-mode',
      'manual'
    ])
    expect(
      buildAgentArgv({ kind: 'claude', profile: claude, permissionMode: 'bypassPermissions' })
    ).toEqual(['claude', '--dangerously-skip-permissions'])
    expect(
      buildAgentArgv({
        kind: 'claude',
        profile: claude,
        permissionMode: 'plan',
        dangerousMode: true
      })
    ).toEqual(['claude', '--dangerously-skip-permissions'])
  })

  it("claude: a profile's own mode wins over the default rung, bypass included; a rung off the ladder is dropped", () => {
    const planned: LaunchProfile = { ...claude, additionalArgs: ['--permission-mode', 'plan'] }
    expect(
      buildAgentArgv({ kind: 'claude', profile: planned, permissionMode: 'acceptEdits' })
    ).toEqual(['claude', '--permission-mode', 'plan'])
    expect(
      buildAgentArgv({ kind: 'claude', profile: planned, permissionMode: 'bypassPermissions' })
    ).toEqual(['claude', '--permission-mode', 'plan'])
    // Cmd+Y is explicit: it still wins over the profile's mode.
    expect(buildAgentArgv({ kind: 'claude', profile: planned, dangerousMode: true })).toEqual([
      'claude',
      '--permission-mode',
      'plan',
      '--dangerously-skip-permissions'
    ])
    // The wire takes any rung name now; Claude is handed its own alone.
    expect(
      buildAgentArgv({ kind: 'claude', profile: claude, permissionMode: 'workspace-write' })
    ).toEqual(['claude'])
    expect(buildAgentArgv({ kind: 'claude', profile: claude, permissionMode: 'dontAsk' })).toEqual([
      'claude',
      '--permission-mode',
      'dontAsk'
    ])
  })

  it("codex: a profile's own sandbox or approval flags win over the default rung", () => {
    const own: LaunchProfile = { ...codex, additionalArgs: ['--sandbox', 'read-only'] }
    expect(
      buildAgentArgv({ kind: 'codex', profile: own, permissionMode: 'workspace-write' })
    ).toEqual(['codex', '--sandbox', 'read-only', '-c', TITLE])
    const yolo: LaunchProfile = { ...codex, additionalArgs: ['--yolo'] }
    expect(buildAgentArgv({ kind: 'codex', profile: yolo, permissionMode: 'read-only' })).toEqual([
      'codex',
      '--yolo',
      '-c',
      TITLE
    ])
  })

  it('codex: a rung is --sandbox, full access turns approvals off too', () => {
    expect(buildAgentArgv({ kind: 'codex', profile: codex, permissionMode: 'read-only' })).toEqual([
      'codex',
      '--sandbox',
      'read-only',
      '-c',
      TITLE
    ])
    expect(
      buildAgentArgv({ kind: 'codex', profile: codex, permissionMode: 'danger-full-access' })
    ).toEqual([
      'codex',
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
      '-c',
      TITLE
    ])
  })

  it('codex: on a resume the rung goes before the thread id, as the approvals flag does', () => {
    expect(
      buildAgentArgv({
        kind: 'codex',
        profile: codex,
        resumeSessionId: 'thread-1',
        permissionMode: 'workspace-write',
        model: 'gpt-5.5'
      })
    ).toEqual([
      'codex',
      'resume',
      '--sandbox',
      'workspace-write',
      '-m',
      'gpt-5.5',
      '-c',
      TITLE,
      'thread-1'
    ])
  })

  it('codex: dangerous mode keeps its own flag and ignores the rung; a non-rung is dropped', () => {
    expect(
      buildAgentArgv({
        kind: 'codex',
        profile: codex,
        permissionMode: 'read-only',
        dangerousMode: true
      })
    ).toEqual(['codex', '--yolo', '-c', TITLE])
    expect(
      buildAgentArgv({ kind: 'codex', profile: codex, permissionMode: 'acceptEdits' })
    ).toEqual(['codex', '-c', TITLE])
  })

  it("antigravity: a profile's own --mode wins over the default rung", () => {
    const own: LaunchProfile = { ...agy, additionalArgs: ['--mode', 'plan'] }
    expect(buildAgentArgv({ kind: 'antigravity', profile: own, permissionMode: 'auto' })).toEqual([
      'agy',
      '--mode',
      'plan'
    ])
  })

  it('antigravity: a rung of its ladder is --mode, anything else is dropped', () => {
    expect(
      buildAgentArgv({
        kind: 'antigravity',
        profile: agy,
        permissionMode: 'plan',
        initialPrompt: 'hi'
      })
    ).toEqual(['agy', '--mode', 'plan', '-i', 'hi'])
    expect(
      buildAgentArgv({ kind: 'antigravity', profile: agy, permissionMode: 'read-only' })
    ).toEqual(['agy'])
  })

  it('antigravity: resumes a conversation with --conversation, the id its ACP server opened', () => {
    expect(
      buildAgentArgv({
        kind: 'antigravity',
        profile: agy,
        permissionMode: 'plan',
        resumeSessionId: '70ec1049-f3e9-46a9-bd24-382267964044'
      })
    ).toEqual(['agy', '--mode', 'plan', '--conversation', '70ec1049-f3e9-46a9-bd24-382267964044'])
  })

  it("antigravity: a saved profile's own --mode is the rung its chat starts on", () => {
    expect(antigravityProfileMode({ ...agy, additionalArgs: ['--mode', 'plan'] })).toBe('plan')
    expect(antigravityProfileMode({ ...agy, additionalArgs: ['--mode=accept-edits'] })).toBe(
      'accept-edits'
    )
    expect(antigravityProfileMode({ ...agy, additionalArgs: ['--mode', 'yolo'] })).toBeUndefined()
    expect(antigravityProfileMode({ ...agy, additionalArgs: ['--mode'] })).toBeUndefined()
    expect(antigravityProfileMode(agy)).toBeUndefined()
  })

  it('pi: ignores it', () => {
    expect(
      buildAgentArgv({ kind: 'pi', profile: pi, sessionId: 'pi-1', permissionMode: 'acceptEdits' })
    ).toEqual(['pi', '--session-id', 'pi-1'])
  })

  it("codex chat: a rung's thread policy", () => {
    expect(codexRungPolicy('read-only')).toEqual({
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    })
    expect(codexRungPolicy('workspace-write')?.approvalPolicy).toBe('on-request')
    expect(codexRungPolicy('danger-full-access')).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never'
    })
    expect(codexRungPolicy('never')).toBeUndefined()
    expect(codexRungPolicy(undefined)).toBeUndefined()
  })
})

// PRDCT-4507: every capture road asks the table, never a list of modes.
describe('capturesExchange', () => {
  it('answers the harness table, aliases included, and never for a terminal or an unknown mode', () => {
    for (const [mode, capability] of Object.entries(AGENT_CAPABILITIES))
      expect(capturesExchange(mode), mode).toBe(capability.exchangeCapture === 'supported')
    expect(capturesExchange('claude-agents')).toBe(capturesExchange('claude'))
    expect(capturesExchange('gemini')).toBe(capturesExchange('antigravity'))
    expect(capturesExchange('terminal')).toBe(false)
    expect(capturesExchange('nope')).toBe(false)
    expect(exchangeCaptureRefusal('opencode')).toBe(
      'OpenCode exchange capture is not supported yet'
    )
  })
})

// Issue #423: a profile's own effort is applied, an explicit pick overrides
// it, and the effort last picked applies only to a profile that names none.
describe('the effort a profile names (#423)', () => {
  const profile = (
    family: LaunchProfile['family'],
    command: string[],
    additionalArgs: string[] = []
  ): LaunchProfile => ({ id: 'p', name: 'P', family, command, additionalArgs })
  it("reads Claude's --effort in both spellings, the later winning", () => {
    expect(profileEffort(profile('claude', ['claude', '--effort', 'low']))).toBe('low')
    expect(profileEffort(profile('claude', ['claude'], ['--effort=max']))).toBe('max')
    expect(profileEffort(profile('claude', ['claude', '--effort', 'low'], ['--effort=high']))).toBe(
      'high'
    )
  })
  it("reads Codex's model_reasoning_effort override, quoted or not, short or long", () => {
    expect(profileEffort(profile('codex', ['codex', '-c', 'model_reasoning_effort=xhigh']))).toBe(
      'xhigh'
    )
    expect(
      profileEffort(profile('codex', ['codex'], ['--config', 'model_reasoning_effort="low"']))
    ).toBe('low')
    expect(
      profileEffort(profile('codex', ['codex', "--config=model_reasoning_effort='medium'"]))
    ).toBe('medium')
  })
  it('names none for a profile without one, another config key, or a value that is no level', () => {
    expect(profileEffort(undefined)).toBeUndefined()
    expect(profileEffort(profile('claude', ['claude', '--verbose']))).toBeUndefined()
    expect(profileEffort(profile('codex', ['codex', '-c', 'model="gpt-5"']))).toBeUndefined()
    expect(profileEffort(profile('claude', ['claude', '--effort', '$(rm -rf ~)']))).toBeUndefined()
    expect(profileEffort(profile('claude', ['claude', '--effort']))).toBeUndefined()
    // Another family's spelling is not read.
    expect(profileEffort(profile('codex', ['codex', '--effort', 'high']))).toBeUndefined()
  })
})

describe('the model a profile names (#423, verifier V3)', () => {
  const profile = (
    family: LaunchProfile['family'],
    command: string[],
    additionalArgs: string[] = [],
    pi?: LaunchProfile['pi']
  ): LaunchProfile => ({
    id: 'p',
    name: 'P',
    family,
    command,
    additionalArgs,
    ...(pi ? { pi } : {})
  })
  it("reads Codex's model override, quoted or not, short or long, the later winning", () => {
    expect(profileModel(profile('codex', ['codex', '-c', 'model="gpt-a"']))).toBe('gpt-a')
    expect(profileModel(profile('codex', ['codex'], ['--config=model=gpt-b']))).toBe('gpt-b')
    expect(
      profileModel(profile('codex', ['codex', '-c', "model='gpt-a'"], ['--config', 'model=gpt-c']))
    ).toBe('gpt-c')
  })
  it("reads a Pi profile's own model", () => {
    expect(profileModel(profile('pi', ['pi'], [], { model: 'pi-model' }))).toBe('pi-model')
  })
  it('names none for another key, a Claude profile, or a value that is no model name', () => {
    expect(profileModel(undefined)).toBeUndefined()
    expect(
      profileModel(profile('codex', ['codex', '-c', 'model_reasoning_effort=high']))
    ).toBeUndefined()
    expect(profileModel(profile('codex', ['codex', '-c', 'model_provider=oss']))).toBeUndefined()
    expect(profileModel(profile('claude', ['claude', '--verbose']))).toBeUndefined()
    expect(profileModel(profile('codex', ['codex', '-c', 'model="$(rm -rf ~)"']))).toBeUndefined()
  })
})

// Verifier round 2, V7: the other spellings a saved profile may use.
describe('the model and effort a profile names in its other spellings (#423, verifier V7)', () => {
  const profile = (
    family: LaunchProfile['family'],
    command: string[],
    additionalArgs: string[] = []
  ): LaunchProfile => ({ id: 'p', name: 'P', family, command, additionalArgs })
  it("reads Claude's environment in the command, which the CLI reads too", () => {
    const claude = profile('claude', [
      'env',
      'ANTHROPIC_MODEL=haiku',
      'CLAUDE_CODE_EFFORT_LEVEL=low',
      'claude'
    ])
    expect(profileModel(claude)).toBe('haiku')
    expect(profileEffort(claude)).toBe('low')
  })
  it("lets Claude's effort variable win over its --effort, as the CLI does", () => {
    expect(
      profileEffort(
        profile('claude', ['env', 'CLAUDE_CODE_EFFORT_LEVEL=low', 'claude'], ['--effort', 'max'])
      )
    ).toBe('low')
  })
  it("reads Codex's attached -c spellings", () => {
    expect(profileModel(profile('codex', ['codex', '-cmodel="gpt-a"']))).toBe('gpt-a')
    expect(profileModel(profile('codex', ['codex', '-c=model="gpt-a"']))).toBe('gpt-a')
    expect(profileEffort(profile('codex', ['codex', '-cmodel_reasoning_effort="low"']))).toBe('low')
    expect(profileEffort(profile('codex', ['codex', '-c=model_reasoning_effort=high']))).toBe(
      'high'
    )
  })
  it("reads no variable after the program, nor another family's", () => {
    expect(profileModel(profile('claude', ['claude'], ['ANTHROPIC_MODEL=haiku']))).toBeUndefined()
    expect(
      profileModel(profile('codex', ['env', 'ANTHROPIC_MODEL=haiku', 'codex']))
    ).toBeUndefined()
  })
})

// Verifier round 3, V12: Claude prefers CLAUDE_CODE_EFFORT_LEVEL to --effort,
// so a profile's variable would beat an explicit pick. The effort Clave hands
// over is already the explicit one, else the profile's, else the last pick;
// it replaces the variable, which then cannot override it.
describe("the effort Clave passes replaces a profile's effort variable (#423, verifier V12)", () => {
  const profile: LaunchProfile = {
    id: 'p',
    name: 'P',
    family: 'claude',
    command: ['env', 'ANTHROPIC_MODEL=haiku', 'CLAUDE_CODE_EFFORT_LEVEL=low', 'claude'],
    additionalArgs: []
  }
  it('drops the variable and passes --effort when an effort is given', () => {
    const argv = buildAgentArgv({ kind: 'claude', profile, effort: 'max' })
    expect(argv).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=low')
    expect(argv.slice(0, 3)).toEqual(['env', 'ANTHROPIC_MODEL=haiku', 'claude'])
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'max'
    ])
  })
  it('keeps the variable when no effort is given (a terminal)', () => {
    expect(buildAgentArgv({ kind: 'claude', profile })).toContain('CLAUDE_CODE_EFFORT_LEVEL=low')
  })
})
