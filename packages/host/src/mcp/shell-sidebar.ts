/**
 * The sidebar client over the SHELL's own layouts (wave 4, PRDCT-3377): the
 * same `SidebarClient` surface the typed client gives, answered by main's
 * `SidebarLayouts` instance instead of a server's. An app attached to a
 * server running apart keeps its sidebar in the shell (the server hosts no
 * windows), so an agent tool served there places a tab or makes a group
 * through this, and the window hears the change over IPC as it hears every
 * shell-side change. The class's plain failures are thrown with their `_tag`,
 * as the client throws the contract's.
 */
import type { SidebarClient } from '@clave/client'
import type { SidebarLayouts } from '@clave/server'

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { _tag: string } }

const settle = <T>(result: Outcome<T>): Promise<T> =>
  result.ok
    ? Promise.resolve(result.value)
    : Promise.reject(Object.assign(new Error(result.error._tag), result.error))

export function shellSidebarClient(layouts: SidebarLayouts): SidebarClient {
  return {
    getLayout: async (windowKey) => layouts.get(windowKey),
    listLayouts: async () => layouts.list(),
    saveLayout: (p) =>
      settle(
        layouts.save(
          p.windowKey,
          { groups: p.groups, displayOrder: p.displayOrder },
          p.baseRevision
        )
      ),
    createGroup: async (p) => layouts.createGroup(p.windowKey, p.group),
    renameGroup: (p) => settle(layouts.renameGroup(p.windowKey, p.groupId, p.name)),
    setGroupView: (p) => settle(layouts.setGroupView(p.windowKey, p.groupId, p.view)),
    setGroupColor: (p) => settle(layouts.setGroupColor(p.windowKey, p.groupId, p.color)),
    setGroupPrompt: (p) => settle(layouts.setGroupPrompt(p.windowKey, p.groupId, p.prompt)),
    setGroupCollapsed: (p) =>
      settle(layouts.setGroupCollapsed(p.windowKey, p.groupId, p.collapsed)),
    deleteGroup: (p) => settle(layouts.deleteGroup(p.windowKey, p.groupId, p.mode)),
    addTerminal: (p) => settle(layouts.addTerminal(p.windowKey, p.groupId, p.terminal)),
    updateTerminal: (p) =>
      settle(layouts.updateTerminal(p.windowKey, p.groupId, p.terminalId, p.patch)),
    removeTerminal: (p) => settle(layouts.removeTerminal(p.windowKey, p.groupId, p.terminalId)),
    moveItems: async (p) => layouts.moveItems(p.windowKey, p.itemIds, p.targetId, p.position),
    placeSession: async (p) => layouts.placeSession(p.windowKey, p.sessionId, p.groupId),
    removeSession: async (p) => layouts.removeSession(p.windowKey, p.sessionId),
    absorbLayout: async (p) =>
      layouts.absorb(p.windowKey, { groups: p.groups, displayOrder: p.displayOrder }),
    moveSessions: (p) =>
      settle(layouts.moveSessionsToWindow(p.sessionIds, p.targetWindowKey, p.focus ?? false)),
    moveGroup: (p) => settle(layouts.moveGroupToWindow(p.windowKey, p.groupId, p.targetWindowKey))
  }
}
