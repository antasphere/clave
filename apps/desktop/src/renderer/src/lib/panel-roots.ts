import { ownerOf } from './fleet-identity'
import { findWorkspace } from '../store/workspace-store'
import type { PanelScope } from '../store/session-types'

interface PanelRootsInput {
  focusedOwnerKey?: string
  activeWorkspaceId: string | null
  focusedSession?: { workspaceId?: string | null }
  focusedGroup?: { id: string; cwd?: string | null } | null
  workspaces: Parameters<typeof findWorkspace>[0]
  sessionCwd: string | null
  legacyRemote: boolean
}

/** Paths stay plain until the panel passes its selected folder to a server API. */
export function panelRoots(input: PanelRootsInput): {
  panelOwner: string
  scopeRoots: Record<PanelScope, string | null>
} {
  const panelOwner = ownerOf(input.focusedOwnerKey ?? input.activeWorkspaceId)
  const workspace = findWorkspace(
    input.workspaces,
    input.focusedSession?.workspaceId ?? input.activeWorkspaceId
  )
  return {
    panelOwner,
    scopeRoots: {
      session: input.sessionCwd,
      group:
        !input.legacyRemote && input.focusedGroup && ownerOf(input.focusedGroup.id) === panelOwner
          ? (input.focusedGroup.cwd ?? null)
          : null,
      workspace:
        !input.legacyRemote && workspace && ownerOf(workspace.id) === panelOwner
          ? workspace.rootDir
          : null
    }
  }
}
