import { CODEX_TITLE_CONFIG } from './codex-state'
import { RUNTIME_PLUGIN_ID_PATTERN } from './runtime-plugins'

export type LauncherFamily = string
export type AgentKind = 'claude' | 'antigravity' | 'codex' | 'pi' | 'claude-agents'
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LaunchProfile {
  id: string
  name: string
  family: LauncherFamily
  command: string[]
  additionalArgs: string[]
  builtIn?: boolean
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
  /** Derived from the installed provider registry, never persisted. */
  defaultProfiles?: LaunchProfile[]
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
  { id: 'builtin-pi', name: 'Pi', family: 'pi', command: ['pi'], additionalArgs: [], builtIn: true }
]

export const DEFAULT_LAUNCH_PROFILE_PREFERENCES: LaunchProfilePreferences = {
  version: 1,
  customProfiles: [],
  globalDefaults: {},
  workspaceOverrides: {}
}

export function isLauncherFamily(value: unknown): value is LauncherFamily {
  return (
    typeof value === 'string' &&
    RUNTIME_PLUGIN_ID_PATTERN.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  )
}
const THINKING_VALUES = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return THINKING_VALUES.has(value as PiThinkingLevel)
}

const TOKEN_MAX_LENGTH = 4_096
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
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
  ])
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
  if (!managed) return false
  return args.some(
    (arg) => managed.has(arg) || [...managed].some((flag) => arg.startsWith(`${flag}=`))
  )
}

function sanitizeProfile(value: unknown): LaunchProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = cleanText(raw.id, 128)
  const name = cleanText(raw.name, 100)
  const family = raw.family
  const command = cleanTokens(raw.command, false)
  const additionalArgs = cleanTokens(raw.additionalArgs, true)
  if (
    !id ||
    !PROFILE_ID_RE.test(id) ||
    !name ||
    !isLauncherFamily(family) ||
    !command ||
    !additionalArgs
  ) {
    return null
  }
  const typedFamily = family as LauncherFamily
  if (hasManagedArg(typedFamily, command) || hasManagedArg(typedFamily, additionalArgs)) return null
  const piRaw = raw.pi && typeof raw.pi === 'object' ? (raw.pi as Record<string, unknown>) : null
  const provider = piRaw ? cleanText(piRaw.provider, 200) : undefined
  const model = piRaw ? cleanText(piRaw.model, 200) : undefined
  const thinking = piRaw && isPiThinkingLevel(piRaw.thinking) ? piRaw.thinking : undefined
  return {
    id,
    name,
    family: typedFamily,
    command,
    additionalArgs,
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

function cleanDefaults(value: unknown): Partial<Record<LauncherFamily, string>> {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const result: Partial<Record<LauncherFamily, string>> = {}
  for (const family of Object.keys(raw).filter(isLauncherFamily)) {
    const id = cleanText(raw[family], 136)
    if (
      id &&
      (PROFILE_ID_RE.test(id) || (id.startsWith('builtin-') && isLauncherFamily(id.slice(8))))
    )
      result[family] = id
  }
  return result
}

export function sanitizeLaunchProfilePreferences(raw: unknown): LaunchProfilePreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAUNCH_PROFILE_PREFERENCES }
  const value = raw as Record<string, unknown>
  const customProfiles = Array.isArray(value.customProfiles)
    ? value.customProfiles
        .map(sanitizeProfile)
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
  if (!isLauncherFamily(family)) throw new Error(`Invalid launcher family: ${family}`)
  const defaults = preferences.defaultProfiles ?? BUILT_IN_LAUNCH_PROFILES
  const profiles = [...defaults, ...preferences.customProfiles]
  if (requestedProfileId) {
    const requested = profiles.find((profile) => profile.id === requestedProfileId)
    if (!requested) throw new Error(`Unknown launch profile: ${requestedProfileId}`)
    if (requested.family !== family)
      throw new Error(`Launch profile ${requestedProfileId} does not match provider ${family}`)
    return requested
  }
  const find = (id: string | null | undefined): LaunchProfile | undefined =>
    id ? profiles.find((profile) => profile.id === id && profile.family === family) : undefined
  const profile =
    find(workspaceId ? preferences.workspaceOverrides[workspaceId]?.[family] : undefined) ??
    find(preferences.globalDefaults[family]) ??
    defaults.find((profile) => profile.family === family)
  if (!profile) throw new Error(`No launch profile available for provider: ${family}`)
  return profile
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
  if (input.kind === 'claude') {
    if (input.resumeSessionId) argv.push('--resume', input.resumeSessionId)
    else if (input.sessionId) argv.push('--session-id', input.sessionId)
    if (input.dangerousMode) argv.push('--dangerously-skip-permissions')
    if (input.model) argv.push('--model', input.model)
    if (input.claudeSettings) argv.push('--settings', input.claudeSettings)
    if (input.mcpConfigPath) argv.push('--mcp-config', input.mcpConfigPath)
  } else if (input.kind === 'codex') {
    if (input.dangerousMode) argv.push('--yolo')
    if (input.model) argv.push('-m', input.model)
    argv.push('-c', CODEX_TITLE_CONFIG)
  } else if (input.kind === 'antigravity') {
    if (input.initialPrompt) argv.push('-i', input.initialPrompt)
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

export const AGENT_CAPABILITIES = {
  claude: { claveTools: 'supported', exchangeCapture: 'supported', blockedState: 'supported' },
  antigravity: {
    claveTools: 'unsupported',
    exchangeCapture: 'supported',
    blockedState: 'unsupported'
  },
  codex: { claveTools: 'supported', exchangeCapture: 'supported', blockedState: 'unsupported' },
  pi: { claveTools: 'unsupported', exchangeCapture: 'unsupported', blockedState: 'unsupported' }
} as const
