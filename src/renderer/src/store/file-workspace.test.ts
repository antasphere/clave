import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  Object.assign(globalThis, { localStorage, window: { localStorage, electronAPI: {} } })
})
import { useSessionStore, inActiveWorkspace } from './session-store'
import { useWorkspaceStore } from './workspace-store'

beforeEach(() => {
  useSessionStore.setState({ fileTabs: [], sessions: [], groups: [], displayOrder: [] })
  useWorkspaceStore.setState({ activeWorkspaceId: 'a' })
})
it('keeps file and diff viewers in the workspace that opened them', () => {
  const add = useSessionStore.getState().addFileTab
  add({ id: 'file-a', filePath: '/shared/report.md', name: 'Report' })
  const first = useSessionStore.getState().fileTabs[0]
  expect(inActiveWorkspace(first, 'a')).toBe(true)
  expect(inActiveWorkspace(first, 'b')).toBe(false)
  useWorkspaceStore.setState({ activeWorkspaceId: 'b' })
  add({ id: 'file-b', filePath: '/shared/report.md', name: 'Report B' })
  add({ id: 'file-b-again', filePath: '/shared/report.md', name: 'Report B' })
  expect(useSessionStore.getState().fileTabs.map((f) => f.id)).toEqual(['file-a', 'file-b'])
  expect(useSessionStore.getState().focusedSessionId).toBe('file-b')
})
it('preserves an explicit caller workspace while another workspace is visible', () => {
  useSessionStore.getState().addFileTab({
    id: 'file-background',
    filePath: '/elsewhere/report.html',
    name: 'Report',
    workspaceId: 'b'
  })
  expect(useSessionStore.getState().fileTabs[0].workspaceId).toBe('b')
})

it('keeps the visible selection and dashboard when a background caller opens or reopens a file', () => {
  useSessionStore.setState({
    selectedSessionIds: ['visible-session'],
    focusedSessionId: 'visible-session',
    activeGroupViewId: 'visible-dashboard',
    activeView: 'terminals'
  })
  const tab = {
    id: 'file-hidden',
    filePath: '/background/report.html',
    name: 'Report',
    workspaceId: 'b'
  }
  const add = useSessionStore.getState().addFileTab
  add(tab)
  add({ ...tab, id: 'file-hidden-again', view: 'source' })
  const state = useSessionStore.getState()
  expect(state.fileTabs).toHaveLength(1)
  expect(state.fileTabs[0].view).toBe('source')
  expect(state.selectedSessionIds).toEqual(['visible-session'])
  expect(state.focusedSessionId).toBe('visible-session')
  expect(state.activeGroupViewId).toBe('visible-dashboard')
})
