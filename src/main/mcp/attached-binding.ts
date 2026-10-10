/**
 * Whether main should (re)bind an attached session to a window (wave 4, lane
 * C, PRDCT-3376). Attached, the session lives on the standalone server and
 * main keeps a binding only so the agent-tool routing can find its window.
 * The server is the authority on which window a session is in, so on every
 * authenticated tool call main reconciles its binding to the window the
 * server named: it binds when it holds none, and RE-binds when the server
 * now names a different window (a move re-homed the session). Without the
 * re-bind the first binding sticks and the tools route to the window the tab
 * left (the round-1 verifier's Major F1). Pure, so a test pins the rule.
 */
export function shouldBindAttachedSession(
  currentWindowId: number | null,
  targetWindowId: number | null
): boolean {
  if (targetWindowId === null) return false
  return currentWindowId !== targetWindowId
}
