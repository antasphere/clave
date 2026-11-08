/**
 * The Claude models Clave offers by name. The CLI's own list is its aliases
 * (Default, Opus, Fable, Sonnet, Haiku) and moves under them as models ship;
 * this list names versions, so a session can be put on Fable 5 as well as on
 * Fable 5.1. Edited by hand when a model ships or retires.
 *
 * `window` is the context the model reads, measured off a turn's result
 * (`modelUsage[*].contextWindow`, 2026-09-29): it lets the context meter fill
 * from the first answer, before any result has named the window. Fable could
 * not be measured that day; its ids carry the `[1m]` the CLI itself offers it
 * with, and a result that says otherwise replaces the figure.
 */
export interface ClaudeModel {
  /** What `--model` and `set_model` take. */
  id: string
  /** How the model reads everywhere in the app: "Opus 5.5". */
  name: string
  /** The Agent tool's own word for the family: a subagent is launched on an
   *  alias, never on a version. */
  alias: 'opus' | 'fable' | 'sonnet' | 'haiku'
  window: number
}
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', alias: 'opus', window: 1_000_000 },
  { id: 'claude-fable-5-1[1m]', name: 'Fable 5.1', alias: 'fable', window: 1_000_000 },
  { id: 'claude-fable-5[1m]', name: 'Fable 5', alias: 'fable', window: 1_000_000 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', alias: 'sonnet', window: 1_000_000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', alias: 'haiku', window: 200_000 }
]

const bare = (id: string): string => id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
const FAMILY = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/

/** The listed model an id names, the `[1m]` suffix and a date stamp aside. */
export function findClaudeModel(id: string | null | undefined): ClaudeModel | undefined {
  if (!id) return undefined
  const plain = bare(id)
  return (
    CLAUDE_MODELS.find((model) => model.id === id) ??
    CLAUDE_MODELS.find((model) => bare(model.id) === plain) ??
    // An alias names its family's newest, the first listed.
    CLAUDE_MODELS.find((model) => model.alias === plain)
  )
}

/**
 * How a model id reads: "claude-opus-5-5" and "opus" both read "Opus 5.5", an
 * id this list does not know yet reads from its own shape
 * ("claude-opus-6-20270101" → "Opus 6"), and anything else as it came.
 */
export function claudeModelName(id: string | null | undefined): string | null {
  if (!id) return null
  if (bare(id) === 'default') return 'Default'
  const known = findClaudeModel(id)
  if (known) return known.name
  const shape = FAMILY.exec(bare(id))
  if (!shape) return id
  const family = shape[1].charAt(0).toUpperCase() + shape[1].slice(1)
  return `${family} ${shape[2]}${shape[3] ? `.${shape[3]}` : ''}`
}

/** The context window of a model, when it is known before any turn says so. */
export function claudeContextWindow(id: string | null | undefined): number | null {
  if (!id) return null
  if (/\[1m\]$/i.test(id)) return 1_000_000
  return findClaudeModel(id)?.window ?? null
}
