import { serverClient } from './mcp/server-client'
import { isServerExternal } from './server/endpoint'
import { workspaceManager } from './workspace-manager'
import type { Workspace } from '../shared/workspace-types'

/** Runtime window commands use the same registry as registration. Attached
 *  shells keep an older local copy for boot; it cannot validate new roots. */
export const windowWorkspaces = {
  async load() {
    if (isServerExternal()) {
      return (await serverClient.api()).settings.workspaces.load()
    }
    return workspaceManager.load()
  },
  async setLastActive(workspaceId: string | null): Promise<void> {
    if (isServerExternal()) {
      await (await serverClient.api()).settings.workspaces.setLastActive(workspaceId)
    } else {
      workspaceManager.setLastActive(workspaceId)
    }
  }
}

export function initialWindowWorkspace(state: {
  readonly workspaces: ReadonlyArray<Pick<Workspace, 'id'>>
  readonly lastActiveWorkspaceId: string | null
}): string | null {
  return (
    state.workspaces.find((w) => w.id === state.lastActiveWorkspaceId)?.id ??
    state.workspaces[0]?.id ??
    null
  )
}
