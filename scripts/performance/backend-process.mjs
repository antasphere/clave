/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and vitest */
// The processes of a benchmark launch (lane B of clave-perf-20261015, issue
// #188): whether they are gone after the close, and the refusal of a run
// that left one behind. Exact pids only: nothing here matches processes by
// name, and nothing here kills one.

import { SampleError } from './backend-stats.mjs'

/** Whether `pid` is a live process: signal 0 asks the kernel without
 *  touching it. EPERM means alive and not ours, which still counts. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Wait up to `ms` for every pid to be gone; answers the ones still alive. */
export async function waitGone(pids, ms, { gapMs = 100 } = {}) {
  const deadline = Date.now() + ms
  for (;;) {
    const left = pids.filter(isAlive)
    if (left.length === 0 || Date.now() >= deadline) return left
    await new Promise((r) => setTimeout(r, gapMs))
  }
}

/** Refuse a launch that left processes behind, whatever cleaned them up
 *  afterwards: a run whose close needed a kill did not close cleanly, and
 *  its figures are not published. `when` says which close it was. */
export function requireAllGone(name, leftovers, when = 'the close') {
  if (!Array.isArray(leftovers)) throw new SampleError(`${name}: no leftover check was recorded`)
  if (leftovers.length > 0)
    throw new SampleError(`${name}: processes still alive after ${when}: ${leftovers.join(', ')}`)
  return true
}
