import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FlatTreeNode } from '../../hooks/use-file-tree'
import { FileTreeItem } from './FileTreeItem'

// The row reads the indent setting from the store; a fixed step keeps the store
// (and the browser storage it reads at load) out of a render test.
vi.mock('./tree-metrics', () => ({ TREE_ROW_PAD_PX: 12, useTreeIndentPx: () => 12 }))

const noop = (): void => {}
const folder = (over: Partial<FlatTreeNode>): FlatTreeNode =>
  ({ name: 'src', path: '/repo/src', type: 'directory', depth: 0, ...over }) as FlatTreeNode

const render = (node: FlatTreeNode): string =>
  renderToStaticMarkup(
    <FileTreeItem
      node={node}
      isSelected={false}
      onClickFile={noop}
      onSelect={noop}
      onDoubleClickFile={noop}
      onDoubleClickDir={noop}
      onToggleDir={noop}
      onContextMenu={noop}
      onDragStart={noop}
    />
  )

it('a folder opening for the first time keeps its chevron, already turned, and no spinner', () => {
  const html = render(folder({ loading: true, expanded: false }))
  expect(html).not.toContain('animate-spin')
  expect(html).not.toContain('<circle')
  expect(html).toMatch(/class="tree-chevron[^"]*rotate-90/)
  expect(html).toContain('data-loading="true"')
})

it('the same chevron, at rest, once loaded', () => {
  const open = render(folder({ loading: false, expanded: true }))
  expect(open).toMatch(/class="tree-chevron[^"]*rotate-90/)
  expect(open).not.toContain('data-loading')
  const shut = render(folder({ loading: false, expanded: false }))
  expect(shut).not.toMatch(/rotate-90/)
})
