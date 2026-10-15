/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test fixtures */
// The runner's own end of a launch (tests/performance/backend-bench.mjs,
// `endLaunch`), driven with real child processes: the code every launch
// path runs, not a copy of its rule.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endLaunch } from '../../tests/performance/backend-bench.mjs'
import { isAlive } from './backend-process.mjs'

const children = []
const dirs = []
afterEach(() => {
  // Only what this file started, by exact pid.
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A real child process that stays up until killed. */
function lingering() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}
const exitOf = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once('exit', r))

describe('endLaunch', () => {
  it('refuses a launch that left a process behind, and kills that process', async () => {
    const child = lingering()
    await expect(
      endLaunch({
        name: 'plain-1',
        pids: [child.pid],
        when: 'the close',
        bodyFailed: false,
        waitMs: 300
      })
    ).rejects.toThrow(`plain-1: processes still alive after the close: ${child.pid}`)
    await exitOf(child)
    expect(isAlive(child.pid)).toBe(false)
  })

  it('refuses the startup-profile launch the same way, after its quit', async () => {
    const child = lingering()
    await expect(
      endLaunch({
        name: 'startup-profile',
        pids: [child.pid],
        when: 'the quit',
        bodyFailed: false,
        waitMs: 300
      })
    ).rejects.toThrow(/startup-profile: processes still alive after the quit/)
    await exitOf(child)
  })

  it('passes a launch whose processes are all gone', async () => {
    const child = lingering()
    child.kill('SIGTERM')
    await exitOf(child)
    await expect(
      endLaunch({
        name: 'plain-1',
        pids: [child.pid],
        when: 'the close',
        bodyFailed: false,
        waitMs: 2000
      })
    ).resolves.toEqual({ leftovers: [], stubAgentsKilled: 0 })
  })

  it("keeps a failed launch's own error: leftovers are recorded and killed, not thrown", async () => {
    const child = lingering()
    const out = await endLaunch({
      name: 'plain-1',
      pids: [child.pid],
      when: 'the close',
      bodyFailed: true,
      waitMs: 300
    })
    expect(out.leftovers).toEqual([child.pid])
    await exitOf(child)
    expect(isAlive(child.pid)).toBe(false)
  })

  it('stops the stub agents the launch logged, by their pids', async () => {
    const stub = lingering()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'backend-bench-'))
    dirs.push(dir)
    const starts = path.join(dir, 'agent-starts.jsonl')
    writeFileSync(starts, JSON.stringify({ agent: 'claude', pid: stub.pid, session: 's' }) + '\n')
    const out = await endLaunch({
      name: 'plain-1',
      pids: [],
      starts,
      when: 'the close',
      bodyFailed: false,
      waitMs: 300
    })
    expect(out).toEqual({ leftovers: [], stubAgentsKilled: 1 })
    await exitOf(stub)
    expect(stub.signalCode).toBe('SIGTERM')
  })
})
