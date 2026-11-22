/**
 * A provider's models with no session of it open (`adapters:models` on the
 * Mac, and the agent tool on a Clave server). Kept out of the IPC handlers
 * module, which imports Electron, so the daemon can list Codex's models.
 */
import type { ModelOption } from '../shared/session-model'
import { buildSpawnEnv, codexHomeForSpawn, getLoginShellEnv } from './pty-manager'
import { sessionManager } from './sessions/session-manager'
import { ClaudeAdapter } from './sessions/adapters/claude-adapter'
import { CodexAdapter } from './sessions/adapters/codex-adapter'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { launchProfileManager } from './launch-profile-manager'
import { antigravityCommand, listAntigravityModels } from './antigravity-cli'

/** One list per adapter per boot: the Claude list costs a process start,
 *  the Codex one an app-server start, and neither changes while the app
 *  runs. A list that failed is asked again next time. */
const modelLists = new Map<string, Promise<ModelOption[]>>()
/** Antigravity's list follows the plan and a CLI that updates itself under a
 *  running app (a new Gemini arrives that way): good for five minutes. */
const ANTIGRAVITY_LIST_MS = 5 * 60_000
/** And one that failed (signed out) for a minute: not a process per menu. */
const ANTIGRAVITY_FAILED_MS = 60_000
let antigravityListedAt = 0
export function providerModels(adapterId: string, cwd: string): Promise<ModelOption[]> {
  const antigravity = adapterId === 'antigravity-chat'
  const cached = modelLists.get(adapterId)
  if (cached && (!antigravity || Date.now() - antigravityListedAt < ANTIGRAVITY_LIST_MS))
    return cached
  if (antigravity) antigravityListedAt = Date.now()
  const adapter = sessionManager.getAdapter(adapterId)
  const listing: Promise<ModelOption[]> = antigravity
    ? // `agy models`, never a throwaway session: each one would stay in the
      // person's conversation list.
      listAntigravityModels({ command: antigravityCommand() })
    : adapter instanceof ClaudeAdapter
      ? adapter.listModels(cwd)
      : adapter instanceof CodexAdapter
        ? adapter.listModelsWithoutSession(
            cwd,
            launchProfileManager.resolve('codex', undefined, 'codex-chat'),
            buildSpawnEnv(getLoginShellEnv(), { codexHome: codexHomeForSpawn('codex', undefined) })
          )
        : adapter instanceof EchoAdapter
          ? adapter.models()
          : Promise.reject(new Error(`No model list without a session for ${adapterId}`))
  modelLists.set(adapterId, listing)
  listing.catch(() => {
    if (antigravity)
      antigravityListedAt = Date.now() - (ANTIGRAVITY_LIST_MS - ANTIGRAVITY_FAILED_MS)
    else modelLists.delete(adapterId)
  })
  return listing
}
