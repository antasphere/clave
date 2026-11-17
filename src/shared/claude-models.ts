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
  { id: 'claude-fable-5-2[1m]', name: 'Fable 5.2', alias: 'fable', window: 1_000_000 },
  { id: 'claude-fable-5-1[1m]', name: 'Fable 5.1', alias: 'fable', window: 1_000_000 },
  { id: 'claude-fable-5[1m]', name: 'Fable 5', alias: 'fable', window: 1_000_000 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', alias: 'sonnet', window: 1_000_000 },
  // Measured off a turn's context_usage, 2026-11-17.
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', alias: 'haiku', window: 1_000_000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', alias: 'haiku', window: 200_000 }
]

/** A model as the launcher offers it: its id (what `--model` takes), its
 *  name, and its family's word for the credit hint ("Fable"). */
export interface ClaudeLaunchModel {
  id: string
  label: string
  family: string
}

/** The table as launcher rows: the list offered while the CLI's own is not
 *  in, or could not be read. */
export function tableLaunchModels(): ClaudeLaunchModel[] {
  return CLAUDE_MODELS.map((model) => ({
    id: model.id,
    label: model.name,
    family: model.alias.charAt(0).toUpperCase() + model.alias.slice(1)
  }))
}

/**
 * The launcher's rows from the CLI's own list (`claudeModelOptions`, asked of
 * the installed CLI): every model it offers as the newest of its family, so a
 * version that ships (Fable 5.2) shows without a release of Clave, plus the
 * earlier versions this table names on purpose (Fable 5 beside Fable 5.1).
 * An empty list answers the table.
 */
export function claudeLaunchModels(
  options: readonly { id: string; label: string; resolved?: string }[]
): ClaudeLaunchModel[] {
  if (!options.length) return tableLaunchModels()
  const keyOf = (option: { id: string; resolved?: string }): string => option.resolved ?? option.id
  const earlier = earlierClaudeIds(options.map(keyOf))
  const named = new Set(CLAUDE_MODELS.map((model) => bare(model.id)))
  const rows: ClaudeLaunchModel[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const key = bare(keyOf(option))
    if (seen.has(key)) continue
    if (earlier.has(keyOf(option)) && !named.has(key)) continue
    seen.add(key)
    const family = claudeVersion(keyOf(option))?.family ?? findClaudeModel(key)?.alias
    rows.push({
      id: option.id,
      label: option.label,
      family: family ? family.charAt(0).toUpperCase() + family.slice(1) : option.label
    })
  }
  return rows
}

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
  // The CLI's `default` alias names no model of its own: what it resolves to is
  // asked of the CLI (the adapter's ready), never read off the word.
  if (isDefaultClaudeAlias(id)) return null
  const known = findClaudeModel(id)
  if (known) return known.name
  const shape = FAMILY.exec(bare(id))
  if (!shape) return id
  const family = shape[1].charAt(0).toUpperCase() + shape[1].slice(1)
  return `${family} ${shape[2]}${shape[3] ? `.${shape[3]}` : ''}`
}

/** The CLI's `default` alias, with or without a context suffix ("default[1m]"). */
export function isDefaultClaudeAlias(id: string | null | undefined): boolean {
  return !!id && bare(id) === 'default'
}

/** A Claude id's family and version, read off its shape ("claude-opus-4-8" →
 *  opus 4.8, "claude-haiku-4-5-20251001" → haiku 4.5); null for an alias, a
 *  provider's id of another shape, or nothing. */
export function claudeVersion(
  id: string | null | undefined
): { family: string; version: number } | null {
  if (!id) return null
  const shape = FAMILY.exec(bare(id))
  if (!shape) return null
  return { family: shape[1], version: Number(shape[2]) * 100 + Number(shape[3] ?? 0) }
}

/**
 * Which of a list of ids are earlier versions of a family another id in the
 * list names newer (Fable 5 beside Fable 5.1, Opus 4.8 beside Opus 5.5): what
 * a menu folds under "Earlier versions" (PRDCT-4257). Decided by the ids'
 * own shape over the list as the provider gives it, not by the table, so a
 * version the table does not know yet (the CLI's Haiku 5.5 beside the table's
 * Haiku 4.5) still folds its elders. An alias, an id of another shape and the
 * newest of each family are never earlier.
 */
export function earlierClaudeIds(ids: readonly string[]): Set<string> {
  const newest = new Map<string, number>()
  for (const id of ids) {
    const v = claudeVersion(id)
    if (v && v.version > (newest.get(v.family) ?? -1)) newest.set(v.family, v.version)
  }
  const earlier = new Set<string>()
  for (const id of ids) {
    const v = claudeVersion(id)
    if (v && v.version < (newest.get(v.family) ?? -1)) earlier.add(id)
  }
  return earlier
}

/** The context window of a model, when it is known before any turn says so. */
export function claudeContextWindow(id: string | null | undefined): number | null {
  if (!id) return null
  if (/\[1m\]$/i.test(id)) return 1_000_000
  return findClaudeModel(id)?.window ?? null
}
