import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { useFleetStore } from '../store/fleet-store'
import { pickServerFolder } from '../store/server-folder-store'

/**
 * Pick a folder on the machine that will use it (PRDCT-4329). A folder for
 * a tab or a group of a Clave server is a path of THAT server's disk, so it
 * is picked in the server folder picker the launcher already uses; this
 * Mac's dialog answers a path of this Mac, which the server would then be
 * asked to open. `owner` is the server id (`ownerOf` of the tab's or the
 * group's key); this Mac's id opens this Mac's dialog. Resolves with the
 * folder as its owner names it (a bare path), or null when cancelled.
 */
export async function pickFolderOn(owner: string, startPath?: string): Promise<string | null> {
  if (owner === LOCAL_SERVER_ID)
    return (await window.electronAPI.openFolderDialog(startPath)) ?? null
  const serverName =
    useFleetStore.getState().connections.find((c) => c.id === owner)?.name ?? 'Clave server'
  return pickServerFolder({ serverId: owner, serverName, startPath })
}
