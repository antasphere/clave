/**
 * The one set of expanded folders the side panel's two tabs share.
 *
 * The Files tab and the Git tab draw the same folders and used to remember
 * them separately, so browsing to `labs/products/clave` in Git and switching to
 * Files landed you back at the root with the whole path to walk again. They are
 * one panel with two views; the folders you have open are a property of the
 * panel, not of whichever tab you happened to open them in.
 *
 * Two conversions make that possible, and they are the whole reason this file
 * exists rather than a bare `Set<string>` in the store:
 *
 * 1. **The two tabs speak different path languages.** The Files tree keys on
 *    paths RELATIVE to the panel folder (`labs/products` — `readDir` builds
 *    them that way, file-manager.ts), the Git repo tree on ABSOLUTE ones
 *    (`/Users/u/ws/labs/products` — buildRepoTree, git-repo-tree.ts). The
 *    shared set is relative, because that is the form that survives the panel
 *    being re-rooted onto a different folder: the same relative path means the
 *    same place in the tree, whatever it hangs from.
 *
 * 2. **They store opposite senses.** Files remembers what is EXPANDED, the Git
 *    repo tree what is COLLAPSED (its default was every folder open). Sharing
 *    one set means picking one sense and inverting at the Git edge, which
 *    `collapsedFromExpanded` does against that tree's own directory list.
 *
 * The sense the set carries is EXPANDED, because the two trees list different
 * folders. The Files tree shows every directory on disk; the Git tree shows
 * only those with a repository somewhere underneath. A set of expanded paths
 * mentions folders the other tab may not draw, and that is harmless — it is
 * ignored there and still correct when you come back. A set of COLLAPSED paths
 * could not do that: a folder the Git tree has never heard of is absent from
 * its set, which would read as "expanded" and silently open it.
 *
 * Pure functions over strings — no fs, no path module, no React — so the
 * mapping is unit-tested rather than inferred from the app's behaviour.
 */

/** Compacted rows label several segments at once ("labs/products"), so a path
 *  is opened by opening every folder ON the way to it, not just the last. */
export function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'))
  }
  return out
}

/**
 * An absolute path as the shared set spells it: relative to `basePath`, with no
 * leading or trailing slash.
 *
 * Returns null when the path is not inside the base — a repo discovery can hand
 * back one that is not (the defensive top-level leaf in buildRepoTree), and a
 * sibling folder sharing the base as a STRING prefix (`/Users/u/ws-old` against
 * `/Users/u/ws`) is not inside it either. Both must miss rather than invent a
 * relative path, which is the same boundary case buildRepoTree guards.
 */
export function toRelative(basePath: string | null, absPath: string): string | null {
  if (!basePath) return null
  const base = basePath === '/' ? '/' : basePath.replace(/\/+$/, '')
  const prefix = base === '/' ? '/' : base + '/'
  if (absPath === base) return ''
  if (!absPath.startsWith(prefix)) return null
  return absPath
    .slice(prefix.length)
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/')
}

/** The inverse of `toRelative`, for handing a shared path back to the Git tree. */
export function toAbsolute(basePath: string | null, relPath: string): string | null {
  if (!basePath) return null
  const base = basePath === '/' ? '/' : basePath.replace(/\/+$/, '')
  if (relPath === '') return base
  return base === '/' ? '/' + relPath : base + '/' + relPath
}

/**
 * The Git repo tree's collapsed set, derived from the shared expanded one.
 *
 * `dirPaths` is that tree's own directory list (collectRepoTreeDirPaths), which
 * is what makes the inversion honest: a folder is collapsed when the tree draws
 * it and the shared set does not hold it. Folders the Git tree never lists
 * simply do not appear, and folders the shared set names that this tree does
 * not draw are ignored.
 */
export function collapsedFromExpanded(
  basePath: string | null,
  dirPaths: Set<string>,
  expanded: Set<string>
): Set<string> {
  const collapsed = new Set<string>()
  for (const abs of dirPaths) {
    const rel = toRelative(basePath, abs)
    if (rel === null || rel === '') continue
    if (!expanded.has(rel)) collapsed.add(abs)
  }
  return collapsed
}

/**
 * Fold one Git-tree directory into the shared set, or unfold it.
 *
 * Folding is the exact inverse of expanding, and that is the whole difficulty.
 *
 * The Git tree's rows are COMPACTED chains: `labs/products` is one row when
 * nothing branches in between, and its path is the DEEPEST segment. Expanding
 * it has to open every segment on the way in, or the Files tab — which draws
 * `labs` and `products` as separate rows — cannot show the path at all. So
 * expand writes the ancestors.
 *
 * Fold must therefore take them back. A fold that removed only the leaf and
 * its subtree left `labs` in the set with nothing able to clear it: `labs` is
 * not a Git row of its own, so no click ever names it again. The Git row read
 * shut while the Files tab still drew the path open — precisely the
 * disagreement this module exists to prevent, in the direction it advertises.
 *
 * Clicking one row therefore shuts the whole chain it stands for: the path,
 * everything under it, and the folders above it THAT THE ROW ITSELF COMPACTED.
 * A row that reads as one thing acts as one thing, and expand-then-fold
 * returns the set to where it started.
 *
 * `segments` is where that stops, and it is the whole reason this takes a
 * fourth argument. It is how many folders the clicked row stands for — the
 * segment count of a Git row's compacted label (`deep/one/two` is 3), and 1
 * for a row that is one folder. Folding clears that many segments from the
 * leaf upwards and no more.
 *
 * Clearing EVERY ancestor unconditionally was the bug behind the Files tab's
 * collapse loop: its rows are never compacted, one folder each, opened by
 * their own separate clicks. Closing `folder/sub/sub` cleared `folder/sub` and
 * `folder` along with it and the whole branch folded shut, so a click that
 * should have shut one level shut the path back to the root. The Git tab's own
 * chains are unaffected: they pass their real segment count and still fold
 * whole.
 */
export function withDirToggled(
  expanded: Set<string>,
  relPath: string,
  expand: boolean,
  segments = 1
): Set<string> {
  const next = new Set(expanded)
  if (expand) {
    for (const a of ancestorsOf(relPath)) next.add(a)
    return next
  }
  // The path itself, and the folders above it this row compacted — never the
  // ones the user opened by their own clicks.
  const chain = ancestorsOf(relPath)
  for (const a of chain.slice(Math.max(0, chain.length - segments))) next.delete(a)
  // And everything under it, or reopening the parent would spring the subtree
  // back open beneath a row the user had just folded away.
  const prefix = relPath + '/'
  for (const p of next) {
    if (p.startsWith(prefix)) next.delete(p)
  }
  return next
}
