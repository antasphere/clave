/**
 * Antigravity's words as Clave needs them, pure: the models `agy models`
 * prints, and the mode the CLI starts on. Measured on agy 1.5.14, 22 November
 * 2026.
 */
import type { ModelOption } from './session-model'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
// `agy acp`'s own words for the levels.
const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max'
}
const VARIANT = new RegExp(`^(.+)-(${LEVELS.join('|')})$`)

/** A model id that names its level (`claude-opus-5-5-low`), in its two halves,
 *  when the base is one of `offered`; null otherwise. */
export function splitModelLevel(
  id: string,
  offered: readonly string[]
): { model: string; level: string } | null {
  const match = VARIANT.exec(id)
  return match && offered.includes(match[1]) ? { model: match[1], level: match[2] } : null
}

/** `agy models` prints one `id<TAB>name` line per model AND level. The chat's
 *  model option (and `--model`, which takes both spellings) names a model once
 *  with its levels beside it, so the lines fold to that: two levels or more are
 *  one model; a model with a single line keeps the id it was printed under
 *  (`gpt-oss-120b-medium`, as `agy acp` lists it). */
export function parseAntigravityModels(output: string): ModelOption[] {
  const lines = output.split('\n').flatMap((line) => {
    const [id, name] = line.trim().split('\t')
    return id && name ? [{ id, name, variant: VARIANT.exec(id) }] : []
  })
  const levelsOf = new Map<string, Set<string>>()
  for (const { variant } of lines) {
    if (!variant) continue
    levelsOf.set(variant[1], (levelsOf.get(variant[1]) ?? new Set()).add(variant[2]))
  }
  const models = new Map<string, ModelOption>()
  for (const { id, name, variant } of lines) {
    const levels = variant ? levelsOf.get(variant[1]) : undefined
    if (variant && levels && levels.size > 1) {
      if (models.has(variant[1])) continue
      models.set(variant[1], {
        id: variant[1],
        label: name.replace(/\s*\([^)]*\)$/, ''),
        efforts: LEVELS.filter((level) => levels.has(level)).map((level) => ({
          id: level,
          label: LEVEL_LABELS[level]
        }))
      })
    } else if (!models.has(id)) models.set(id, { id, label: name })
  }
  return [...models.values()]
}

/** The mode the CLI itself starts on, from the text of its settings.json
 *  (null when there is none): `agentMode`, which is `auto` when the person
 *  set none (agy 1.5.7 on). `agy acp` does not read it and opens every
 *  session, resumed ones included, on `default`, so Clave sets it. A file or
 *  a value that does not read asks: never more permissive than what is
 *  written. */
export function antigravityDefaultMode(settings: string | null): string {
  if (settings === null) return 'auto'
  try {
    const parsed: unknown = JSON.parse(settings.replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'default'
    const { agentMode, toolPermission } = parsed as Record<string, unknown>
    const mode =
      agentMode === undefined
        ? 'auto'
        : agentMode === 'auto' || agentMode === 'accept-edits' || agentMode === 'plan'
          ? agentMode
          : 'default'
    // `strict` asks before every tool: it lowers what asks less, never Plan,
    // which asks more (agy keeps plan with both set).
    return toolPermission === 'strict' && mode !== 'plan' ? 'default' : mode
  } catch {
    return 'default'
  }
}

/** The windows a model draws on. agy meters two groups: the Gemini models
 *  (`gemini-weekly`, `gemini-5h`) and the Claude and GPT ones (`3p-weekly`,
 *  `3p-5h`). With no model, or a grouping this does not know, every window. */
export function antigravityWindowsForModel<W extends { key?: string }>(
  windows: readonly W[],
  model?: string
): W[] {
  if (!model) return [...windows]
  const gemini = model.startsWith('gemini')
  const own = windows.filter((w) => !!w.key?.startsWith('gemini') === gemini)
  return own.length > 0 ? own : [...windows]
}

/** The rows a launcher and the agents' launch listing offer: the CLI's own
 *  default (its settings name it), then each model it lists. */
export function antigravityLaunchModels(
  models: readonly ModelOption[]
): { id: string | null; label: string; family: string }[] {
  return [
    { id: null, label: 'Default', family: 'Default' },
    ...models.map(({ id, label }) => ({ id, label, family: label }))
  ]
}
