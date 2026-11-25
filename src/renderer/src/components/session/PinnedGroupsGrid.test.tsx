/**
 * The drop zone of the pins says what a drop does, and says nothing when a
 * drop does nothing (PRDCT-4830). The decision is pinned-store's
 * `pinDropAction`, tested there; this is the zone obeying it. A server's group
 * is the case behind it: it is never pinned from here, and a zone reading
 * "Pin" over a drop that does nothing is a promise the app does not keep.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PinnedGroupsGrid } from './PinnedGroupsGrid'

const mocks = vi.hoisted(() => ({
  action: vi.fn<(groupId: string) => 'pin' | 'show' | null>()
}))
vi.mock('../../store/pinned-store', () => ({
  pinDropAction: mocks.action,
  importClaveFile: vi.fn(),
  usePinnedStore: (select: (s: { pinnedGroups: unknown[] }) => unknown) =>
    select({ pinnedGroups: [] })
}))
vi.mock('../../store/workspace-store', () => ({
  useWorkspaceStore: (select: (s: { activeWorkspaceId: string | null }) => unknown) =>
    select({ activeWorkspaceId: 'ws' })
}))

const zone = (props: React.ComponentProps<typeof PinnedGroupsGrid>): string =>
  renderToStaticMarkup(<PinnedGroupsGrid {...props} />)

describe('the drop zone of the pins', () => {
  it('shows no zone for a group whose drop does nothing', () => {
    mocks.action.mockReturnValue(null)
    const html = zone({ draggedGroupId: 'server-group', isOverPinnedZone: true })
    expect(mocks.action).toHaveBeenCalledWith('server-group')
    expect(html).not.toContain('data-pin-drop-zone')
    expect(html).not.toMatch(/Pin|pin/)
  })

  it('says Pin, then Drop to pin, for a group that has no pin', () => {
    mocks.action.mockReturnValue('pin')
    expect(zone({ draggedGroupId: 'g' })).toMatch(/data-pin-drop-zone="pin"[^>]*>.*>Pin</)
    expect(zone({ draggedGroupId: 'g', isOverPinnedZone: true })).toMatch(
      /data-pin-drop-zone="pin"[^>]*>.*>Drop to pin</
    )
  })

  it('says Show pin, then Drop to show its pin, for a group that has one', () => {
    mocks.action.mockReturnValue('show')
    expect(zone({ draggedGroupId: 'g' })).toMatch(/data-pin-drop-zone="show"[^>]*>.*>Show pin</)
    expect(zone({ draggedGroupId: 'g', isOverPinnedZone: true })).toMatch(
      /data-pin-drop-zone="show"[^>]*>.*>Drop to show its pin</
    )
  })

  it('asks nothing and shows no group zone while no group is dragged', () => {
    mocks.action.mockClear()
    const html = zone({ isFileDragOver: true })
    expect(mocks.action).not.toHaveBeenCalled()
    expect(html).not.toContain('data-pin-drop-zone')
    expect(html).toContain('Drop .clave')
  })
})
