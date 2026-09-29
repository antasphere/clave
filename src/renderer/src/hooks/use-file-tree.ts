import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { DirEntry } from '../../../preload/index.d'
import { useSessionStore } from '../store/session-store'
import {
  flattenTree,
  findNode,
  updateNodeChildren,
  toggleNodeExpanded,
  setNodeLoading,
  type BaseTreeNode
} from '../lib/tree-utils'

export interface TreeNode extends BaseTreeNode {
  children?: TreeNode[]
  ignored?: boolean
}

export interface FlatTreeNode extends TreeNode {
  depth: number
}

/** One shared empty set, so a folder with nothing open does not hand a fresh
 *  object to every render and re-run the effects keyed on it. */
const EMPTY_EXPANDED: Set<string> = new Set()

/** Mark nodes whose paths appear in the ignored set */
function applyIgnored(nodes: TreeNode[], ignoredSet: Set<string>): TreeNode[] {
  return nodes.map((node) => {
    const ignored = ignoredSet.has(node.path)
    if (node.children) {
      return { ...node, ignored, children: applyIgnored(node.children, ignoredSet) }
    }
    return { ...node, ignored }
  })
}

/** Which of these paths git ignores. */
async function resolveIgnored(rootCwd: string, nodes: TreeNode[]): Promise<Set<string>> {
  const paths = nodes.map((n) => n.path)
  if (paths.length === 0) return new Set()
  const ignored = await window.electronAPI?.gitCheckIgnored(rootCwd, paths)
  return new Set(ignored ?? [])
}

/**
 * Decide a fresh listing's ignored flags BEFORE it is handed to React.
 *
 * These used to be filled in afterwards, by a second pass that re-rendered the
 * rows once git answered — so every row arrived at full strength and then went
 * grey a moment later. On a folder of build output that is the whole listing
 * flashing black. The status is part of what a row IS, not an embellishment on
 * it, so it is resolved with the listing and the row is painted once.
 *
 * The parent's flag short-circuits it: git does not descend into an ignored
 * directory, so everything inside one is ignored too. That saves the round trip
 * exactly where the listing is longest — an ignored output or cache directory
 * used to ask git about every path inside it to be told what its parent already
 * knew. (The very worst offenders never arrive here at all: node_modules, .git
 * and friends are dropped from every listing by IGNORED_DIRECTORIES in main.)
 */
async function withIgnored(
  rootCwd: string,
  children: TreeNode[],
  parentIgnored: boolean
): Promise<TreeNode[]> {
  if (parentIgnored) return children.map((c) => ({ ...c, ignored: true }))
  const set = await resolveIgnored(rootCwd, children)
  if (set.size === 0) return children.map((c) => ({ ...c, ignored: false }))
  return children.map((c) => ({ ...c, ignored: set.has(c.path) }))
}

/** Batch-check which paths are gitignored, then mark them in the tree */
async function enrichWithIgnored(
  rootCwd: string,
  nodes: TreeNode[],
  setRootNodes: React.Dispatch<React.SetStateAction<TreeNode[]>>,
  parentDirPath?: string
): Promise<void> {
  const paths = nodes.map((n) => n.path)
  if (paths.length === 0) return

  const ignoredPaths = await window.electronAPI?.gitCheckIgnored(rootCwd, paths)
  if (!ignoredPaths || ignoredPaths.length === 0) return

  const ignoredSet = new Set(ignoredPaths)

  setRootNodes((prev) => {
    if (parentDirPath) {
      // Enriching children of a specific directory
      return markIgnoredInChildren(prev, parentDirPath, ignoredSet)
    }
    // Enriching root-level nodes
    return applyIgnored(prev, ignoredSet)
  })
}

/** Apply ignored flags to children of a specific parent node */
function markIgnoredInChildren(
  nodes: TreeNode[],
  parentPath: string,
  ignoredSet: Set<string>
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath && node.children) {
      return { ...node, children: applyIgnored(node.children, ignoredSet) }
    }
    if (node.children) {
      return { ...node, children: markIgnoredInChildren(node.children, parentPath, ignoredSet) }
    }
    return node
  })
}

/** Merge new entries into an existing parent node's children, preserving expansion state */
function mergeNodeChildren(
  nodes: TreeNode[],
  parentPath: string,
  newChildren: TreeNode[]
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      if (!node.children) return node // Not expanded — skip
      const existingByPath = new Map(node.children.map((c) => [c.path, c]))
      const merged = newChildren.map((child) => {
        const existing = existingByPath.get(child.path)
        if (existing && existing.type === child.type && child.type === 'directory') {
          return {
            ...child,
            expanded: existing.expanded,
            children: existing.children,
            ignored: existing.ignored,
            loading: existing.loading
          }
        }
        if (existing) {
          return { ...child, ignored: existing.ignored }
        }
        return child
      })
      return { ...node, children: merged }
    }
    if (node.children) {
      return { ...node, children: mergeNodeChildren(node.children, parentPath, newChildren) }
    }
    return node
  })
}

/** Collect the relative paths of every expanded directory (the visible dirs) */
function collectExpandedDirs(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'directory' && node.expanded) {
      acc.push(node.path)
      if (node.children) collectExpandedDirs(node.children, acc)
    }
  }
  return acc
}

/** Recursively collapse all nodes */
function collapseAllNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'directory') {
      return {
        ...node,
        expanded: false,
        children: node.children ? collapseAllNodes(node.children) : undefined
      }
    }
    return node
  })
}

export function useFileTree(cwd: string | null): {
  rootNodes: TreeNode[]
  flatList: TreeNode[]
  loading: boolean
  filter: string
  setFilter: React.Dispatch<React.SetStateAction<string>>
  toggleDir: (dirPath: string) => Promise<void>
  refreshDir: (dirPath: string) => Promise<void>
  collapseAll: () => void
} {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [allFiles, setAllFiles] = useState<string[] | null>(null)

  /**
   * Which folders are open is the SIDE PANEL's state, not this tree's.
   *
   * It used to be a ref-held Map here, private to the Files tab, so the Git
   * tab's tree of the same folders remembered its own — you browsed to a path
   * in one, switched, and walked it again in the other. The set now lives in
   * the store (`panelExpandedDirs`, keyed by panel folder) and both tabs read
   * and write it; panel-expansion.ts does the conversion at the Git tab's
   * absolute-path edge.
   *
   * Read through a ref as well as through the selector. The load and
   * refresh paths are async callbacks memoised on `[]` so they can recurse
   * without re-creating, and a selector value closed over at their creation
   * would be the set as it was then. The ref is always current.
   */
  const expandedByBase = useSessionStore((s) => s.panelExpandedDirs)
  const setPanelExpandedDirs = useSessionStore((s) => s.setPanelExpandedDirs)
  const setPanelDirExpanded = useSessionStore((s) => s.setPanelDirExpanded)
  const expandedRef = useRef(expandedByBase)
  expandedRef.current = expandedByBase
  const expandedFor = useCallback(function expandedFor(base: string): Set<string> {
    return expandedRef.current[base] ?? EMPTY_EXPANDED
  }, [])
  /** The current tree, readable from callbacks that must not depend on it —
   *  loadChildren is memoised on [] so it can recurse without re-creating. */
  const nodesRef = useRef<TreeNode[]>([])
  nodesRef.current = rootNodes

  // Load root directory when cwd changes
  useEffect(() => {
    if (!cwd) {
      setRootNodes([])
      return
    }

    let cancelled = false
    setLoading(true)

    const load = async (): Promise<void> => {
      try {
        const entries = await window.electronAPI?.readDir(cwd, '.')
        if (cancelled || !entries) return

        // Restore expansion state — the panel's shared set, so a folder opened
        // in the Git tab is already open when this tree first draws.
        const expanded = expandedFor(cwd)

        const nodes: TreeNode[] = entries.map((e: DirEntry) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
          expanded: expanded.has(e.path),
          loading: false,
          depth: 0,
          children: e.type === 'directory' ? undefined : undefined
        }))

        // Same rule at the root: decided before it is drawn. The root itself is
        // the folder you opened, so nothing above it can be ignored.
        const marked = await withIgnored(cwd, nodes, false)
        if (cancelled) return
        setRootNodes(marked)

        // Auto-expand previously expanded dirs
        for (const node of nodes) {
          if (node.type === 'directory' && expanded.has(node.path)) {
            loadChildren(cwd, node.path)
          }
        }
      } catch (err) {
        console.error('Failed to load directory:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  // Load full recursive file list when filter is active
  const hasFilter = filter.length > 0
  useEffect(() => {
    if (!cwd || !hasFilter) {
      setAllFiles(null)
      return
    }

    let cancelled = false
    window.electronAPI?.listFiles(cwd).then((result) => {
      if (cancelled || !result) return
      setAllFiles(result.files)
    })

    return () => {
      cancelled = true
    }
  }, [cwd, hasFilter])

  // Watch for file system changes and merge updates into the tree
  useEffect(() => {
    if (!cwd) return

    const unsub = window.electronAPI?.onFsChanged((changedCwd, changedDirs) => {
      if (changedCwd !== cwd) return

      for (const dir of changedDirs) {
        window.electronAPI
          ?.readDir(cwd, dir === '.' ? '.' : dir)
          .then((entries) => {
            if (!entries) return

            const newChildren: TreeNode[] = entries.map((e: DirEntry) => ({
              name: e.name,
              path: e.path,
              type: e.type,
              size: e.size,
              expanded: false,
              loading: false,
              depth: 0
            }))

            if (dir === '.') {
              // Merge root nodes, preserving expanded directories
              setRootNodes((prev) => {
                const prevByPath = new Map(prev.map((n) => [n.path, n]))
                return newChildren.map((child) => {
                  const existing = prevByPath.get(child.path)
                  if (existing && existing.type === child.type && child.type === 'directory') {
                    return {
                      ...child,
                      expanded: existing.expanded,
                      children: existing.children,
                      ignored: existing.ignored,
                      loading: existing.loading
                    }
                  }
                  if (existing) {
                    return { ...child, ignored: existing.ignored }
                  }
                  return child
                })
              })
            } else {
              setRootNodes((prev) => mergeNodeChildren(prev, dir, newChildren))
            }

            // Enrich gitignore status for new entries
            enrichWithIgnored(cwd, newChildren, setRootNodes, dir === '.' ? undefined : dir)
          })
          .catch(() => {
            // Directory may have been deleted — ignore
          })
      }
    })

    return () => {
      window.electronAPI?.unwatchDir()
      unsub?.()
    }
  }, [cwd])

  // Keep the set of watched directories equal to the visible (expanded) ones.
  // Resends only when the expanded-dir set actually changes, not on every
  // status/ignore re-render. The main process reconciles add/remove.
  const watchKey = useMemo(() => collectExpandedDirs(rootNodes).sort().join('\n'), [rootNodes])
  useEffect(() => {
    if (!cwd) return
    const dirs = watchKey ? watchKey.split('\n') : []
    window.electronAPI?.watchDir(cwd, dirs)
  }, [cwd, watchKey])

  const loadChildren = useCallback(
    async (rootCwd: string, dirPath: string, currentNodes?: TreeNode[]) => {
      try {
        const entries = await window.electronAPI?.readDir(rootCwd, dirPath)
        if (!entries) return

        // The shared set again, for the deeper levels of this branch.
        const expanded = expandedFor(rootCwd)

        const children: TreeNode[] = entries.map((e: DirEntry) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
          expanded: e.type === 'directory' && expanded.has(e.path),
          loading: false,
          depth: 0
        }))

        // Resolved BEFORE the rows are handed over, so a row is painted once
        // rather than at full strength and then grey. Costs one git call that
        // used to happen a beat later anyway — and none at all inside an
        // already-ignored directory.
        const marked = await withIgnored(
          rootCwd,
          children,
          !!findNode(nodesRef.current, dirPath)?.ignored
        )

        setRootNodes((prev) => {
          const nodes = currentNodes ?? prev
          return updateNodeChildren(nodes, dirPath, marked)
        })

        // Recursively load children for subdirectories that were previously expanded
        for (const child of children) {
          if (child.type === 'directory' && expanded.has(child.path)) {
            loadChildren(rootCwd, child.path)
          }
        }
      } catch (err) {
        console.error('Failed to load children:', err)
      }
    },
    // `expandedFor` is memoised on [] and reads the set through a ref, so this
    // stays the stable identity the recursion needs.
    [expandedFor]
  )

  /**
   * Follow the shared set when the OTHER tab moves it.
   *
   * This tree materialises expansion into its own nodes at load time, and the
   * load is keyed on `cwd` — so a folder opened in the Git tab changed the
   * store and nothing here noticed. The tab stays mounted while hidden
   * (SidePanel keeps it in the DOM precisely so its state survives), which
   * means it does not even re-load on the way back: you switched to Files and
   * found the tree exactly as you had left it, which is the bug this whole
   * change is about.
   *
   * Reconciling rather than reloading: the node shape, its loaded children and
   * its ignored flags all stay, and only the `expanded` flags are brought into
   * line with the set. A directory that the set opened but that has never been
   * read gets its children fetched, which is what `loadChildren` already does
   * for the deeper levels of its own branch.
   *
   * Idempotent on purpose. `toggleDir` writes the store AND the nodes, so this
   * effect re-runs and finds nothing to do; it settles instead of looping.
   */
  const expandedHere = cwd ? expandedByBase[cwd] : undefined
  useEffect(() => {
    if (!cwd) return
    const expanded = expandedHere ?? EMPTY_EXPANDED

    // Which directories disagree with the set, and which of those need reading.
    const toLoad: string[] = []
    let differs = false
    const walk = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directory') {
          const want = expanded.has(node.path)
          if (want !== node.expanded) {
            differs = true
            if (want && !node.children) toLoad.push(node.path)
          }
          if (node.children) walk(node.children)
        }
      }
    }
    walk(nodesRef.current)
    if (!differs) return

    const apply = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) =>
        node.type === 'directory'
          ? {
              ...node,
              expanded: expanded.has(node.path),
              children: node.children ? apply(node.children) : node.children
            }
          : node
      )
    setRootNodes((prev) => apply(prev))
    for (const dirPath of toLoad) loadChildren(cwd, dirPath)
  }, [cwd, expandedHere, loadChildren])

  const toggleDir = useCallback(
    async (dirPath: string) => {
      if (!cwd) return

      setRootNodes((prev) => {
        const node = findNode(prev, dirPath)
        if (!node) return prev

        const willExpand = !node.expanded

        // Record it on the panel's shared set, which the Git tab reads too.
        setPanelDirExpanded(cwd, dirPath, willExpand)

        // If expanding and no children loaded yet, mark loading
        if (willExpand && !node.children) {
          const updated = toggleNodeExpanded(prev, dirPath)
          return setNodeLoading(updated, dirPath, true)
        }

        return toggleNodeExpanded(prev, dirPath)
      })

      // `rootNodes` here is the pre-toggle snapshot, so `!node.expanded` means
      // "we are expanding". Always refresh on expand — the watcher only covers
      // currently-expanded dirs, so a branch that was collapsed (and therefore
      // unwatched) can have gone stale on disk. Cached children paint instantly;
      // loadChildren re-reads and recursively reconciles the expanded subtree.
      const node = findNode(rootNodes, dirPath)
      if (node && !node.expanded) {
        await loadChildren(cwd, dirPath)
        if (!node.children) {
          setRootNodes((prev) => setNodeLoading(prev, dirPath, false))
        }
      }
    },
    [cwd, rootNodes, loadChildren, setPanelDirExpanded]
  )

  const refreshDir = useCallback(
    async (dirPath: string) => {
      if (!cwd) return
      // Reload children of the given directory (or root if '.')
      if (dirPath === '.') {
        const entries = await window.electronAPI?.readDir(cwd, '.')
        if (!entries) return
        const expanded = expandedFor(cwd)
        const nodes: TreeNode[] = entries.map((e: DirEntry) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
          expanded: expanded.has(e.path),
          loading: false,
          depth: 0
        }))
        setRootNodes(await withIgnored(cwd, nodes, false))
        for (const node of nodes) {
          if (node.type === 'directory' && expanded.has(node.path)) {
            loadChildren(cwd, node.path, nodes)
          }
        }
      } else {
        await loadChildren(cwd, dirPath)
      }
    },
    [cwd, loadChildren, expandedFor]
  )

  const collapseAll = useCallback(() => {
    if (!cwd) return
    setPanelExpandedDirs(cwd, new Set())
    setRootNodes((prev) => collapseAllNodes(prev))
  }, [cwd, setPanelExpandedDirs])

  const flatList = useMemo(() => {
    if (!filter) return flattenTree(rootNodes)

    const lowerFilter = filter.toLowerCase()

    // Use recursive file list when available for deep search
    if (allFiles) {
      return allFiles
        .filter((f) => f.toLowerCase().includes(lowerFilter))
        .slice(0, 200)
        .map((f): FlatTreeNode => {
          const lastSlash = f.lastIndexOf('/')
          return {
            name: lastSlash >= 0 ? f.slice(lastSlash + 1) : f,
            path: f,
            type: 'file',
            expanded: false,
            loading: false,
            depth: 0
          }
        })
    }

    // Fallback: search loaded nodes only
    const matches: FlatTreeNode[] = []
    function collectMatches(nodes: TreeNode[]): void {
      for (const node of nodes) {
        if (node.type === 'file' && node.name.toLowerCase().includes(lowerFilter)) {
          matches.push({ ...node, depth: 0 })
        }
        if (node.children) collectMatches(node.children)
      }
    }
    collectMatches(rootNodes)
    return matches
  }, [rootNodes, filter, allFiles])

  return { rootNodes, flatList, loading, filter, setFilter, toggleDir, refreshDir, collapseAll }
}
