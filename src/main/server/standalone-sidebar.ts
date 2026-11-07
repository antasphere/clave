import { SidebarLayouts, fileSidebarStorage, noWindowsHost } from '@clave/server/sidebar-layouts'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'

/** A daemon owns one sidebar regardless of which client window asks for it. */
export function standaloneSidebar(dataDir: string): SidebarLayouts {
  return new SidebarLayouts(fileSidebarStorage(dataDir, { strict: true }), noWindowsHost, {
    layoutKey: SERVER_LAYOUT_KEY
  })
}
