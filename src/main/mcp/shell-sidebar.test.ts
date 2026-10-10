import { describe, expect, it } from 'vitest'
import { SidebarLayouts, memorySidebarStorage, noWindowsHost } from '@clave/server'
import { shellSidebarClient } from './shell-sidebar'

/**
 * The sidebar client over the shell's own layouts (wave 4): the same calls
 * the typed client answers, on main's instance, with the class's failures
 * thrown by their tag as the client throws the contract's.
 */
describe('shellSidebarClient', () => {
  it('reads, makes a group, places a tab in it, and lists what it holds', async () => {
    const layouts = new SidebarLayouts(memorySidebarStorage(), noWindowsHost)
    const client = shellSidebarClient(layouts)
    expect((await client.getLayout('w1')).groups).toEqual([])
    const { group } = await client.createGroup({ windowKey: 'w1', group: { name: 'Build' } })
    const placed = await client.placeSession({
      windowKey: 'w1',
      sessionId: 's1',
      groupId: group.id
    })
    expect(placed.groups[0]).toMatchObject({ id: group.id, sessionIds: ['s1'] })
    expect((await client.listLayouts()).map((l) => l.windowKey)).toEqual(['w1'])
    const renamed = await client.renameGroup({ windowKey: 'w1', groupId: group.id, name: 'Ship' })
    expect(renamed.groups[0].name).toBe('Ship')
  })
  it('throws the class’s failure with its tag', async () => {
    const client = shellSidebarClient(new SidebarLayouts(memorySidebarStorage(), noWindowsHost))
    await expect(
      client.renameGroup({ windowKey: 'w1', groupId: 'nope', name: 'x' })
    ).rejects.toMatchObject({ _tag: 'GroupNotFound', groupId: 'nope' })
  })
})
