import { isChatProfileRef } from '../../../shared/open-session-modes'
import { isDefaultClaudeAlias } from '../../../shared/claude-models'
import { isValidModelName } from '../../../shared/model-name'
import { selectedLaunchProfile } from '../store/launch-profile-store'

/**
 * The model a launch will run, as far as this Mac knows before the spawn
 * (PRDCT-4302): what the pool judges each account by, so a Fable week spent
 * never costs a launch on Opus its account (`accountForLaunch`). A CHAT
 * launch starts on the model last picked in a chat composer of its adapter
 * (main's `chat-model-default.ts`, kept in the `chatModels` preference); a
 * terminal CLI starts on its own default, which this Mac cannot read, so
 * such a launch is judged on the shared caps alone.
 */
type PooledProvider = 'claude' | 'codex'

/** The chat adapter a launch profile stands for (`isChatProfileRef`: the
 *  family's built-in chat, or the chat form of one of its saved profiles),
 *  or null for a terminal. */
export function chatAdapterOf(provider: PooledProvider, launchProfileId: string): string | null {
  return isChatProfileRef(provider, launchProfileId) ? `${provider}-chat` : null
}

/** The model the launch will run, or undefined when this Mac cannot know
 *  it. `launchProfileId` absent means the family's selected profile in the
 *  workspace, the way main resolves it. */
export async function rememberedLaunchModel(
  provider: PooledProvider,
  launchProfileId: string | undefined,
  workspaceId: string | null,
  read: (adapterId: string) => Promise<string | null | undefined> = (adapterId) =>
    window.electronAPI?.launchRememberedModel?.(adapterId) ?? Promise.resolve(undefined)
): Promise<string | undefined> {
  const profileId = launchProfileId ?? selectedLaunchProfile(provider, workspaceId).id
  const adapterId = chatAdapterOf(provider, profileId)
  if (!adapterId) return undefined
  // One read, from main (PRDCT-4420): until 11 November 2026 this asked
  // `preferences:get`, which answers from `clave-preferences.json`, while the
  // composer's pick is written to `preferences.json`; the launch never knew
  // its model and the suggested account was judged on the shared caps alone.
  const model = await read(adapterId).catch(() => undefined)
  if (typeof model !== 'string' || !isValidModelName(model)) return undefined
  if (adapterId === 'claude-chat' && isDefaultClaudeAlias(model)) return undefined
  return model
}
