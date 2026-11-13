import { describe, expect, it } from 'vitest'
import { ownedLayout, wireLayout } from './fleet-desktop'
import { resourceKey } from '@clave/contract/fleet'
import type { LayoutSnapshot } from '@clave/contract/sidebar/layout'
const layout: LayoutSnapshot = {
  windowKey: 'server',
  revision: 7,
  groups: [
    {
      id: 'g',
      name: 'Group',
      sessionIds: ['s'],
      cwd: '/repo',
      collapsed: false,
      workspaceId: 'ws',
      terminals: [
        { id: 't', command: 'echo ok', commandMode: 'auto', color: 'blue', sessionId: 'hidden' }
      ]
    }
  ],
  displayOrder: ['g', 'other']
}
describe('remote layout wire boundary', () => {
  it('round trips all owner references while excluding local collapse presentation', () => {
    const owned = ownedLayout('vps', layout)
    expect(owned.groups[0].id).toBe(resourceKey('group', 'vps', 'g'))
    expect(owned.groups[0].terminals[0].sessionId).toBe(resourceKey('session', 'vps', 'hidden'))
    const wire = wireLayout('vps', {
      ...owned,
      groups: owned.groups.map((g) => ({ ...g, collapsed: true }))
    })
    expect(wire.groups[0]).toMatchObject(layout.groups[0])
    expect(wire.displayOrder).toEqual(['g', 'other'])
  })
  it('rejects another server session in a layout instead of silently routing it', () => {
    const owned = ownedLayout('vps', layout)
    expect(() =>
      wireLayout('vps', {
        ...owned,
        groups: [{ ...owned.groups[0], sessionIds: [resourceKey('session', 'other-vps', 's')] }]
      })
    ).toThrow(/another server/)
  })
  it('preserves remote preview configuration through a shared-layout edit', () => {
    const owned = ownedLayout('vps', {
      ...layout,
      groups: [{ ...layout.groups[0], view: { url: 'http://localhost:3000' } }]
    })
    expect(owned.groups[0].view?.url).toBe('http://localhost:3000')
    expect(wireLayout('vps', owned).groups[0].view?.url).toBe('http://localhost:3000')
  })
})
