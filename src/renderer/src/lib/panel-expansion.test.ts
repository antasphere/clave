/**
 * The shared expansion set behind the side panel's two tabs: the relative /
 * absolute conversion between the Files tree's path language and the Git repo
 * tree's, the expanded → collapsed inversion at the Git edge, and the subtree
 * rule when a compacted folder folds.
 */

import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  toRelative,
  toAbsolute,
  collapsedFromExpanded,
  withDirToggled
} from './panel-expansion'

const WS = '/Users/u/ws'

describe('ancestorsOf', () => {
  it('names every folder on the way to a path, not just the last', () => {
    expect(ancestorsOf('labs/products/clave')).toEqual([
      'labs',
      'labs/products',
      'labs/products/clave'
    ])
  })

  it('a single segment is its own only ancestor', () => {
    expect(ancestorsOf('labs')).toEqual(['labs'])
  })

  it('the root is nobody', () => {
    expect(ancestorsOf('')).toEqual([])
  })
})

describe('toRelative', () => {
  it('strips the base', () => {
    expect(toRelative(WS, `${WS}/labs/products`)).toBe('labs/products')
  })

  it('the base itself is the empty path', () => {
    expect(toRelative(WS, WS)).toBe('')
  })

  it('a sibling sharing the base as a string prefix is NOT inside it', () => {
    // The same boundary buildRepoTree guards: /Users/u/ws-old is a sibling on
    // disk, and must miss rather than become an invented "-old" folder.
    expect(toRelative(WS, `${WS}-old/labs`)).toBeNull()
  })

  it('a path outside the base misses', () => {
    expect(toRelative(WS, '/elsewhere/stray')).toBeNull()
  })

  it('tolerates a trailing slash on the base and on the path', () => {
    expect(toRelative(`${WS}/`, `${WS}/labs/`)).toBe('labs')
  })

  it('tolerates a "/" base', () => {
    expect(toRelative('/', '/labs/products')).toBe('labs/products')
  })

  it('collapses doubled separators', () => {
    expect(toRelative(WS, `${WS}/labs//products`)).toBe('labs/products')
  })

  it('no base means no mapping', () => {
    expect(toRelative(null, `${WS}/labs`)).toBeNull()
  })
})

describe('toAbsolute', () => {
  it('round-trips with toRelative', () => {
    const abs = `${WS}/labs/products/clave`
    expect(toAbsolute(WS, toRelative(WS, abs)!)).toBe(abs)
  })

  it('the empty path is the base', () => {
    expect(toAbsolute(WS, '')).toBe(WS)
  })

  it('a "/" base does not double its slash', () => {
    expect(toAbsolute('/', 'labs')).toBe('/labs')
  })

  it('no base means no mapping', () => {
    expect(toAbsolute(null, 'labs')).toBeNull()
  })
})

describe('collapsedFromExpanded', () => {
  const dirs = new Set([`${WS}/labs`, `${WS}/labs/products`, `${WS}/company`])

  it('a folder the shared set does not hold is collapsed', () => {
    expect(collapsedFromExpanded(WS, dirs, new Set())).toEqual(dirs)
  })

  it('a folder the shared set holds is open', () => {
    const collapsed = collapsedFromExpanded(WS, dirs, new Set(['labs']))
    expect(collapsed).toEqual(new Set([`${WS}/labs/products`, `${WS}/company`]))
  })

  it('ignores shared paths this tree never draws', () => {
    // The Files tree lists every directory; the Git tree only those with a
    // repo underneath. A folder named in the set but absent from the tree must
    // not conjure a row.
    const collapsed = collapsedFromExpanded(WS, dirs, new Set(['labs', 'private/notes']))
    expect(collapsed).toEqual(new Set([`${WS}/labs/products`, `${WS}/company`]))
  })

  it('a tree directory outside the base is left alone', () => {
    const withStray = new Set([...dirs, '/elsewhere/stray'])
    const collapsed = collapsedFromExpanded(WS, withStray, new Set())
    expect(collapsed.has('/elsewhere/stray')).toBe(false)
  })

  it('everything collapses when there is no base to map against', () => {
    expect(collapsedFromExpanded(null, dirs, new Set(['labs']))).toEqual(new Set())
  })
})

describe('withDirToggled', () => {
  it('expanding opens every folder on the way in', () => {
    // A compacted Git row labels several segments at once, so opening
    // "labs/products" must leave the Files tree able to draw "labs" too.
    expect(withDirToggled(new Set(), 'labs/products', true)).toEqual(
      new Set(['labs', 'labs/products'])
    )
  })

  it('collapsing takes the subtree with it', () => {
    const start = new Set(['labs', 'labs/products', 'labs/products/clave', 'company'])
    expect(withDirToggled(start, 'labs', false)).toEqual(new Set(['company']))
  })

  it('folding a compacted row is the exact inverse of expanding it', () => {
    // The case the whole module turns on, and the one the original tests could
    // not reach: every path they folded was a single segment, where the leaf
    // and its ancestors are the same thing.
    //
    // A Git row labelled "labs/products" is ONE row standing for two folders.
    // Expanding it opens both, or the Files tab cannot draw the path at all.
    // Folding it therefore has to close both — a fold that took only the leaf
    // left "labs" in the set with nothing able to clear it (no Git row is ever
    // named "labs"), so the Git row read shut while the Files tab still drew
    // the path open.
    const open = withDirToggled(new Set<string>(), 'labs/products', true)
    expect(open).toEqual(new Set(['labs', 'labs/products']))
    // The row says how many folders it stands for; "labs/products" is two.
    expect(withDirToggled(open, 'labs/products', false, 2)).toEqual(new Set<string>())
  })

  it('folding a deep compacted chain clears every segment of it', () => {
    const open = withDirToggled(new Set<string>(), 'deep/one/two', true)
    expect(open).toEqual(new Set(['deep', 'deep/one', 'deep/one/two']))
    expect(withDirToggled(open, 'deep/one/two', false, 3)).toEqual(new Set<string>())
  })

  it('folding a chain leaves an unrelated branch alone', () => {
    // Folding must clear the chain it was clicked on and nothing else — a
    // sibling under a shared ancestor keeps whatever the user did to it.
    const start = new Set(['labs', 'labs/products', 'company', 'company/brand'])
    expect(withDirToggled(start, 'labs/products', false, 2)).toEqual(
      new Set(['company', 'company/brand'])
    )
  })

  it('the Files tab keeps the parents it opened by their own clicks', () => {
    // The collapse loop, reported on 15 September 2026: "I open folder >
    // subfolder > subfolder and then I close the last subfolder, it closes the
    // folder. So the entire loop."
    //
    // The Files tree draws every folder as its OWN row, so the three below were
    // opened by three separate clicks. Folding the deepest is a statement about
    // that folder alone; the parents stay as the user left them. Fold used to
    // clear every ancestor unconditionally — correct for a compacted Git row,
    // and the whole branch snapping shut here.
    let open = new Set<string>()
    open = withDirToggled(open, 'folder', true)
    open = withDirToggled(open, 'folder/sub', true)
    open = withDirToggled(open, 'folder/sub/deep', true)
    expect(open).toEqual(new Set(['folder', 'folder/sub', 'folder/sub/deep']))

    expect(withDirToggled(open, 'folder/sub/deep', false)).toEqual(
      new Set(['folder', 'folder/sub'])
    )
    // And one level up behaves the same way: shut the middle, keep the root.
    expect(withDirToggled(open, 'folder/sub', false)).toEqual(new Set(['folder']))
  })

  it('a compacted row folds its chain because it says how long the chain is', () => {
    // The Git tab's side of the same argument. Its row is labelled
    // "deep/one/two" and stands for three folders, so it passes 3 and all
    // three go — the pass-through ancestors no row there will ever name again.
    const open = withDirToggled(new Set<string>(), 'deep/one/two', true)
    expect(open).toEqual(new Set(['deep', 'deep/one', 'deep/one/two']))
    expect(withDirToggled(open, 'deep/one/two', false, 3)).toEqual(new Set<string>())

    // A two-segment row under a folder the user opened separately clears only
    // its own two, which is the mixed case the loop got wrong in both tabs.
    const mixed = new Set(['top', 'top/mid', 'top/mid/leaf'])
    expect(withDirToggled(mixed, 'top/mid/leaf', false, 2)).toEqual(new Set(['top']))
  })

  it('expanding writes every ancestor, not just the path', () => {
    // Guards the ancestor walk itself. Deleting it leaves the Files tab unable
    // to draw a compacted path, and an E2E fixture whose folders all branch
    // will not notice — the row and its ancestor coincide there.
    expect(withDirToggled(new Set<string>(), 'a/b/c', true)).toEqual(
      new Set(['a', 'a/b', 'a/b/c'])
    )
  })

  it('collapsing leaves a sibling sharing the name as a prefix alone', () => {
    const start = new Set(['labs', 'labs-old', 'labs-old/x'])
    expect(withDirToggled(start, 'labs', false)).toEqual(new Set(['labs-old', 'labs-old/x']))
  })

  it('does not mutate the set it is given', () => {
    const start = new Set(['labs'])
    withDirToggled(start, 'labs', false)
    expect(start).toEqual(new Set(['labs']))
  })
})
