import { useSessionStore } from '../../store/session-store'
import { treeIndentPx } from '../../store/session-types'

/**
 * The file tree's horizontal geometry, taken from the git tab's repo tree so
 * the two read as one list at two depths of the same panel.
 *
 * The file tree used to run tighter — 8px of gutter, 8px per level, icons held
 * apart by their own margins — and beside the git tab it read as a denser,
 * smaller list rather than as the same tree showing different things. The gutter
 * and the step are the git tree's too (GitStatusPanel and GitFileRows read the
 * same step), named once here because the rows and
 * the block rules must agree: a rule inset on one gutter and a row indented on
 * another shows as a tree whose lines miss its names.
 */

/** Gutter before the first level's chevron. */
export const TREE_ROW_PAD_PX = 12

/** Added per level of depth: the user's setting (Settings → Appearance →
 *  Trees → Indent, TREE_INDENTS), 12px at Normal. A hook, so every tree row
 *  and rule moves the moment the setting changes. */
export function useTreeIndentPx(): number {
  return treeIndentPx(useSessionStore((s) => s.treeIndent))
}
