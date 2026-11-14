import type { EffortOption, ModelOption } from '../../../src/shared/session-model'
import { claudeModelName, earlierClaudeIds } from '../../../src/shared/claude-models'

// The provider may report a dated id (claude-haiku-4-5-20251001) or one with
// its context size (claude-fable-5-1[1m]) where the menu lists the plain one.
// Those two aside, ids must be EQUAL: a prefix match took Fable 5.1
// (claude-fable-5-1) for Fable 5 (claude-fable-5).
const plain = (id: string): string => id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
/** Whether two ids name one model, a context suffix or a date stamp aside. */
export const sameId = (reported: string, id: string): boolean => plain(reported) === plain(id)
// No model reported yet matches no row: the chip waits for the provider's
// word (the Claude adapter asks it at ready, PRDCT-4256) rather than claiming
// a default it cannot name.
const sameModel = (reported: string | null, option: ModelOption): boolean =>
  reported !== null &&
  (sameId(reported, option.id) ||
    (option.resolved !== undefined && sameId(reported, option.resolved)))
// An alias may stand for the same model as a version ("opus" and Opus 5.5):
// the option named exactly wins, then the first whose model it resolves to.
export const currentOption = (
  reported: string | null,
  options: ModelOption[] | null
): ModelOption | undefined =>
  options?.find((option) => option.id === reported) ??
  options?.find((option) => sameModel(reported, option))
/** The word the chip shows while no model is known yet: the instant between
 *  a chat's first look and the provider naming its model. Never "Default",
 *  which reads as a model's name and is none (PRDCT-4256). */
export const MODEL_PENDING = '…'
/** How the chip names the model, one rule whether or not the menu has been
 *  opened: the option's own label once the list is in, else the name the id
 *  reads as ("claude-opus-5-5" → "Opus 5.5") — the same words either way,
 *  since the provider's list labels its models by that name. The provider's
 *  gloss ("Default · Best for everyday, complex tasks") stays in the menu. */
export const modelChipLabel = (model: string | null, options: ModelOption[] | null): string =>
  (currentOption(model, options)?.label ?? claudeModelName(model) ?? MODEL_PENDING).replace(
    /\s*\([^)]*\)\s*$/,
    ''
  )
/** The menu in two parts (PRDCT-4257): the newest version of each family and
 *  everything else the provider offers, then the earlier versions under one
 *  row, every id still a row somewhere so a session on Fable 5 finds its own.
 *  Decided over the list as given, by each row's model (`resolved`, else its
 *  id): a provider that lists no versions (Codex, the echo fixture) folds
 *  nothing. */
export const foldModelOptions = (
  options: ModelOption[]
): { current: ModelOption[]; earlier: ModelOption[] } => {
  const keyOf = (option: ModelOption): string => option.resolved ?? option.id
  const earlier = earlierClaudeIds(options.map(keyOf))
  return {
    current: options.filter((option) => !earlier.has(keyOf(option))),
    earlier: options.filter((option) => earlier.has(keyOf(option)))
  }
}
/** What the effort chip offers for the model the session is on: that
 *  model's levels, and the one to mark — the level the provider reported
 *  while the model lists it, else the model's own default, else none marked.
 *  Null hides the chip: the list is not in yet, the model is not in it, or
 *  it takes no effort. */
export const effortChoice = (
  model: string | null,
  effort: string | null,
  options: ModelOption[] | null
): { efforts: EffortOption[]; current: EffortOption | undefined } | null => {
  const option = currentOption(model, options)
  const efforts = option?.efforts
  if (!option || !efforts?.length) return null
  const current =
    efforts.find((e) => e.id === effort) ?? efforts.find((e) => e.id === option.defaultEffort)
  return { efforts, current }
}
/** How a provider reads on the chip and in the menu: the agent's name. */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  // Lane D (PRDCT-4427): OpenCode's and Pi's chats name their agent too.
  opencode: 'OpenCode',
  pi: 'Pi',
  echo: 'Echo'
}
export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider
/** The chip reads the provider, then the model (PRDCT-4300): "Claude · Fable
 *  5.1", "Codex · GPT-5.5". The model half is `modelChipLabel`'s. */
export const providerChipLabel = (
  provider: string,
  model: string | null,
  options: ModelOption[] | null
): string => `${providerLabel(provider)} · ${modelChipLabel(model, options)}`
