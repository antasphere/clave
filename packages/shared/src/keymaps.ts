export const KEYMAP_CONFIG_VERSION = 1 as const
export const KEYMAP_SEQUENCE_TIMEOUT_MS = 300
export const MAX_BINDINGS_PER_ACTION = 2

export const KEYMAP_ACTION_IDS = [
  'newTerminal',
  'newTerminalAtFolder',
  'newClaude',
  'newClaudeAtFolder',
  'newDangerousClaude',
  'newDangerousClaudeAtFolder',
  'newClaudeAgents',
  'newClaudeAgentsAtFolder',
  'newAntigravity',
  'newAntigravityAtFolder',
  'newCodex',
  'newCodexAtFolder',
  'newYoloCodex',
  'newYoloCodexAtFolder',
  'newPi',
  'newPiAtFolder',
  'toggleSidebar',
  'toggleSidePanel',
  'openFilePalette',
  'openGitPanel',
  'openHistory',
  'openHelp',
  'openSettings',
  'focusSidebarSearch',
  'closeFocused',
  'killFocusedSession',
  'archiveAndKillSession',
  'previousWorkspace',
  'nextWorkspace',
  'previousSession',
  'nextSession',
  'selectSession1',
  'selectSession2',
  'selectSession3',
  'selectSession4',
  'selectSession5',
  'selectSession6',
  'selectSession7',
  'selectSession8',
  'selectSession9',
  'groupSelectedSessions',
  'ungroupSelectedSessions',
  'resetSessions',
  'undoSidebar',
  'newWindow'
] as const

export type KeymapActionId = (typeof KEYMAP_ACTION_IDS)[number]
export type KeymapScope = 'global' | 'app'

export interface KeymapActionDefinition {
  id: KeymapActionId
  label: string
  category: 'Sessions' | 'Navigation' | 'Sidebar' | 'Application'
  scope: KeymapScope
  defaultBindings: readonly string[]
  /** The action works on ONE session. Fired by a key, that is the focused
   *  session; fired by a mouse button, it is the sidebar row under the pointer,
   *  and nothing anywhere else — so a middle click in a terminal pane never
   *  kills the session whose pane it is. */
  targetsSession?: true
}

export interface KeymapOverridesV1 {
  version: typeof KEYMAP_CONFIG_VERSION
  masterKey?: string | null
  bindings?: Partial<Record<KeymapActionId, string[]>>
}

export interface ResolvedKeymapConfig {
  version: typeof KEYMAP_CONFIG_VERSION
  masterKey: string | null
  bindings: Record<KeymapActionId, string[]>
}

export interface KeymapValidationError {
  path: string
  message: string
}

export type KeymapValidationResult =
  | { ok: true; value: KeymapOverridesV1 }
  | { ok: false; errors: KeymapValidationError[] }

export interface MouseEventLike {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface KeyEventLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type KeymapMatchResult =
  | { kind: 'none' }
  | { kind: 'pending'; sequence: string }
  | { kind: 'matched'; actionId: KeymapActionId }
  | { kind: 'cancelled'; sequence: string }

export const KEYMAP_ACTIONS: readonly KeymapActionDefinition[] = [
  action('newTerminal', 'New terminal', 'Sessions', 'global', ['Mod+T']),
  action('newTerminalAtFolder', 'New terminal in chosen folder', 'Sessions', 'global', [
    'Mod+Alt+T'
  ]),
  action('newClaude', 'New Claude Code session', 'Sessions', 'global', ['Mod+N', 'Master C']),
  action('newClaudeAtFolder', 'New Claude Code session in chosen folder', 'Sessions', 'global', [
    'Mod+Alt+N'
  ]),
  action(
    'newDangerousClaude',
    'New Claude session without permission prompts',
    'Sessions',
    'global',
    ['Mod+D']
  ),
  action(
    'newDangerousClaudeAtFolder',
    'New Claude session without permission prompts in chosen folder',
    'Sessions',
    'global',
    ['Mod+Alt+D']
  ),
  action('newClaudeAgents', 'New Claude Agents session', 'Sessions', 'global', ['Mod+Shift+A']),
  action(
    'newClaudeAgentsAtFolder',
    'New Claude Agents session in chosen folder',
    'Sessions',
    'global',
    ['Mod+Alt+Shift+A']
  ),
  action('newAntigravity', 'New Antigravity session', 'Sessions', 'global', ['Mod+I']),
  action(
    'newAntigravityAtFolder',
    'New Antigravity session in chosen folder',
    'Sessions',
    'global',
    ['Mod+Alt+I']
  ),
  action('newCodex', 'New Codex session', 'Sessions', 'global', ['Mod+U']),
  action('newCodexAtFolder', 'New Codex session in chosen folder', 'Sessions', 'global', [
    'Mod+Alt+U'
  ]),
  action('newYoloCodex', 'New Codex session in YOLO mode', 'Sessions', 'global', ['Mod+Y']),
  action(
    'newYoloCodexAtFolder',
    'New Codex session in YOLO mode in chosen folder',
    'Sessions',
    'global',
    ['Mod+Alt+Y']
  ),
  action('newPi', 'New Pi session', 'Sessions', 'global', ['Mod+Shift+P']),
  action('newPiAtFolder', 'New Pi session in chosen folder', 'Sessions', 'global', [
    'Mod+Alt+Shift+P'
  ]),
  action('closeFocused', 'Close focused tab or window', 'Sessions', 'global', ['Mod+W']),
  action(
    'killFocusedSession',
    'Kill session',
    'Sessions',
    'global',
    ['Mod+Backspace', 'MouseMiddle'],
    true
  ),
  action('archiveAndKillSession', 'Archive and kill session', 'Sessions', 'global', [], true),
  action('previousSession', 'Previous session', 'Sessions', 'global', ['Mod+Shift+[']),
  action('nextSession', 'Next session', 'Sessions', 'global', ['Mod+Shift+]']),
  action('selectSession1', 'Select session 1', 'Sessions', 'global', ['Mod+1']),
  action('selectSession2', 'Select session 2', 'Sessions', 'global', ['Mod+2']),
  action('selectSession3', 'Select session 3', 'Sessions', 'global', ['Mod+3']),
  action('selectSession4', 'Select session 4', 'Sessions', 'global', ['Mod+4']),
  action('selectSession5', 'Select session 5', 'Sessions', 'global', ['Mod+5']),
  action('selectSession6', 'Select session 6', 'Sessions', 'global', ['Mod+6']),
  action('selectSession7', 'Select session 7', 'Sessions', 'global', ['Mod+7']),
  action('selectSession8', 'Select session 8', 'Sessions', 'global', ['Mod+8']),
  action('selectSession9', 'Select session 9', 'Sessions', 'global', ['Mod+9']),
  action('toggleSidebar', 'Toggle left sidebar', 'Navigation', 'global', ['Mod+B']),
  action('toggleSidePanel', 'Toggle right side panel', 'Navigation', 'global', ['Mod+E']),
  action('openFilePalette', 'Open file palette', 'Navigation', 'global', ['Mod+P']),
  action('openGitPanel', 'Open Git panel', 'Navigation', 'global', ['Mod+Shift+G']),
  action('openHistory', 'Open session history', 'Navigation', 'global', ['Mod+Shift+H']),
  action('openHelp', 'Open help', 'Navigation', 'global', ['Mod+Shift+/']),
  action('openSettings', 'Open settings', 'Navigation', 'global', ['Mod+,']),
  action('focusSidebarSearch', 'Focus sidebar search', 'Navigation', 'global', ['Mod+F']),
  action('previousWorkspace', 'Previous workspace', 'Navigation', 'global', ['Mod+Ctrl+[']),
  action('nextWorkspace', 'Next workspace', 'Navigation', 'global', ['Mod+Ctrl+]']),
  action('groupSelectedSessions', 'Group selected sessions', 'Sidebar', 'global', ['Mod+G']),
  action('ungroupSelectedSessions', 'Ungroup selected sessions', 'Sidebar', 'global', [
    'Mod+Alt+G'
  ]),
  action('resetSessions', 'Reset all sessions', 'Sidebar', 'global', ['Mod+Shift+Backspace']),
  action('undoSidebar', 'Undo sidebar change', 'Sidebar', 'app', ['Mod+Z']),
  action('newWindow', 'New window', 'Application', 'global', ['Mod+Shift+N'])
]

const ACTION_IDS = new Set<string>(KEYMAP_ACTION_IDS)
const DEFAULT_MASTER_KEY = 'Mod+K'
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  mod: 'Mod',
  meta: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}
const NAMED_KEYS: Record<string, string> = {
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}
const SHIFTED_KEY_BASE: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/'
}

function action(
  id: KeymapActionId,
  label: string,
  category: KeymapActionDefinition['category'],
  scope: KeymapScope,
  defaultBindings: readonly string[],
  targetsSession?: true
): KeymapActionDefinition {
  return { id, label, category, scope, defaultBindings, ...(targetsSession && { targetsSession }) }
}

/** The mouse buttons a binding may name, by `MouseEvent.button`. The left and
 *  right buttons are not here on purpose: they are selection, drag and the
 *  context menu everywhere in the app, and a binding on either would take them
 *  away from every row and pane at once. */
const MOUSE_BUTTONS: Record<number, string> = {
  1: 'MouseMiddle',
  3: 'MouseBack',
  4: 'MouseForward'
}
const MOUSE_KEYS: Record<string, string> = {
  mousemiddle: 'MouseMiddle',
  middleclick: 'MouseMiddle',
  mouseback: 'MouseBack',
  mouseforward: 'MouseForward'
}
const MOUSE_LABELS: Record<string, string> = {
  MouseMiddle: 'Middle click',
  MouseBack: 'Back button',
  MouseForward: 'Forward button'
}

/** A chord whose key is a mouse button rather than a key. */
export function isMouseChord(chord: string): boolean {
  const key = chord.split('+').pop() ?? ''
  return key in MOUSE_LABELS
}

function canonicalKey(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('A chord needs a key')
  const named = NAMED_KEYS[trimmed.toLowerCase()] ?? MOUSE_KEYS[trimmed.toLowerCase()]
  if (named) return named
  if (trimmed.length === 1) return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) return trimmed.toUpperCase()
  throw new Error(`Unknown key "${trimmed}"`)
}

export function canonicalizeChord(chord: string): string {
  const tokens = chord
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length === 0) throw new Error('A chord cannot be empty')

  const modifiers = new Set<(typeof MODIFIER_ORDER)[number]>()
  let key: string | null = null
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()]
    if (modifier) {
      if (modifiers.has(modifier)) throw new Error(`Duplicate modifier "${modifier}"`)
      modifiers.add(modifier)
      continue
    }
    if (key !== null) throw new Error('A chord can contain only one key')
    key = canonicalKey(token)
  }
  if (key === null) throw new Error('A chord needs a non-modifier key')
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+')
}

export function canonicalizeBinding(binding: string): string {
  const steps = binding.trim().split(/\s+/).filter(Boolean)
  if (steps.length === 0) throw new Error('A binding cannot be empty')
  const canonical = steps.map((step, index) => {
    if (step.toLowerCase() === 'master') {
      if (index > 0) throw new Error('Master can only be the first sequence step')
      return 'Master'
    }
    if (index > 0 && step.toLowerCase().startsWith('master+')) {
      throw new Error('Master is a sequence step, not a modifier')
    }
    return canonicalizeChord(step)
  })
  // A click is not a keystroke the command mode can wait on: a mouse binding
  // is one chord, never a step of a sequence.
  if (canonical.length > 1 && canonical.some(isMouseChord)) {
    throw new Error('A mouse button cannot be part of a key sequence')
  }
  return canonical.join(' ')
}

/** The key a physical code stands for, used when `event.key` cannot be trusted.
 *  On macOS Option REWRITES `event.key` — ⌥N is a dead key, ⌥T is `†`, ⌥G is `©`
 *  — so every Option chord has to be read off the physical key instead. This is
 *  the same `event.code` match the launch shortcuts used before keymaps existed;
 *  it applies only while Alt is held (or on a dead key), so ordinary chords keep
 *  reading `event.key` and stay true to the user's layout. */
function codeKey(code: string | undefined): string | undefined {
  if (!code) return undefined
  const letter = code.match(/^Key([A-Z])$/)?.[1]
  if (letter) return letter
  const digit = code.match(/^Digit([0-9])$/)?.[1]
  if (digit) return digit
  return CODE_PUNCTUATION[code]
}

const CODE_PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space'
}

export function keyEventToChord(event: KeyEventLike): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null
  const physical = codeKey(event.code)
  const deadKey = event.key === 'Dead' || event.key === 'Unidentified'
  if (deadKey && !physical) return null
  let key: string
  try {
    const eventKey = event.shiftKey ? (SHIFTED_KEY_BASE[event.key] ?? event.key) : event.key
    key = canonicalKey(
      (event.altKey || deadKey ? physical : undefined) ?? (eventKey === ' ' ? 'Space' : eventKey)
    )
  } catch {
    return null
  }
  const parts: string[] = []
  if (event.metaKey) parts.push('Mod')
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/** The chord a mouse button press stands for, or null for a button a binding
 *  cannot name (left, right, anything past forward). */
export function mouseEventToChord(event: MouseEventLike): string | null {
  const key = MOUSE_BUTTONS[event.button]
  if (!key) return null
  const parts: string[] = []
  if (event.metaKey) parts.push('Mod')
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

function formatChord(chord: string): string {
  const tokens = chord.split('+')
  const key = tokens.pop() ?? ''
  return (
    tokens
      .map((token) => {
        if (token === 'Mod') return '⌘'
        if (token === 'Ctrl') return '⌃'
        if (token === 'Alt') return '⌥'
        if (token === 'Shift') return '⇧'
        return token
      })
      .join('') + (MOUSE_LABELS[key] ?? key)
  )
}

export function formatKeyBinding(binding: string, masterKey: string | null): string {
  return canonicalizeBinding(binding)
    .split(' ')
    .map((step) =>
      step === 'Master' ? (masterKey ? formatChord(masterKey) : 'Master') : formatChord(step)
    )
    .join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaults(): ResolvedKeymapConfig {
  return {
    version: KEYMAP_CONFIG_VERSION,
    masterKey: DEFAULT_MASTER_KEY,
    bindings: Object.fromEntries(
      KEYMAP_ACTIONS.map((definition) => [definition.id, [...definition.defaultBindings]])
    ) as Record<KeymapActionId, string[]>
  }
}

export function parseKeymapOverrides(raw: unknown): KeymapValidationResult {
  const errors: KeymapValidationError[] = []
  if (!isRecord(raw))
    return { ok: false, errors: [{ path: '$', message: 'Configuration must be an object' }] }

  for (const key of Object.keys(raw)) {
    if (!['version', 'masterKey', 'bindings'].includes(key)) {
      errors.push({ path: key, message: `Unknown configuration field "${key}"` })
    }
  }
  if (raw.version !== KEYMAP_CONFIG_VERSION) {
    errors.push({ path: 'version', message: `Version must be ${KEYMAP_CONFIG_VERSION}` })
  }

  let masterKey: string | null | undefined
  if (raw.masterKey !== undefined) {
    if (raw.masterKey === null) masterKey = null
    else if (typeof raw.masterKey !== 'string') {
      errors.push({ path: 'masterKey', message: 'masterKey must be a chord or null' })
    } else {
      try {
        masterKey = canonicalizeChord(raw.masterKey)
        if (isMouseChord(masterKey)) throw new Error('masterKey must be a key, not a mouse button')
      } catch (error) {
        errors.push({ path: 'masterKey', message: (error as Error).message })
      }
    }
  }

  const bindings: Partial<Record<KeymapActionId, string[]>> = {}
  if (raw.bindings !== undefined && !isRecord(raw.bindings)) {
    errors.push({ path: 'bindings', message: 'bindings must be an object' })
  } else if (isRecord(raw.bindings)) {
    for (const [actionId, rawBindings] of Object.entries(raw.bindings)) {
      if (!ACTION_IDS.has(actionId)) {
        errors.push({ path: `bindings.${actionId}`, message: `Unknown action "${actionId}"` })
        continue
      }
      if (
        !Array.isArray(rawBindings) ||
        rawBindings.some((binding) => typeof binding !== 'string')
      ) {
        errors.push({
          path: `bindings.${actionId}`,
          message: 'Action bindings must be an array of strings'
        })
        continue
      }
      if (rawBindings.length > MAX_BINDINGS_PER_ACTION) {
        errors.push({
          path: `bindings.${actionId}`,
          message: `An action may have at most ${MAX_BINDINGS_PER_ACTION} bindings`
        })
      }
      const parsedBindings: string[] = []
      for (let index = 0; index < rawBindings.length; index++) {
        try {
          const binding = canonicalizeBinding(rawBindings[index])
          const steps = binding.split(' ')
          if (steps.length > 1 && steps[0] !== 'Master') {
            throw new Error('A multi-key sequence must start with Master')
          }
          if (binding === 'Master') throw new Error('Master cannot be assigned as an action')
          parsedBindings.push(binding)
        } catch (error) {
          errors.push({ path: `bindings.${actionId}.${index}`, message: (error as Error).message })
        }
      }
      bindings[actionId as KeymapActionId] = parsedBindings
    }
  }

  const candidate: KeymapOverridesV1 = { version: KEYMAP_CONFIG_VERSION }
  if (masterKey !== undefined) candidate.masterKey = masterKey
  if (Object.keys(bindings).length > 0) candidate.bindings = bindings

  const resolved = resolveKeymapConfig(candidate)
  const owners = new Map<string, KeymapActionId>()
  for (const actionId of KEYMAP_ACTION_IDS) {
    for (const binding of resolved.bindings[actionId]) {
      const owner = owners.get(binding)
      if (owner) {
        errors.push({
          path: `bindings.${actionId}`,
          message: `Binding "${binding}" is already assigned to ${owner}`
        })
      } else {
        owners.set(binding, actionId)
      }
      if (resolved.masterKey && binding === resolved.masterKey) {
        errors.push({
          path: `bindings.${actionId}`,
          message: `Binding "${binding}" is reserved for masterKey`
        })
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: candidate }
}

export function resolveKeymapConfig(overrides?: KeymapOverridesV1 | null): ResolvedKeymapConfig {
  const config = defaults()
  if (!overrides) return config
  if (overrides.masterKey !== undefined) config.masterKey = overrides.masterKey
  for (const [actionId, bindings] of Object.entries(overrides.bindings ?? {})) {
    if (ACTION_IDS.has(actionId) && bindings) {
      config.bindings[actionId as KeymapActionId] = [...bindings]
    }
  }
  return config
}

function equalBindings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((binding, index) => binding === right[index])
}

export function overridesFromResolved(config: ResolvedKeymapConfig): KeymapOverridesV1 {
  const base = defaults()
  const overrides: KeymapOverridesV1 = { version: KEYMAP_CONFIG_VERSION }
  if (config.masterKey !== base.masterKey) overrides.masterKey = config.masterKey
  const bindings: Partial<Record<KeymapActionId, string[]>> = {}
  for (const actionId of KEYMAP_ACTION_IDS) {
    if (!equalBindings(config.bindings[actionId], base.bindings[actionId])) {
      bindings[actionId] = [...config.bindings[actionId]]
    }
  }
  if (Object.keys(bindings).length > 0) overrides.bindings = bindings
  return overrides
}

interface CompiledCommand {
  actionId: KeymapActionId
  steps: string[]
}

export class KeymapMatcher {
  private config: ResolvedKeymapConfig
  private direct = new Map<string, KeymapActionId>()
  private commands: CompiledCommand[] = []
  private pending: string[] | null = null
  private deadline = 0
  private pendingAction: KeymapActionId | null = null

  constructor(config: ResolvedKeymapConfig) {
    this.config = config
    this.compile()
  }

  setConfig(config: ResolvedKeymapConfig): void {
    this.config = config
    this.reset()
    this.compile()
  }

  private compile(): void {
    this.direct.clear()
    this.commands = []
    for (const actionId of KEYMAP_ACTION_IDS) {
      for (const binding of this.config.bindings[actionId]) {
        const steps = binding.split(' ')
        if (steps[0] === 'Master') {
          if (this.config.masterKey) {
            this.commands.push({ actionId, steps: [this.config.masterKey, ...steps.slice(1)] })
          }
        } else if (steps.length === 1) {
          this.direct.set(steps[0], actionId)
        }
      }
    }
  }

  handleChord(chord: string, now: number): KeymapMatchResult {
    const canonical = canonicalizeChord(chord)
    if (!this.pending) {
      if (this.config.masterKey && canonical === this.config.masterKey) {
        this.pending = [canonical]
        this.deadline = now + KEYMAP_SEQUENCE_TIMEOUT_MS
        this.pendingAction = null
        return { kind: 'pending', sequence: this.pending.join(' ') }
      }
      const actionId = this.direct.get(canonical)
      return actionId ? { kind: 'matched', actionId } : { kind: 'none' }
    }

    this.pending.push(canonical)
    const candidates = this.commands.filter(
      (command) =>
        command.steps.length >= this.pending!.length &&
        this.pending!.every((step, index) => command.steps[index] === step)
    )
    if (candidates.length === 0) {
      const sequence = this.pending.join(' ')
      this.reset()
      return { kind: 'cancelled', sequence }
    }

    const exact = candidates.find((command) => command.steps.length === this.pending!.length)
    const hasLonger = candidates.some((command) => command.steps.length > this.pending!.length)
    if (exact && !hasLonger) {
      const actionId = exact.actionId
      this.reset()
      return { kind: 'matched', actionId }
    }

    this.pendingAction = exact?.actionId ?? null
    this.deadline = now + KEYMAP_SEQUENCE_TIMEOUT_MS
    return { kind: 'pending', sequence: this.pending.join(' ') }
  }

  /** The action a mouse chord is bound to, or null. A click never enters,
   *  advances or cancels a command-mode sequence. */
  matchMouse(chord: string): KeymapActionId | null {
    return this.direct.get(canonicalizeChord(chord)) ?? null
  }

  expire(now: number): KeymapMatchResult {
    if (!this.pending) return { kind: 'none' }
    if (now < this.deadline) return { kind: 'pending', sequence: this.pending.join(' ') }
    const sequence = this.pending.join(' ')
    const actionId = this.pendingAction
    this.reset()
    return actionId ? { kind: 'matched', actionId } : { kind: 'cancelled', sequence }
  }

  reset(): void {
    this.pending = null
    this.deadline = 0
    this.pendingAction = null
  }
}
