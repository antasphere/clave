/**
 * The four ranges a repo row can unfold into a file list (PRDCT-1539,
 * PRDCT-2356). The first two are against the branch's remote counterpart, the
 * last two against the branch a worktree was cut from:
 *
 * - `incoming`  what a pull will bring        HEAD...<tracking>
 * - `outgoing`  what a push will send         <tracking>...HEAD
 * - `worktree`  what the worktree added       <base>...HEAD
 * - `base`      what the base gained since    HEAD...<base>
 *
 * Shared by main (the diff), preload (the bridge) and the renderer (the
 * section) so a new direction is one edit, not three that drift.
 */
export type GitRangeDirection = 'incoming' | 'outgoing' | 'worktree' | 'base'
