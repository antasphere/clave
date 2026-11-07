import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resourceKey } from '@clave/contract/fleet'
import type { FlatTreeNode } from '../../hooks/use-file-tree'

interface Menu {
  items: Array<{ label: string; onClick: () => void | Promise<void> }>
}
const captured = vi.hoisted(() => ({
  updates: [] as unknown[],
  rows: [] as Array<{
    node: FlatTreeNode
    onContextMenu: (event: { clientX: number; clientY: number }, node: FlatTreeNode) => void
  }>,
  nodes: [] as FlatTreeNode[],
  refreshDir: vi.fn(async () => {}),
  journey: vi.fn()
}))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return {
    ...react,
    useState: <S,>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>] => {
      const [state, set] = react.useState(initial)
      return [
        state,
        (value) => {
          captured.updates.push(value)
          set(value)
        }
      ]
    }
  }
})
vi.mock('../../store/session-store', () => ({
  useSessionStore: Object.assign(
    (select: (s: object) => unknown) =>
      select({ focusedSessionId: 'session', collapseAllTrigger: 0 }),
    { getState: () => ({ openJourneyPanel: captured.journey }) }
  )
}))
vi.mock('../../lib/mcp-dispatcher', () => ({ openSessionProgrammatically: vi.fn() }))
vi.mock('../../hooks/use-file-tree', () => ({
  useFileTree: () => ({
    flatList: captured.nodes,
    loading: false,
    filter: '',
    setFilter: vi.fn(),
    toggleDir: vi.fn(),
    refreshDir: captured.refreshDir,
    collapseAll: vi.fn()
  })
}))
vi.mock('./FileTreeItem', () => ({
  FileTreeItem: (props: (typeof captured.rows)[number]) => {
    captured.rows.push(props)
    return null
  }
}))
vi.mock('../ui/ContextMenu', () => ({ ContextMenu: () => null }))
import { FileTree } from './FileTree'

beforeEach(() => {
  vi.clearAllMocks()
  captured.updates.length = 0
  captured.rows.length = 0
  captured.nodes = [
    { name: 'sub', path: 'sub', type: 'directory', depth: 0, expanded: false, loading: false }
  ]
  vi.stubGlobal('window', { electronAPI: { existsSync: () => false } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})
function menu(cwd: string): Menu {
  // Keep the component's real callbacks. The hook adapter records state writes
  // because server rendering has no interactive DOM to commit them into.
  renderToStaticMarkup(<FileTree cwd={cwd} onNavigateToFolder={() => {}} />)
  const row = captured.rows[0]
  row.onContextMenu({ clientX: 1, clientY: 1 }, row.node)
  return captured.updates.find((s): s is Menu => !!s && typeof s === 'object' && 'items' in s)!
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
it.each([
  ['/repo', '/repo/sub'],
  [resourceKey('file', 'vps', '/repo'), resourceKey('file', 'vps', '/repo/sub')]
])('Journey keeps the owner of %s', (root, expected) => {
  menu(root)
    .items.find((item) => item.label === 'Journey')!
    .onClick()
  expect(captured.journey).toHaveBeenCalledExactlyOnceWith(expected, 'sub')
})
it('uses a fixed upload failure sentence and refreshes the destination', async () => {
  const root = resourceKey('file', 'vps', '/repo')
  Object.assign(window.electronAPI, {
    sessionsFiles: { pick: async () => ['/mac/a.txt'] },
    fleetUpload: vi.fn(async () => {
      throw new Error('PRIVATE SERVER DETAIL')
    })
  })
  menu(root)
    .items.find((item) => item.label === 'Upload files here…')!
    .onClick()
  await flush()
  expect(window.electronAPI.fleetUpload).toHaveBeenCalledWith(root, 'sub/a.txt', '/mac/a.txt')
  expect(captured.updates).toContain('Upload failed. Existing files are never overwritten.')
  expect(JSON.stringify(captured.updates)).not.toContain('PRIVATE SERVER DETAIL')
  expect(captured.refreshDir).toHaveBeenCalledWith('sub')
})
it('uses a fixed download failure sentence', async () => {
  captured.nodes = [
    { name: 'file.txt', path: 'file.txt', type: 'file', depth: 0, expanded: false, loading: false }
  ]
  const root = resourceKey('file', 'vps', '/repo')
  Object.assign(window.electronAPI, {
    fleetDownload: vi.fn(async () => {
      throw new Error('PRIVATE SERVER DETAIL')
    })
  })
  menu(root)
    .items.find((item) => item.label === 'Download')!
    .onClick()
  await flush()
  expect(window.electronAPI.fleetDownload).toHaveBeenCalledWith(root, 'file.txt')
  expect(captured.updates).toContain('Download failed.')
  expect(JSON.stringify(captured.updates)).not.toContain('PRIVATE SERVER DETAIL')
})
