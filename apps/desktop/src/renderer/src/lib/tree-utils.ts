/** Shared tree node shape used by both local and remote file trees. */
export interface BaseTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: BaseTreeNode[]
  expanded: boolean
  loading: boolean
  depth: number
}

/** Flatten a tree into a depth-annotated list, respecting expansion state. */
export function flattenTree<T extends BaseTreeNode>(nodes: T[], depth = 0): T[] {
  const result: T[] = []
  for (const node of nodes) {
    result.push({ ...node, depth } as T)
    if (node.type === 'directory' && node.expanded && node.children) {
      result.push(...flattenTree(node.children as T[], depth + 1))
    }
  }
  return result
}

/** Find a node by path in a tree, recursing into children. */
export function findNode<T extends BaseTreeNode>(nodes: T[], path: string): T | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNode(node.children as T[], path)
      if (found) return found as T
    }
  }
  return null
}

/** Recursively update a node's children at a given path. */
export function updateNodeChildren<T extends BaseTreeNode>(
  nodes: T[],
  path: string,
  children: T[]
): T[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, children, loading: false }
    }
    if (node.children) {
      return { ...node, children: updateNodeChildren(node.children as T[], path, children) }
    }
    return node
  })
}

/** Toggle a node's expanded state by path. */
export function toggleNodeExpanded<T extends BaseTreeNode>(nodes: T[], path: string): T[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, expanded: !node.expanded }
    }
    if (node.children) {
      return { ...node, children: toggleNodeExpanded(node.children as T[], path) }
    }
    return node
  })
}

/** Set a node's loading state by path. */
export function setNodeLoading<T extends BaseTreeNode>(
  nodes: T[],
  path: string,
  loading: boolean
): T[] {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, loading }
    }
    if (node.children) {
      return { ...node, children: setNodeLoading(node.children as T[], path, loading) }
    }
    return node
  })
}
