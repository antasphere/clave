import type { LauncherFamily } from '../../shared/agent-launch'
import { eventsProfile, launchProfileManager } from '../launch-profile-manager'
import { rememberedChatModel } from './chat-model-default'

/**
 * The model a launch that names none will run, as main decides it at spawn
 * (`pty-manager.ts`, `spawn`): the profile named, else the family's selected
 * profile in the workspace; a chat on it starts on the model last picked in a
 * chat composer of its adapter; a terminal CLI on its own default, which this
 * Mac cannot read (undefined: the shared caps alone judge it).
 *
 * The roads that pick an account before the spawn (an agent's open, a pinned
 * group on the server, a routine) judge the account by this model, so a
 * Fable week spent never lands a chat that will run Fable on that account
 * while another has room (PRDCT-4253). The renderer's twin is
 * `renderer/src/lib/launch-model.ts`.
 */
export function rememberedSpawnModel(
  family: LauncherFamily,
  launchProfileId: string | undefined,
  workspaceId: string | null | undefined
): string | undefined {
  const profileId = launchProfileId ?? launchProfileManager.resolve(family, workspaceId).id
  const events = eventsProfile(profileId)
  return events ? rememberedChatModel(events.adapterId) : undefined
}
