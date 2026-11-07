/**
 * The transcript store's dir-name encoding of a cwd: `/` and `.` become `-`.
 * ONE owned copy for the session-history seam (the exos contract mirror
 * carries its own pinned copy, never edited by hand; two older main-process
 * privates predate this file). Drift here silently mis-scopes the History
 * dialog's Everything list, so both sides import THIS.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}
