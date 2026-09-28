import { isValidModelName } from '../../shared/model-name'
import { preferencesManager } from '../preferences-manager'

/**
 * The model a new chat starts on: the last one the reader picked in a chat
 * composer, per chat adapter (`claude-chat`, `codex-chat`, a plugin's), since
 * a model id only means something to the adapter that listed it. Picking the
 * provider's own default (a null switch) forgets it, so the next chat starts
 * wherever the CLI would.
 */
export function rememberChatModel(adapterId: string, model: string | null): void {
  const models = { ...preferencesManager.get('chatModels') }
  if (model === null) delete models[adapterId]
  else if (isValidModelName(model)) models[adapterId] = model
  else return
  preferencesManager.set('chatModels', models)
}

/** The remembered model for a fresh chat on this adapter, when there is one. */
export function rememberedChatModel(adapterId: string): string | undefined {
  const model = preferencesManager.get('chatModels')[adapterId]
  // The file is the user's to edit: a value that would not pass a launch is ignored.
  return typeof model === 'string' && isValidModelName(model) ? model : undefined
}
