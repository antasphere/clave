import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { WritingStylesView } from '../../../shared/writing-styles'

/**
 * A machine's writing styles as the window's road of `clave_launch_options`
 * lists them (PRDCT-5166): this Mac's from its settings, a connected
 * server's over the fleet bridge. Null when they cannot be read (a server
 * released before the styles, a read that failed, a preload that lacks the
 * member): the listing then offers none rather than failing.
 */
export async function readWritingStyles(serverId: string): Promise<WritingStylesView | null> {
  return Promise.resolve()
    .then(() => {
      const api = window.electronAPI
      return serverId === LOCAL_SERVER_ID
        ? api.writingStylesList()
        : api.fleetWritingStyles(serverId)
    })
    .catch(() => null)
}
