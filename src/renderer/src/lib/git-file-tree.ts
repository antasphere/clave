import type { GitFileStatus } from '../../../preload/index.d'

export interface GitTreeNode {
  name: string
  path: string
  type: 'directory' | 'file'
  children?: GitTreeNode[]
  file?: GitFileStatus
}

export interface FlatGitTreeNode {
  type: 'directory' | 'file'
  name: string
  path: string
  depth: number
  expanded: boolean
  file?: GitFileStatus
}

/**
 * Build a tree of GitTreeNode from a flat list of GitFileStatus.
 * Sorts each level: directories first, then files, alphabetically.
 */
export function buildGitTree(files: GitFileStatus[]): GitTreeNode[] {
  const root: GitTreeNode = { name: '', path: '', type: 'directory', children: [] }

  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (isLast) {
        current.children!.push({
          name: part,
          path: file.path,
          type: 'file',
          file
        })
      } else {
        const dirPath = parts.slice(0, i + 1).join('/')
        let existing = current.children!.find((c) => c.type === 'directory' && c.name === part)
        if (!existing) {
          existing = { name: part, path: dirPath, type: 'directory', children: [] }
          current.children!.push(existing)
        }
        current = existing
      }
    }
  }

  sortNodes(root.children!)
  return root.children!
}

function sortNodes(nodes: GitTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.children) sortNodes(node.children)
  }
}

/**
 * Collapse single-child directory chains.
 * e.g. src/renderer/src becomes one node with name "src/renderer/src".
 */
export function compactTree(nodes: GitTreeNode[]): GitTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'directory' || !node.children) return node

    let current = node
    while (
      current.type === 'directory' &&
      current.children &&
      current.children.length === 1 &&
      current.children[0].type === 'directory'
    ) {
      const child = current.children[0]
      current = {
        name: current.name + '/' + child.name,
        path: child.path,
        type: 'directory',
        children: child.children
      }
    }

    return {
      ...current,
      children: current.children ? compactTree(current.children) : undefined
    }
  })
}

/**
 * Flatten tree into array for rendering, respecting expanded paths.
 */
export function flattenGitTree(
  nodes: GitTreeNode[],
  expandedPaths: Set<string>,
  depth = 0
): FlatGitTreeNode[] {
  const result: FlatGitTreeNode[] = []
  for (const node of nodes) {
    const expanded = node.type === 'directory' && expandedPaths.has(node.path)
    result.push({
      type: node.type,
      name: node.name,
      path: node.path,
      depth,
      expanded,
      file: node.file
    })
    if (expanded && node.children) {
      result.push(...flattenGitTree(node.children, expandedPaths, depth + 1))
    }
  }
  return result
}

/**
 * Collect all directory paths in a tree (for "expand all").
 */
export function collectAllDirPaths(nodes: GitTreeNode[]): Set<string> {
  const paths = new Set<string>()
  function walk(ns: GitTreeNode[]): void {
    for (const n of ns) {
      if (n.type === 'directory') {
        paths.add(n.path)
        if (n.children) walk(n.children)
      }
    }
  }
  walk(nodes)
  return paths
}
