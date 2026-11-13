/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test fixtures */
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { SampleError } from './backend-stats.mjs'
import { isAlive, requireAllGone, waitGone } from './backend-process.mjs'

const children = []
afterEach(() => {
  // Only the children this file started, by their exact pid.
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
})

/** A real child process that stays up until killed. */
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

describe('requireAllGone', () => {
  it('passes a launch that left nothing behind', () => {
    expect(requireAllGone('plain-1', [])).toBe(true)
  })

  it('refuses a launch that left a process, naming it', () => {
    expect(() => requireAllGone('plain-1', [4242])).toThrow(SampleError)
    expect(() => requireAllGone('plain-1', [4242, 4343])).toThrow(
      /plain-1: processes still alive after the close: 4242, 4343/
    )
    expect(() => requireAllGone('startup-profile', [7], 'the quit')).toThrow(/after the quit/)
  })

  it('refuses a launch whose leftover check never ran', () => {
    expect(() => requireAllGone('plain-1', undefined)).toThrow(/no leftover check/)
  })
})

describe('a real process left behind', () => {
  it('is found by waitGone and refuses the run', async () => {
    const child = sleeper()
    expect(isAlive(child.pid)).toBe(true)
    const left = await waitGone([child.pid], 300)
    expect(left).toEqual([child.pid])
    expect(() => requireAllGone('plain-1', left)).toThrow(SampleError)
  })

  it('is gone once it exits, and the run passes', async () => {
    const child = sleeper()
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    await exited
    const left = await waitGone([child.pid], 2000)
    expect(left).toEqual([])
    expect(requireAllGone('plain-1', left)).toBe(true)
    expect(isAlive(child.pid)).toBe(false)
  })
})
