import { CODEX_TITLE_CONFIG } from './codex-state'
import { HARNESS_BY_ID } from './harness'

export type LauncherFamily = 'claude' | 'antigravity' | 'codex' | 'pi' | 'opencode'
export type AgentKind = LauncherFamily | 'claude-agents'
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LaunchProfile {
  id: string
  name: string
  family: LauncherFamily
  command: string[]
  additionalArgs: string[]
  builtIn?: boolean
  /** Host-derived chat variant; edit the source profile to change its command. */
  sourceProfileId?: string
  pi?: {
    provider?: string
    model?: string
    thinking?: PiThinkingLevel
  }
}

export interface LaunchProfilePreferences {
  version: 1
  customProfiles: LaunchProfile[]
  globalDefaults: Partial<Record<LauncherFamily, string>>
  workspaceOverrides: Record<string, Partial<Record<LauncherFamily, string>>>
}

export const BUILT_IN_LAUNCH_PROFILES: readonly LaunchProfile[] = [
  {
    id: 'builtin-claude',
    name: 'Claude',
    family: 'claude',
    command: ['claude'],
    additionalArgs: [],
    builtIn: true
  },
  {
    id: 'builtin-antigravity',
    name: 'Antigravity',
    family: 'antigravity',
    command: ['agy'],
    additionalArgs: [],
    builtIn: true
  },
  {
    id: 'builtin-codex',
    name: 'Codex',
    family: 'codex',
    command: ['codex'],
    additionalArgs: [],
    builtIn: true
  },
  {
    id: 'builtin-pi',
    name: 'Pi',
    family: 'pi',
    command: ['pi'],
    additionalArgs: [],
    builtIn: true
  },
  {
    id: 'builtin-opencode',
    name: 'OpenCode',
    family: 'opencode',
    command: ['opencode'],
    additionalArgs: [],
    builtIn: true
  }
]

export const DEFAULT_LAUNCH_PROFILE_PREFERENCES: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [],
  globalDefaults: {},
  workspaceOverrides: {}
}

const FAMILY_VALUES = new Set<LauncherFamily>(['claude', 'antigravity', 'codex', 'pi', 'opencode'])
const THINKING_VALUES = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
const TOKEN_MAX_LENGTH = 4_096
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// Lane D (PRDCT-4427): OpenCode's and Pi's saved profiles have a chat form too.
const CHAT_PROFILE_ID_RE = /^chat:(claude|codex|opencode|pi):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/
type ChatProfileFamily = 'claude' | 'codex' | 'opencode' | 'pi'

export function chatProfileSource(
  id?: string | null
): { family: ChatProfileFamily; id: string } | undefined {
  const match = id ? CHAT_PROFILE_ID_RE.exec(id) : null
  return match ? { family: match[1] as ChatProfileFamily, id: match[2] } : undefined
}
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

const MANAGED_ARGS: Record<LauncherFamily, Set<string>> = {
  claude: new Set([
    '--session-id',
    '--resume',
    '--model',
    '--settings',
    '--mcp-config',
    '--dangerously-skip-permissions'
  ]),
  antigravity: new Set(['-i']),
  codex: new Set(['-m', '--model']),
  pi: new Set([
    '--provider',
    '--model',
    '--thinking',
    '--session-id',
    '--session',
    '--session-dir',
    '--no-session',
    '--mode'
  ]),
  // OpenCode 2's TUI: the session it continues and the prompt it starts on.
  // `--auto` stays a profile's own choice, as Codex's `--yolo` does.
  opencode: new Set(['--session', '-s', '--prompt'])
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= maxLength && !CONTROL_RE.test(text) ? text : undefined
}

function cleanTokens(value: unknown, allowEmpty: boolean): string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 128)
    return undefined
  const tokens: string[] = []
  for (const token of value) {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > TOKEN_MAX_LENGTH ||
      CONTROL_RE.test(token)
    ) {
      return undefined
    }
    tokens.push(token)
  }
  return tokens
}

function hasManagedArg(family: LauncherFamily, args: string[]): boolean {
  const managed = MANAGED_ARGS[family]
  return args.some(
    (arg) => managed.has(arg) || [...managed].some((flag) => arg.startsWith(`${flag}=`))
  )
}

function sanitizeProfile(value: unknown, carried = false): LaunchProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = cleanText(raw.id, carried ? 140 : 128)
  const name = cleanText(raw.name, 100)
  const family = raw.family
  const command = cleanTokens(raw.command, false)
  const additionalArgs = cleanTokens(raw.additionalArgs, true)
  if (
    !id ||
    !(PROFILE_ID_RE.test(id) || (carried && chatProfileSource(id))) ||
    !name ||
    !FAMILY_VALUES.has(family as LauncherFamily) ||
    !command ||
    !additionalArgs
  ) {
    return null
  }
  const chat = carried ? chatProfileSource(id) : undefined
  if (chat && chat.family !== family) return null
  const typedFamily = family as LauncherFamily
  if (hasManagedArg(typedFamily, command) || hasManagedArg(typedFamily, additionalArgs)) return null
  const sourceProfileId = carried ? cleanText(raw.sourceProfileId, 128) : undefined
  const piRaw = raw.pi && typeof raw.pi === 'object' ? (raw.pi as Record<string, unknown>) : null
  const provider = piRaw ? cleanText(piRaw.provider, 200) : undefined
  const model = piRaw ? cleanText(piRaw.model, 200) : undefined
  const thinking =
    piRaw && THINKING_VALUES.has(piRaw.thinking as PiThinkingLevel)
      ? (piRaw.thinking as PiThinkingLevel)
      : undefined
  return {
    id,
    name,
    family: typedFamily,
    command,
    additionalArgs,
    ...(sourceProfileId && PROFILE_ID_RE.test(sourceProfileId) ? { sourceProfileId } : {}),
    ...(typedFamily === 'pi' && (provider || model || thinking)
      ? {
          pi: {
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {})
          }
        }
      : {})
  }
}

/** A start may carry a Mac's custom profile or its derived chat variant. */
export function sanitizeCarriedLaunchProfile(raw: unknown): LaunchProfile | null {
  return sanitizeProfile(raw, true)
}

function cleanDefaults(value: unknown): Partial<Record<LauncherFamily, string>> {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const result: Partial<Record<LauncherFamily, string>> = {}
  for (const family of FAMILY_VALUES) {
    const id = cleanText(raw[family], 140)
    if (id && (PROFILE_ID_RE.test(id) || chatProfileSource(id)?.family === family))
      result[family] = id
  }
  return result
}

export function sanitizeLaunchProfilePreferences(raw: unknown): LaunchProfilePreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAUNCH_PROFILE_PREFERENCES }
  const value = raw as Record<string, unknown>
  const customProfiles = Array.isArray(value.customProfiles)
    ? value.customProfiles
        .map((profile) => sanitizeProfile(profile))
        .filter((profile): profile is LaunchProfile => profile !== null)
    : []
  const seenIds = new Set(BUILT_IN_LAUNCH_PROFILES.map((profile) => profile.id))
  const seenNames = new Set<string>()
  const uniqueProfiles = customProfiles.filter((profile) => {
    const nameKey = `${profile.family}\0${profile.name.toLowerCase()}`
    if (seenIds.has(profile.id) || seenNames.has(nameKey)) return false
    seenIds.add(profile.id)
    seenNames.add(nameKey)
    return true
  })
  const workspaceOverrides: Record<string, Partial<Record<LauncherFamily, string>>> = {}
  if (value.workspaceOverrides && typeof value.workspaceOverrides === 'object') {
    for (const [workspaceId, defaults] of Object.entries(
      value.workspaceOverrides as Record<string, unknown>
    )) {
      if (workspaceId.length > 0 && workspaceId.length <= 200 && !CONTROL_RE.test(workspaceId)) {
        workspaceOverrides[workspaceId] = cleanDefaults(defaults)
      }
    }
  }
  return {
    version: 1,
    customProfiles: uniqueProfiles,
    globalDefaults: cleanDefaults(value.globalDefaults),
    workspaceOverrides
  }
}

export function resolveLaunchProfile(
  preferences: LaunchProfilePreferences,
  family: LauncherFamily,
  workspaceId?: string | null,
  requestedProfileId?: string | null
): LaunchProfile {
  const profiles = [...BUILT_IN_LAUNCH_PROFILES, ...preferences.customProfiles]
  const find = (id: string | null | undefined): LaunchProfile | undefined =>
    id ? profiles.find((profile) => profile.id === id && profile.family === family) : undefined
  return (
    find(requestedProfileId) ??
    find(workspaceId ? preferences.workspaceOverrides[workspaceId]?.[family] : undefined) ??
    find(preferences.globalDefaults[family]) ??
    BUILT_IN_LAUNCH_PROFILES.find((profile) => profile.family === family)!
  )
}

export function buildAgentArgv(input: {
  kind: AgentKind
  profile: LaunchProfile
  sessionId?: string
  resumeSessionId?: string
  dangerousMode?: boolean
  model?: string
  provider?: string
  thinking?: PiThinkingLevel
  initialPrompt?: string
  claudeSettings?: string
  mcpConfigPath?: string
  piStateExtensionPath?: string
  // ── ADR 0004: a routine run's own flags ──
  effort?: string
  /** The rung of the harness's own ladder the launch starts on (PRDCT-4424):
   *  Claude's `--permission-mode`, Codex's `--sandbox`, Antigravity's
   *  `--mode`; Pi has none. `dangerousMode` wins over it. */
  permissionMode?: string
  pluginDir?: string
  appendSystemPrompt?: string
}): string[] {
  const expectedFamily = input.kind === 'claude-agents' ? 'claude' : input.kind
  if (input.profile.family !== expectedFamily)
    throw new Error('Launch profile does not match agent')
  if (
    hasManagedArg(input.profile.family, input.profile.command) ||
    hasManagedArg(input.profile.family, input.profile.additionalArgs)
  ) {
    throw new Error('Launch profile contains a Clave-managed flag')
  }
  const argv = [...input.profile.command, ...input.profile.additionalArgs]
  if (input.kind === 'claude-agents') return [...argv, 'agents']
  // Bypass is the skip flag, never a mode passed as such: a rung of
  // `bypassPermissions` launches as `dangerousMode` does.
  const dangerous =
    input.dangerousMode === true ||
    (input.kind === 'claude' &&
      input.permissionMode === 'bypassPermissions' &&
      !profileSetsPermissions(input.profile))
  if (input.kind === 'claude') {
    if (input.resumeSessionId) argv.push('--resume', input.resumeSessionId)
    else if (input.sessionId) argv.push('--session-id', input.sessionId)
    if (dangerous) argv.push('--dangerously-skip-permissions')
    if (input.model) argv.push('--model', input.model)
    if (input.claudeSettings) argv.push('--settings', input.claudeSettings)
    if (input.mcpConfigPath) argv.push('--mcp-config', input.mcpConfigPath)
    // ADR 0004: a routine run's own flags. The CLI names the ask-every-time
    // mode `manual` on its command line; `default` is its running name.
    if (input.effort) argv.push('--effort', input.effort)
    // A profile's own `--permission-mode` is a deliberate choice and wins
    // over the person's default rung (verifier, round 1).
    if (
      input.permissionMode &&
      !dangerous &&
      CLAUDE_MODES.has(input.permissionMode) &&
      input.permissionMode !== 'bypassPermissions' &&
      !profileSetsPermissions(input.profile)
    )
      argv.push(
        '--permission-mode',
        input.permissionMode === 'default' ? 'manual' : input.permissionMode
      )
    if (input.pluginDir) argv.push('--plugin-dir', input.pluginDir)
    if (input.appendSystemPrompt) argv.push('--append-system-prompt', input.appendSystemPrompt)
  } else if (input.kind === 'codex') {
    // A resumed thread goes through the `resume` subcommand, which takes the
    // long spelling of the approvals flag and the thread id last.
    if (input.resumeSessionId) argv.push('resume')
    if (input.dangerousMode) {
      argv.push(input.resumeSessionId ? '--dangerously-bypass-approvals-and-sandbox' : '--yolo')
    } else if (
      isCodexRung(input.permissionMode) &&
      Object.keys(codexProfilePolicy(input.profile)).length === 0
    ) {
      // A profile's own sandbox or approval flags win over the default rung.
      // The person's rung (PRDCT-4424): the sandbox, and for full access the
      // approvals off too, which is what the rung promises. Before the thread
      // id on a resume, as the approvals flag is.
      argv.push('--sandbox', input.permissionMode)
      if (input.permissionMode === 'danger-full-access') argv.push('--ask-for-approval', 'never')
    }
    if (input.model) argv.push('-m', input.model)
    argv.push('-c', CODEX_TITLE_CONFIG)
    if (input.resumeSessionId) argv.push(input.resumeSessionId)
  } else if (input.kind === 'antigravity') {
    if (
      input.permissionMode &&
      HARNESS_BY_ID.antigravity.permissionRungs.some((rung) => rung.id === input.permissionMode) &&
      !profileSetsPermissions(input.profile)
    )
      argv.push('--mode', input.permissionMode)
    if (input.initialPrompt) argv.push('-i', input.initialPrompt)
    return argv
  } else if (input.kind === 'opencode') {
    // OpenCode 2's TUI (`opencode --help`, v2.2.7): `--session <id>` continues
    // a session, `--auto` approves what its config does not deny, `--prompt`
    // starts on a prompt. It takes no model: that is `opencode run`'s flag.
    const tokens = [...input.profile.command, ...input.profile.additionalArgs]
    if (input.resumeSessionId) argv.push('--session', input.resumeSessionId)
    if (input.dangerousMode && !tokens.includes('--auto')) argv.push('--auto')
    if (input.initialPrompt) argv.push('--prompt', input.initialPrompt)
    return argv
  } else {
    const pi = input.profile.pi
    const provider = input.provider ?? pi?.provider
    const model = input.model ?? pi?.model
    const thinking = input.thinking ?? pi?.thinking
    if (provider) argv.push('--provider', provider)
    if (model) argv.push('--model', model)
    if (thinking) argv.push('--thinking', thinking)
    if (input.resumeSessionId) argv.push('--session', input.resumeSessionId)
    else if (input.sessionId) argv.push('--session-id', input.sessionId)
    if (input.piStateExtensionPath) argv.push('--extension', input.piStateExtensionPath)
  }
  if (input.initialPrompt) argv.push('--', input.initialPrompt)
  return argv
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export interface CodexThreadPolicy {
  sandbox?: CodexSandboxMode
  approvalPolicy?: CodexApprovalPolicy
  approvalsReviewer?: 'user' | 'auto_review'
}
const CODEX_SANDBOX_VALUES = new Set<string>(['read-only', 'workspace-write', 'danger-full-access'])
const CODEX_APPROVAL_VALUES = new Set<string>(['untrusted', 'on-request', 'never'])

/** Is this a rung of Codex's ladder (`shared/harness.ts`): its sandbox modes. */
export function isCodexRung(value: unknown): value is CodexSandboxMode {
  return typeof value === 'string' && CODEX_SANDBOX_VALUES.has(value)
}

/**
 * The thread settings a Codex rung stands for (PRDCT-4424), the same three
 * presets Codex's own TUI offers: read only and workspace ask on request,
 * full access never asks. A chat thread takes them as thread/start
 * parameters, where a terminal takes `--sandbox`. Undefined for anything
 * that is not a rung.
 */
export function codexRungPolicy(rung: unknown): CodexThreadPolicy | undefined {
  if (!isCodexRung(rung)) return undefined
  return {
    sandbox: rung,
    approvalPolicy: rung === 'danger-full-access' ? 'never' : 'on-request',
    approvalsReviewer: 'user'
  }
}

/**
 * The permissions a Codex profile's own flags ask for, as a chat thread's
 * settings. The TUI reads `--yolo`, `-s` and `-a`; `codex app-server` accepts
 * them before its subcommand and ignores them (codex-cli 0.157), so a chat
 * thread started on a yolo profile ran in the config's sandbox. thread/start
 * and thread/resume take the same settings as parameters, which is where
 * they have to go. Later flags win, as they do on the command line.
 */
export function codexProfilePolicy(profile: LaunchProfile): CodexThreadPolicy {
  const tokens = [...profile.command, ...profile.additionalArgs]
  const policy: CodexThreadPolicy = {}
  const valueOf = (index: number, long: string, short: string): string | undefined => {
    const token = tokens[index]
    if (token === long || token === short) return tokens[index + 1]
    return token.startsWith(`${long}=`) ? token.slice(long.length + 1) : undefined
  }
  tokens.forEach((token, index) => {
    if (token === '--yolo' || token === '--dangerously-bypass-approvals-and-sandbox') {
      policy.sandbox = 'danger-full-access'
      policy.approvalPolicy = 'never'
    } else if (token === '--approve-for-me') {
      policy.sandbox = 'workspace-write'
      policy.approvalsReviewer = 'auto_review'
    }
    const sandbox = valueOf(index, '--sandbox', '-s')
    if (sandbox && CODEX_SANDBOX_VALUES.has(sandbox)) policy.sandbox = sandbox as CodexSandboxMode
    const approval = valueOf(index, '--ask-for-approval', '-a')
    if (approval && CODEX_APPROVAL_VALUES.has(approval))
      policy.approvalPolicy = approval as CodexApprovalPolicy
  })
  return policy
}

/**
 * The permission mode a Claude profile's own flags start the CLI on, and
 * whether they make bypass reachable. The CLI obeys them in a chat as in a
 * terminal; the chat reads them so it shows that mode from the first frame
 * and offers bypass where the CLI will accept the switch.
 */
export function claudeProfilePermissions(profile: LaunchProfile): {
  mode?: string
  bypassAvailable: boolean
} {
  const tokens = [...profile.command, ...profile.additionalArgs]
  let mode: string | undefined
  tokens.forEach((token, index) => {
    if (token === '--permission-mode') mode = tokens[index + 1]
    else if (token.startsWith('--permission-mode=')) mode = token.slice('--permission-mode='.length)
  })
  return {
    ...(mode ? { mode } : {}),
    bypassAvailable:
      mode === 'bypassPermissions' || tokens.includes('--allow-dangerously-skip-permissions')
  }
}

/** Whether a profile's own flags set its permissions (Claude's
 *  `--permission-mode`, Codex's sandbox or approval flags): a saved profile
 *  is a deliberate choice, and the person's default rung (Settings →
 *  Harnesses) never overrides it, on any road (verifier, rounds 1 and 2). */
export function profileSetsPermissions(profile: LaunchProfile): boolean {
  if (profile.family === 'claude') return claudeProfilePermissions(profile).mode !== undefined
  if (profile.family === 'codex') return Object.keys(codexProfilePolicy(profile)).length > 0
  if (profile.family === 'antigravity')
    return [...profile.command, ...profile.additionalArgs].some(
      (token) => token === '--mode' || token.startsWith('--mode=')
    )
  return false
}

/** Claude's `--permission-mode` values: the ladder's rungs and `dontAsk`
 *  (a routine's own, ADR 0004). Anything else is never passed to the CLI. */
const CLAUDE_MODES = new Set<string>([
  ...HARNESS_BY_ID.claude.permissionRungs.map((rung) => rung.id),
  'dontAsk'
])

export const AGENT_CAPABILITIES = {
  claude: { claveTools: 'supported', exchangeCapture: 'supported', blockedState: 'supported' },
  antigravity: {
    claveTools: 'unsupported',
    exchangeCapture: 'supported',
    blockedState: 'unsupported'
  },
  codex: { claveTools: 'supported', exchangeCapture: 'supported', blockedState: 'unsupported' },
  pi: { claveTools: 'unsupported', exchangeCapture: 'unsupported', blockedState: 'unsupported' },
  opencode: {
    claveTools: 'unsupported',
    exchangeCapture: 'unsupported',
    blockedState: 'unsupported'
  }
} as const
