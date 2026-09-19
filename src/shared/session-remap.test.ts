import { expect, test } from 'vitest'
import { remapHiddenOwner, remapSessionLayout } from './session-remap'

test('migration remaps only identity slots and deduplicates an already imported session', () => {
  const layout = {
    groups: [
      {
        id: 'group',
        name: 'old',
        sessionIds: ['before', 'old', 'new', 'after'],
        terminals: [{ id: 'terminal', sessionId: 'server', command: 'old' }]
      }
    ],
    displayOrder: ['group', 'old', 'new']
  }
  const result = remapSessionLayout(layout, { old: 'new' })
  expect(result.groups[0]).toEqual({
    id: 'group',
    name: 'old',
    sessionIds: ['before', 'new', 'after'],
    terminals: [{ id: 'terminal', sessionId: 'server', command: 'old' }]
  })
  expect(result.displayOrder).toEqual(['group', 'new'])
  expect(layout.groups[0].sessionIds).toContain('old')
  expect(
    remapHiddenOwner({ link: { kind: 'session-view', ownerId: 'old' } }, { old: 'new' }).link
      .ownerId
  ).toBe('new')
})
