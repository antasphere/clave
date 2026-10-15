/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test fixtures */
// The runner's own end of a launch (tests/performance/backend-bench.mjs:
// `guardedLaunch`, which every launch path runs, and the `endLaunch` it
// calls), driven with real child processes: the code itself, not a copy of
// its rule.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endLaunch, guardedLaunch } from '../../tests/performance/backend-bench.mjs'
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

describe('guardedLaunch, the path every launch takes', () => {
  it('refuses a launch whose body succeeded but left a process behind', async () => {
    const child = lingering()
    const record = {}
    const order = []
    await expect(
      guardedLaunch({
        name: 'plain-1',
        when: 'the close',
        record,
        waitMs: 300,
        body: async () => {
          order.push('body')
        },
        close: async () => {
          order.push('close')
          return { pids: [child.pid] }
        }
      })
    ).rejects.toThrow(`plain-1: processes still alive after the close: ${child.pid}`)
    expect(order).toEqual(['body', 'close'])
    await exitOf(child)
    expect(isAlive(child.pid)).toBe(false)
  })

  it("keeps a failed body's own error, and still closes and kills what it left", async () => {
    const child = lingering()
    const record = {}
    let closed = false
    await expect(
      guardedLaunch({
        name: 'plain-1',
        when: 'the close',
        record,
        waitMs: 300,
        body: async () => {
          throw new Error('the window did not finish its boot')
        },
        close: async () => {
          closed = true
          return { pids: [child.pid] }
        }
      })
    ).rejects.toThrow('the window did not finish its boot')
    expect(closed).toBe(true)
    expect(record.leftovers).toEqual([child.pid])
    await exitOf(child)
  })

  it('passes a launch that succeeded and closed cleanly, recording it', async () => {
    const child = lingering()
    const record = { name: 'plain-1' }
    const out = await guardedLaunch({
      name: 'plain-1',
      when: 'the close',
      record,
      waitMs: 2000,
      body: async () => {},
      close: async () => {
        child.kill('SIGTERM')
        await exitOf(child)
        return { pids: [child.pid] }
      }
    })
    expect(out).toBe(record)
    expect(record).toEqual({ name: 'plain-1', leftovers: [], stubAgentsKilled: 0 })
  })
})

describe('the launch paths are wired through guardedLaunch', () => {
  // The runner's source as it runs. A launch path that decides its own
  // success, or reaches endLaunch around guardedLaunch, could lose the
  // leftover refusal while every test above stays green (verifier round 2:
  // the callers' own success flag). These pin the wiring itself.
  const source = readFileSync(
    new URL('../../tests/performance/backend-bench.mjs', import.meta.url),
    'utf-8'
  )
  /** The text of a top-level function, from its declaration to the next one. */
  const fn = (name) => {
    const start = source.search(new RegExp(`^(export )?async function ${name}\\(`, 'm'))
    expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0)
    const next = source.slice(start + 1).search(/^(export )?(async )?function /m)
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next)
  }

  it('sends both launch paths through guardedLaunch, each once', () => {
    for (const name of ['oneLaunch', 'startupProfileLaunch']) {
      const body = fn(name)
      expect(body.match(/await guardedLaunch\(/g), name).toHaveLength(1)
      expect(body, name).not.toMatch(/endLaunch\(/)
      expect(body, name).not.toMatch(/bodyFailed|succeeded/)
    }
  })

  it('calls endLaunch from guardedLaunch alone', () => {
    const calls = [...source.matchAll(/await endLaunch\(/g)].map((m) => m.index)
    const guarded = fn('guardedLaunch')
    const at = source.indexOf(guarded)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeGreaterThan(at)
    expect(calls[0]).toBeLessThan(at + guarded.length)
  })
})
