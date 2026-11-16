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

/** One list per adapter per boot: the Claude list costs a process start,
 *  the Codex one an app-server start, and neither changes while the app
 *  runs. A list that failed is asked again next time. */
const modelLists = new Map<string, Promise<ModelOption[]>>()
export function providerModels(adapterId: string, cwd: string): Promise<ModelOption[]> {
  const cached = modelLists.get(adapterId)
  if (cached) return cached
  const adapter = sessionManager.getAdapter(adapterId)
  const listing: Promise<ModelOption[]> =
    adapter instanceof ClaudeAdapter
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
  listing.catch(() => modelLists.delete(adapterId))
  return listing
}
