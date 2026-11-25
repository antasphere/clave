import { beforeEach, describe, expect, it, vi } from 'vitest'
// The stores read localStorage and the preload bridge when they load.
vi.hoisted(() => {
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  Object.assign(globalThis, { localStorage, window: { localStorage, electronAPI: {} } })
})
// The workspace switch (and the account and usage stores it loads, which listen on the
// window as they load) is never reached here: every place below is in the active workspace.
vi.mock('./workspace-actions', () => ({ setActiveWorkspace: vi.fn() }))
import { useSessionStore } from '../store/session-store'
import { useWorkspaceStore } from '../store/workspace-store'
import type { FileTab, Session } from '../store/session-types'
import type { Workspace } from '../../../shared/workspace-types'
import type { Place } from './navigation-history'
import { placeAlive, placeLabel, tabOfPlace } from './navigation-place'

/**
 * The tabs of a recorded place, read off the stores (PRDCT-5155): a tab is the place's only
 * while it exists AND the sidebar and the grid show it in the place's workspace.
 */

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  rootDir: `/work/${id}`,
  profileFile: null,
  createdAt: 1
})

const session = (id: string, workspaceId: string | null, over: Partial<Session> = {}): Session =>
  ({ id, name: `Tab ${id}`, workspaceId, ...over }) as Session

const fileTab = (id: string, workspaceId: string | null): FileTab =>
  ({ id, name: `${id}.md`, filePath: `/work/${id}.md`, workspaceId }) as FileTab

/** Tabs `tabs` in workspace `ws-a`, the first focused, nothing over them. */
const place = (tabs: string[], over: Partial<Place> = {}): Place => ({
  workspaceId: 'ws-a',
  view: 'terminals',
  section: null,
  tabs,
  focused: tabs[0] ?? null,
  groupView: null,
  tabView: null,
  plugin: null,
  beside: tabs.length === 1 ? { [tabs[0]]: null } : null,
  ...over
})

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [workspace('ws-a', 'Alpha'), workspace('ws-b', 'Beta')],
    activeWorkspaceId: 'ws-a'
  })
  useSessionStore.setState({
    sessions: [
      session('tab-1', 'ws-a'),
      session('tab-2', 'ws-a'),
      // Moved into a group of the other workspace since.
      session('tab-moved', 'ws-b', { view: { url: 'http://127.0.0.1:4000/', title: 'Dash' } }),
      // A local tab older than the workspaces: shown in every one.
      session('tab-old', null)
    ],
    fileTabs: [fileTab('file-a', 'ws-a'), fileTab('file-b', 'ws-b')],
    groups: []
  })
})

describe('a tab of a place (PRDCT-5155)', () => {
  it('exists only in the workspace that shows it', () => {
    const s = useSessionStore.getState()
    expect(tabOfPlace(s, 'tab-1', 'ws-a')).toBe(true)
    expect(tabOfPlace(s, 'tab-moved', 'ws-a')).toBe(false)
    expect(tabOfPlace(s, 'tab-moved', 'ws-b')).toBe(true)
    expect(tabOfPlace(s, 'file-a', 'ws-a')).toBe(true)
    expect(tabOfPlace(s, 'file-b', 'ws-a')).toBe(false)
    expect(tabOfPlace(s, 'tab-old', 'ws-a')).toBe(true)
    expect(tabOfPlace(s, 'tab-old', 'ws-b')).toBe(true)
    expect(tabOfPlace(s, 'tab-closed', 'ws-a')).toBe(false)
    // No workspace at all: every tab that exists.
    expect(tabOfPlace(s, 'tab-moved', null)).toBe(true)
    expect(tabOfPlace(s, 'tab-closed', null)).toBe(false)
  })

  it('is gone from a place whose tabs all left its workspace', () => {
    expect(placeAlive(place(['tab-1']))).toBe(true)
    expect(placeAlive(place(['tab-moved']))).toBe(false)
    expect(placeAlive(place(['file-b']))).toBe(false)
    expect(placeAlive(place(['tab-moved', 'file-b']))).toBe(false)
    // One tab still there keeps the mosaic: the restore leaves the others out.
    expect(placeAlive(place(['tab-moved', 'tab-2']))).toBe(true)
    // In the workspace it moved to, it is that workspace's.
    expect(placeAlive(place(['tab-moved'], { workspaceId: 'ws-b' }))).toBe(true)
    // A tab's page goes with its tab.
    expect(placeAlive(place(['tab-moved'], { tabView: 'tab-moved', beside: null }))).toBe(false)
    expect(
      placeAlive(place(['tab-moved'], { workspaceId: 'ws-b', tabView: 'tab-moved', beside: null }))
    ).toBe(true)
  })

  it('is never named in the lists of a place it left', () => {
    expect(placeLabel(place(['tab-moved', 'tab-2'], { focused: 'tab-moved' })).label).toBe(
      'Tab tab-2'
    )
    expect(placeLabel(place(['tab-1', 'tab-2'])).label).toBe('Tab tab-1 + 1')
    // Its page is not what going there shows: the tabs still there are.
    expect(
      placeLabel(place(['tab-moved', 'tab-2'], { tabView: 'tab-moved', beside: null })).label
    ).toBe('Tab tab-2')
  })
})
