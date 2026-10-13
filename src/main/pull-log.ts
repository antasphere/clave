/**
 * The log lines for the repos Pull all could not pull (PRDCT-3372). The bar
 * names them only until it is dismissed; the app's log keeps them. Kept free
 * of Electron so the lines are tested here, and the handler passes its logger.
 */
export function logPullFailures(
  results: Array<{ repoPath: string; error: string | null }>,
  warn: (line: string) => void
): void {
  for (const r of results) {
    if (r.error) warn(`[git] Pull all could not pull ${r.repoPath}: ${r.error}`)
  }
}
