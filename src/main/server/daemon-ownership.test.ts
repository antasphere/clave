import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startEmbedded } from '../../../packages/server/src/embedded'
import { SidebarLayouts } from '../../../packages/server/src/sidebar/layouts'
import { fileSidebarStorage, noWindowsHost } from '../../../packages/server/src/sidebar/ports'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const directory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-vps-b-'))
  dirs.push(dir)
  return dir
}

describe('standalone server ownership', () => {
  it('uses the durable server identity for the listener and hello identity', async () => {
    const server = await startEmbedded({ ports: {}, serverId: 'durable-server-id' })
    try {
      expect(server.serverId).toBe('durable-server-id')
    } finally {
      await server.stop()
    }
  })

  it('shares one layout across client window keys and rejects their stale saves', () => {
    const sidebar = new SidebarLayouts(fileSidebarStorage(directory()), noWindowsHost, {
      layoutKey: 'server'
    })
    const before = sidebar.get('mac-a')
    sidebar.createGroup('mac-a', { id: 'group-a', name: 'VPS', sessionIds: ['session-a'] })
    const second = sidebar.get('mac-b')
    expect(second.windowKey).toBe('server')
    expect(second.groups.map((group) => group.name)).toEqual(['VPS'])
    expect(sidebar.save('mac-b', { groups: [], displayOrder: [] }, before.revision).ok).toBe(false)
  })

  it('preserves the layout revision over a daemon restart', () => {
    const dir = directory()
    const first = new SidebarLayouts(fileSidebarStorage(dir), noWindowsHost)
    first.createGroup('server', { id: 'group-a', name: 'VPS' })
    const revision = first.get('server').revision
    const restarted = new SidebarLayouts(fileSidebarStorage(dir), noWindowsHost)
    expect(restarted.get('server').revision).toBe(revision)
    expect(restarted.save('server', { groups: [], displayOrder: [] }, 0).ok).toBe(false)
  })
})

it('keeps collapse presentation local and broadcasts the canonical server layout', () => {
  const sidebar = new SidebarLayouts(fileSidebarStorage(directory()), noWindowsHost, {
    layoutKey: 'server'
  })
  const events: unknown[] = []
  sidebar.onChange((event) => events.push(event))
  sidebar.createGroup('mac-a', { id: 'g', name: 'Group' })
  sidebar.setGroupCollapsed('mac-b', 'g', true)
  expect(sidebar.get('mac-a').groups[0].collapsed).toBe(false)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ layout: { windowKey: 'server' } })
  sidebar.windowClosed('mac-a', null)
  expect(sidebar.get('mac-b').groups[0].id).toBe('g')
})
