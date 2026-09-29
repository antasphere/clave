import type { ModelOption } from '../../../src/shared/session-model'
import { claudeModelName } from '../../../src/shared/claude-models'

// The provider may report a dated id (claude-haiku-4-5-20251001) or one with
// its context size (claude-fable-5-1[1m]) where the menu lists the plain one.
// Those two aside, ids must be EQUAL: a prefix match took Fable 5.1
// (claude-fable-5-1) for Fable 5 (claude-fable-5).
const plain = (id: string): string => id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
const sameId = (reported: string, id: string): boolean => plain(reported) === plain(id)
const sameModel = (reported: string | null, option: ModelOption): boolean =>
  reported === null
    ? option.id === 'default'
    : sameId(reported, option.id) ||
      (option.resolved !== undefined && sameId(reported, option.resolved))
// An alias may stand for the same model as another ("default" and "opus"):
// the option named exactly wins, then the first whose model it resolves to
// that is not the default (a session on Opus 5.5 is on Opus 5.5, even while
// the default happens to be it too).
export const currentOption = (
  reported: string | null,
  options: ModelOption[] | null
): ModelOption | undefined =>
  options?.find((option) => option.id === reported) ??
  options?.find((option) => option.id !== 'default' && sameModel(reported, option)) ??
  options?.find((option) => sameModel(reported, option))
/** How the chip names the model, one rule whether or not the menu has been
 *  opened: the option's own label once the list is in, else the name the id
 *  reads as ("claude-opus-5-5" → "Opus 5.5") — the same words either way,
 *  since the provider's list labels its models by that name. The provider's
 *  gloss ("Default (recommended)") stays in the menu. */
export const modelChipLabel = (model: string | null, options: ModelOption[] | null): string =>
  (currentOption(model, options)?.label ?? claudeModelName(model) ?? 'Default').replace(
    /\s*\([^)]*\)\s*$/,
    ''
  )
