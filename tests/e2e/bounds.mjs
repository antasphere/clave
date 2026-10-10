// The bounds of the end-to-end run (PRDCT-3375): a spec gets a deadline, an
// app's close gets a timeout, and past either the Electron process is killed
// by its exact pid and the run goes on. Pure, so a unit test drives them with
// promises that never settle; run.mjs and harness.mjs are the callers.
//
// Wave 3 measured why: one quit of 787 s under load and two CI runs stalled
// to the job's ceiling, because the runner awaited `run(t)` with no deadline
// and Playwright's `app.close()` resolves on the child's exit and nothing
// else. Nothing in-process can catch a runner whose own event loop does not
// turn, so every synchronous child call of the harness has a timeout too.

/** The default deadline of one spec, and the environment variable that
 *  overrides it for a run; a spec exports `deadlineMs` to set its own. */
export const SPEC_DEADLINE_MS = 10 * 60 * 1000
export const SPEC_DEADLINE_ENV = 'CLAVE_E2E_SPEC_DEADLINE_MS'

/** The deadline of one spec module: its own `deadlineMs` export when it is a
 *  positive number, else the environment's, else the default. */
export function specDeadlineMs(mod, env = process.env) {
  if (typeof mod?.deadlineMs === 'number' && mod.deadlineMs > 0) return mod.deadlineMs
  const fromEnv = Number(env[SPEC_DEADLINE_ENV])
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return SPEC_DEADLINE_MS
}

/** Race `promise` against `ms`. Answers `{ timedOut: false, value }` or
 *  `{ timedOut: true }`; a rejection before the deadline propagates, one
 *  after it is swallowed (the loser must not become an unhandled rejection). */
export function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  const settled = Promise.resolve(promise).then((value) => ({ timedOut: false, value }))
  return Promise.race([settled, deadline]).then((outcome) => {
    clearTimeout(timer)
    if (outcome.timedOut) settled.catch(() => {})
    return outcome
  })
}

/**
 * Close an app within `timeoutMs`: `close` is the harness's `app.close`, `pid`
 * the Electron main process. Past the timeout the pid is killed (SIGKILL,
 * exact pid, never a pattern), the close is given a moment to notice the exit,
 * and the caller is told. The app's own quit ceiling (src/main/quit-cleanup.ts)
 * is well under this timeout, so a stalled quit names its wait in the app's log
 * before this ever acts.
 */
export async function boundedClose(
  close,
  pid,
  timeoutMs,
  {
    kill = (p) => process.kill(p, 'SIGKILL'),
    log = (line) => console.error(line),
    // How long the close gets to notice the exit after the kill.
    afterKillMs = 5000
  } = {}
) {
  const closing = close()
  const first = await withDeadline(closing, timeoutMs)
  if (!first.timedOut) return { timedOut: false }
  log(`app.close() did not return in ${timeoutMs} ms; killing Electron pid ${pid}`)
  try {
    kill(pid)
  } catch {
    // Already gone.
  }
  const second = await withDeadline(closing, afterKillMs)
  if (second.timedOut) log(`app.close() still pending after the kill of pid ${pid}; moving on`)
  return { timedOut: true }
}
