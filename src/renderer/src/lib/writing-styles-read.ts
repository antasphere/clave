import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { WritingStylesView } from '../../../shared/writing-styles'

/** The preload members that answer a machine's writing styles: this Mac's
 *  from its settings, a connected server's over the fleet bridge. */
interface WritingStylesApi {
  writingStylesList?: () => Promise<WritingStylesView>
  fleetWritingStyles?: (serverId: string) => Promise<WritingStylesView>
}

/**
 * A machine's writing styles as the window's road of `clave_launch_options`
 * lists them (PRDCT-5166): this Mac's, or a connected server's. Null when
 * they cannot be read (a server released before the styles, a read that
 * failed): the listing then offers none rather than failing.
 *
 * The two members are the preload's, declared by the Settings side of the
 * same change; until both sides are merged they are read through this one
 * loose shape, which the merge replaces with the typed `electronAPI`.
 */
export async function readWritingStyles(serverId: string): Promise<WritingStylesView | null> {
  const api = (globalThis as { window?: { electronAPI?: WritingStylesApi } }).window?.electronAPI
  const read =
    serverId === LOCAL_SERVER_ID ? api?.writingStylesList?.() : api?.fleetWritingStyles?.(serverId)
  return (await read?.catch(() => null)) ?? null
}
