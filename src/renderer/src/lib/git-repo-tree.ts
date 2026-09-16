/**
 * Spatial repo tree for the multi-repo git panel (PRDCT-1235 / PRDCT-1455).
 *
 * Turns the flat repo list from discovery into the tree the user already has
 * in their head: repos sit under their real parent directories, relative to
 * the panel's folder. Single-child directory chains are compacted into one
 * node ("labs/products" when nothing else branches) so pass-through folders
 * never burn a row — the same idiom compactTree applies to file trees inside
 * a repo (git-file-tree.ts).
 *
 * A git worktree (PRDCT-2356) is not placed where it sits on disk but under
 * the repo it was cut from, as that repo's child: the folder is the reader's
 * accident, the source repo is what the worktree is OF. A worktree whose
 * source is not in the list (a main checkout outside the panel's folder) is
 * an ordinary repo row at its real place.
 *
 * Pure data — no fs, no path module — so it is unit-testable and shared-safe.
 */

export interface RepoRef {
  name: string
  /** Absolute path of the repo root */
  path: string
  /** For a linked worktree, the absolute path of its main checkout. */
  worktreeOf?: string | null
  /** For a linked worktree, when it was created (epoch ms); orders it under its repo. */
  createdAt?: number | null
}

/**
 * A repo's worktrees run newest first (PRDCT-2360): the one cut most
 * recently sits right under the repo and the old lanes drift down. A
 * worktree's name is the lane's, not the reader's, so it only breaks ties
 * and orders the ones with no date, which come last.
 */
function byNewest(a: RepoRef, b: RepoRef): number {
  const ta = a.createdAt ?? null
  const tb = b.createdAt ?? null
  if (ta !== null && tb !== null && ta !== tb) return tb - ta
  if (ta === null && tb !== null) return 1
  if (ta !== null && tb === null) return -1
  return a.name.localeCompare(b.name)
}

export interface RepoTreeDir {
  type: 'dir'
  /** Display label — a compacted chain like "labs/products" */
  name: string
  /** Absolute path of the deepest directory in the compacted chain */
  path: string
  children: RepoTreeNode[]
  /** Absolute paths of every repo in this subtree, worktrees included, for badge roll-ups */
  repoPaths: string[]
}

export interface RepoTreeLeaf {
  type: 'repo'
  name: string
  path: string
  /** The worktrees cut from this repo, alphabetical; rendered under it. */
  worktrees: RepoTreeWorktree[]
}

export interface RepoTreeWorktree {
  type: 'worktree'
  name: string
  path: string
  /** The source repo's path — the leaf this row hangs under. */
  of: string
}

export type RepoTreeNode = RepoTreeDir | RepoTreeLeaf

export interface FlatRepoRow {
  node: RepoTreeNode | RepoTreeWorktree
  depth: number
  /** Directories only — true when the row is folded */
  collapsed: boolean
  /** Worktree rows only — true on the last worktree under its repo, where the guide ends. */
  last?: boolean
}

/**
 * The source a worktree hangs under, spelled the way DISCOVERY spells it.
 * Git names the main checkout symlink-resolved (`/private/tmp/...`) while
 * discovery keeps the path as it walked it (`/tmp/...`), so the two never
 * match by string and every worktree under a symlinked root fell through to
 * a plain repo row without a word (verifier round 1, finding 2). Each repo's
 * status carries its own resolved root, which is the join: the resolved
 * source is looked up among the roots and swapped for the walked path; a
 * source that is no repo of the list stays as it is, and the split below
 * treats it as absent.
 */
export function worktreeSourcePath(
  of: string | null | undefined,
  repos: ReadonlyArray<{ path: string; repoRoot: string }>
): string | null {
  if (!of) return null
  const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  const wanted = trim(of)
  for (const repo of repos) {
    if (trim(repo.repoRoot) === wanted || trim(repo.path) === wanted) return repo.path
  }
  return of
}

/**
 * Split the list into the repos that get a place of their own and the
 * worktrees that hang under one of them. A worktree hangs only when its
 * source is IN the list; otherwise it is a repo like any other.
 */
function splitWorktrees<T extends RepoRef>(repos: T[]): { standalone: T[]; nested: T[] } {
  const paths = new Set(repos.map((r) => r.path))
  const standalone: T[] = []
  const nested: T[] = []
  for (const repo of repos) {
    const of = repo.worktreeOf
    if (of && of !== repo.path && paths.has(of)) nested.push(repo)
    else standalone.push(repo)
  }
  return { standalone, nested }
}

/**
 * Build the directory tree of `repos` relative to `basePath`.
 * A repo not under basePath (defensive — discovery never returns one) becomes
 * a top-level leaf. Each level sorts alphabetically, directories and repos
 * interleaved, matching Finder; a repo's worktrees follow it, newest first.
 */
export function buildRepoTree(basePath: string, repos: RepoRef[]): RepoTreeNode[] {
  const base = basePath === '/' ? '/' : basePath.replace(/\/+$/, '')
  const prefix = base === '/' ? '/' : base + '/'
  const { standalone, nested } = splitWorktrees(repos)

  const root: RepoTreeDir = { type: 'dir', name: '', path: base, children: [], repoPaths: [] }

  for (const repo of standalone) {
    // The worktrees count toward every folder ABOVE THE SOURCE, not the
    // folder they sit in: a folded folder rolls up what it shows, and it
    // shows the worktree under its source.
    const worktrees = nested
      .filter((w) => w.worktreeOf === repo.path)
      .sort(byNewest)
      .map((w): RepoTreeWorktree => ({ type: 'worktree', name: w.name, path: w.path, of: repo.path }))
    const subtreePaths = [repo.path, ...worktrees.map((w) => w.path)]
    const leaf: RepoTreeLeaf = { type: 'repo', name: repo.name, path: repo.path, worktrees }

    if (!repo.path.startsWith(prefix) || repo.path === base) {
      root.children.push(leaf)
      root.repoPaths.push(...subtreePaths)
      continue
    }
    const segments = repo.path.slice(prefix.length).split('/').filter(Boolean)
    let current = root
    root.repoPaths.push(...subtreePaths)
    // Intermediate segments are directories; the last one is the repo itself.
    for (let i = 0; i < segments.length - 1; i++) {
      const dirPath = current.path === '/' ? '/' + segments[i] : current.path + '/' + segments[i]
      let dir = current.children.find(
        (c): c is RepoTreeDir => c.type === 'dir' && c.path === dirPath
      )
      if (!dir) {
        dir = { type: 'dir', name: segments[i], path: dirPath, children: [], repoPaths: [] }
        current.children.push(dir)
      }
      dir.repoPaths.push(...subtreePaths)
      current = dir
    }
    current.children.push(leaf)
  }

  const compacted = compactRepoTree(root.children)
  sortRepoTree(compacted)
  return compacted
}

/**
 * The flat list's order when the panel has no folder to root a tree on:
 * each repo in the order given, followed by its worktrees, newest first.
 */
export function orderWithWorktrees<T extends RepoRef>(
  repos: T[]
): Array<{ repo: T; worktree: boolean; last: boolean }> {
  const { standalone, nested } = splitWorktrees(repos)
  const rows: Array<{ repo: T; worktree: boolean; last: boolean }> = []
  for (const repo of standalone) {
    rows.push({ repo, worktree: false, last: false })
    const mine = nested.filter((w) => w.worktreeOf === repo.path).sort(byNewest)
    mine.forEach((w, i) => rows.push({ repo: w, worktree: true, last: i === mine.length - 1 }))
  }
  return rows
}

/** Merge single-child directory chains into one node ("labs/products"). */
function compactRepoTree(nodes: RepoTreeNode[]): RepoTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'dir') return node
    let current = node
    while (current.children.length === 1 && current.children[0].type === 'dir') {
      const child = current.children[0] as RepoTreeDir
      current = {
        type: 'dir',
        name: current.name + '/' + child.name,
        path: child.path,
        children: child.children,
        repoPaths: current.repoPaths
      }
    }
    return { ...current, children: compactRepoTree(current.children) }
  })
}

function sortRepoTree(nodes: RepoTreeNode[]): void {
  nodes.sort((a, b) => a.name.localeCompare(b.name))
  for (const node of nodes) {
    if (node.type === 'dir') sortRepoTree(node.children)
  }
}

/**
 * Flatten for rendering. A directory in `collapsedPaths` keeps its row but
 * its subtree is not descended — its badges roll up instead. A repo's
 * worktrees follow it at the repo's own depth (the row indents itself behind
 * its guide), the last one flagged so the guide knows where to stop.
 */
export function flattenRepoTree(
  nodes: RepoTreeNode[],
  collapsedPaths: Set<string>,
  depth = 0
): FlatRepoRow[] {
  const rows: FlatRepoRow[] = []
  for (const node of nodes) {
    const collapsed = node.type === 'dir' && collapsedPaths.has(node.path)
    rows.push({ node, depth, collapsed })
    if (node.type === 'dir' && !collapsed) {
      rows.push(...flattenRepoTree(node.children, collapsedPaths, depth + 1))
    }
    if (node.type === 'repo') {
      node.worktrees.forEach((w, i) =>
        rows.push({ node: w, depth, collapsed: false, last: i === node.worktrees.length - 1 })
      )
    }
  }
  return rows
}

/** Every directory path in the tree — the "collapse all" set. */
export function collectRepoTreeDirPaths(nodes: RepoTreeNode[]): Set<string> {
  const paths = new Set<string>()
  const walk = (ns: RepoTreeNode[]): void => {
    for (const n of ns) {
      if (n.type === 'dir') {
        paths.add(n.path)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return paths
}
