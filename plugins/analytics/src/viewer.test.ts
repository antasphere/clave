import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  NOTES,
  VIEWER_NOTE,
  Viewer,
  devArgs,
  parseDevLine,
  type ChildLike,
  type ProcessLike,
  type SpawnLike
} from './viewer'

/**
 * The viewer manager on a fake `spawn`: the argument list and the environment it gives the
 * CLI, the port it reads from the CLI's JSON line and keeps, a binary not found, a start that
 * fails, a saved port taken, an exit after the start and the restart that follows, and stop.
 */

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed: NodeJS.Signals[] = []
  constructor(
    readonly args: string[],
    readonly env: Record<string, string>
  ) {
    super()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    // A real child exits after a TERM; this one does, on the next tick.
    setTimeout(() => this.emit('exit', null, signal), 0)
    return true
  }
  /** The CLI's JSON line: the viewer is up on `port`. */
  up(port: number): void {
    this.stdout.emit(
      'data',
      Buffer.from(`{"url":"http://127.0.0.1:${port}/","entry":"index.html"}\n`)
    )
  }
}

/** The plugin process as the viewer sees it: its exit and its signals, and what it re-raises. */
class FakeProcess extends EventEmitter implements ProcessLike {
  readonly pid = 4242
  readonly raised: NodeJS.Signals[] = []
  kill(pid: number, signal: NodeJS.Signals): boolean {
    expect(pid).toBe(this.pid)
    this.raised.push(signal)
    return true
  }
}

function harness(): {
  spawn: SpawnLike
  children: FakeChild[]
  logs: string[]
  ports: number[]
  forgotten: number
  proc: FakeProcess
  make: (savedPort: number | null) => Viewer
} {
  const children: FakeChild[] = []
  const logs: string[] = []
  const ports: number[] = []
  const proc = new FakeProcess()
  const state = { forgotten: 0 }
  const spawn: SpawnLike = (file, args, options) => {
    expect(file).toBe('slideless')
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    const child = new FakeChild(args, options.env)
    children.push(child)
    return child
  }
  return {
    spawn,
    children,
    logs,
    ports,
    get forgotten(): number {
      return state.forgotten
    },
    proc,
    make: (savedPort) =>
      new Viewer({
        root: '/data/decks',
        proc,
        savedPort,
        onPort: (port) => ports.push(port),
        env: async () => ({ PATH: '/login/bin:/own/bin', HOME: '/Users/x' }),
        spawn,
        forget: () => state.forgotten++,
        log: (level, message) => logs.push(`${level}: ${message}`),
        backoffMs: [5, 10],
        startTimeoutMs: 200
      })
  }
}

const tick = (ms = 1): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("the viewer's arguments", () => {
  it('spawns the CLI as an argument list: dev, the root, the port, no browser, JSON out', () => {
    expect(devArgs('/Users/x/My data/decks', 4173)).toEqual([
      'dev',
      '/Users/x/My data/decks',
      '--port',
      '4173',
      '--no-open',
      '--json'
    ])
  })

  it("reads the port out of the CLI's JSON line and nothing else", () => {
    expect(parseDevLine('{"url":"http://127.0.0.1:54164/","entry":"index.html"}')).toEqual({
      url: 'http://127.0.0.1:54164',
      port: 54164
    })
    expect(parseDevLine('Serving /x at http://127.0.0.1:4173/')).toBeNull()
    expect(parseDevLine('{"url":"nope"}')).toBeNull()
    expect(parseDevLine('{"url":"http://127.0.0.1/"}')).toBeNull()
    expect(parseDevLine('[]')).toBeNull()
    expect(parseDevLine('')).toBeNull()
  })
})

describe('Viewer', () => {
  it('starts the CLI on the saved port with the login environment, and is up on the port it answers', async () => {
    const h = harness()
    const viewer = h.make(4173)
    expect(viewer.state).toEqual({ kind: 'stopped' })
    const started = viewer.start()
    await tick()
    expect(viewer.state).toEqual({ kind: 'starting' })
    expect(viewer.note()).toBe(NOTES.starting)
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.args).toEqual(devArgs('/data/decks', 4173))
    expect(h.children[0]!.env).toEqual({ PATH: '/login/bin:/own/bin', HOME: '/Users/x' })
    h.children[0]!.up(4173)
    expect(await started).toEqual({ kind: 'up', url: 'http://127.0.0.1:4173', port: 4173 })
    expect(viewer.url()).toBe('http://127.0.0.1:4173')
    // The port was the saved one: nothing to save.
    expect(h.ports).toEqual([])
    expect(h.logs).toEqual(['info: The Slideless viewer serves the decks at http://127.0.0.1:4173'])
    // The same start is answered to a second caller; ready() too.
    expect(await viewer.start()).toEqual(viewer.state)
    expect(await viewer.ready(50)).toEqual(viewer.state)
    await viewer.stop()
    expect(h.children[0]!.killed).toEqual(['SIGTERM'])
    expect(viewer.state).toEqual({ kind: 'stopped' })
    expect(viewer.url()).toBeNull()
    expect(viewer.note()).toBe(NOTES.stopped)
  })

  it("says on the plugin's own page that the viewer is up, when it is", async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5006)
    await started
    expect(viewer.note()).toBe(NOTES.up)
    await viewer.stop()
  })

  it('asks for any port when none was saved, and keeps the one the CLI took', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    expect(h.children[0]!.args).toEqual(devArgs('/data/decks', 0))
    h.children[0]!.up(54321)
    expect(await started).toMatchObject({ kind: 'up', port: 54321 })
    expect(h.ports).toEqual([54321])
    await viewer.stop()
  })

  it('leaves no viewer when the binary is not found, and forgets the login environment', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.emit(
      'error',
      Object.assign(new Error('spawn slideless ENOENT'), { code: 'ENOENT' })
    )
    expect(await started).toEqual({ kind: 'missing' })
    expect(viewer.url()).toBeNull()
    expect(viewer.note()).toBe(NOTES.missing)
    expect(h.forgotten).toBe(1)
    expect(h.children).toHaveLength(1)
    expect(h.logs).toEqual([`warn: ${NOTES.missing}`])
    await viewer.stop()
  })

  it("says why a start failed, from the CLI's first line", async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.stderr.emit('data', Buffer.from('\nError: No HTML entry found\n  at x\n'))
    h.children[0]!.emit('exit', 1, null)
    expect(await started).toEqual({ kind: 'failed', reason: 'Error: No HTML entry found' })
    expect(viewer.note()).toBe(NOTES.failed('Error: No HTML entry found'))
    expect(h.forgotten).toBe(0)
    const silent = h.make(null)
    const again = silent.start()
    await tick()
    h.children[1]!.emit('exit', 2, null)
    expect(await again).toEqual({ kind: 'failed', reason: 'it exited with code 2' })
    await viewer.stop()
    await silent.stop()
  })

  it('tries any port once when the saved one cannot be taken', async () => {
    const h = harness()
    const viewer = h.make(4173)
    const started = viewer.start()
    await tick()
    h.children[0]!.stderr.emit(
      'data',
      Buffer.from('Error: listen EADDRINUSE: address already in use\n')
    )
    h.children[0]!.emit('exit', 1, null)
    await tick()
    expect(h.children).toHaveLength(2)
    expect(h.children[1]!.args).toEqual(devArgs('/data/decks', 0))
    h.children[1]!.up(4180)
    expect(await started).toMatchObject({ kind: 'up', port: 4180 })
    expect(h.ports).toEqual([4180])
    expect(h.logs[0]).toContain('could not take port 4173')
    await viewer.stop()
  })

  it('gives up a start that never answers', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    expect(await started).toEqual({ kind: 'failed', reason: 'it did not answer within 20 seconds' })
    expect(h.children[0]!.killed).toEqual(['SIGKILL'])
    await viewer.stop()
  })

  it('starts the CLI again after it exits, with a backoff, and stops the restarts on stop', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5000)
    await started
    h.children[0]!.emit('exit', 1, null)
    expect(viewer.state).toEqual({ kind: 'starting' })
    expect(viewer.url()).toBeNull()
    expect(h.logs.at(-1)).toBe(
      'warn: The Slideless viewer exited (code 1); starting it again in 10 ms'
    )
    await tick(20)
    expect(h.children).toHaveLength(2)
    expect(h.children[1]!.args).toEqual(devArgs('/data/decks', 5000))
    h.children[1]!.up(5000)
    expect(await viewer.ready(50)).toMatchObject({ kind: 'up', port: 5000 })
    h.children[1]!.emit('exit', null, 'SIGKILL')
    expect(h.logs.at(-1)).toBe(
      'warn: The Slideless viewer exited (SIGKILL); starting it again in 10 ms'
    )
    await viewer.stop()
    await tick(20)
    expect(h.children).toHaveLength(2)
    expect(viewer.state).toEqual({ kind: 'stopped' })
  })

  it('never answers a dead viewer as up: ready() during the backoff waits for the restart', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5004)
    await started
    h.children[0]!.emit('exit', 1, null)
    expect(viewer.state).toEqual({ kind: 'starting' })
    // Within the backoff: the state so far after a short wait, never the old `up`.
    expect(await viewer.ready(2)).toEqual({ kind: 'starting' })
    // A longer wait reaches the restart's outcome.
    const waited = viewer.ready(200)
    await tick(15)
    expect(h.children).toHaveLength(2)
    h.children[1]!.up(5004)
    expect(await waited).toMatchObject({ kind: 'up', port: 5004 })
    await viewer.stop()
  })

  it('answers a wait as soon as the restart is up, and settles it on stop', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5007)
    await started
    h.children[0]!.emit('exit', 1, null)
    // A long wait begun during the backoff resolves when the restart is up, not at its end.
    const began = Date.now()
    const waited = viewer.ready(2_000)
    await tick(15)
    h.children[1]!.up(5007)
    expect(await waited).toMatchObject({ kind: 'up', port: 5007 })
    expect(Date.now() - began).toBeLessThan(500)
    // A stop during a backoff settles the wait and makes the next start a fresh attempt.
    h.children[1]!.emit('exit', 1, null)
    const pending = viewer.ready(2_000)
    const stopped = viewer.stop()
    expect(await pending).toEqual({ kind: 'stopped' })
    await stopped
    expect(h.children).toHaveLength(2)
    const again = viewer.start()
    await tick()
    expect(h.children).toHaveLength(3)
    h.children[2]!.up(5008)
    expect(await again).toMatchObject({ kind: 'up', port: 5008 })
    await viewer.stop()
  })

  it('starts the backoff over after a run that stayed up for a minute', async () => {
    const h = harness()
    let clock = 0
    const viewer = new Viewer({
      root: '/data/decks',
      proc: h.proc,
      savedPort: null,
      env: async () => ({}),
      spawn: h.spawn,
      log: (level, message) => h.logs.push(`${level}: ${message}`),
      backoffMs: [5, 10, 20],
      startTimeoutMs: 200,
      now: () => clock
    })
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5005)
    await started
    // Two quick crashes: the wait grows.
    h.children[0]!.emit('exit', 1, null)
    expect(h.logs.at(-1)).toContain('in 10 ms')
    await tick(20)
    h.children[1]!.up(5005)
    await viewer.ready(50)
    h.children[1]!.emit('exit', 1, null)
    expect(h.logs.at(-1)).toContain('in 20 ms')
    await tick(30)
    h.children[2]!.up(5005)
    await viewer.ready(50)
    // A minute up: the next crash waits the shortest time again.
    clock += 60_000
    h.children[2]!.emit('exit', 1, null)
    expect(h.logs.at(-1)).toContain('in 5 ms')
    await viewer.stop()
  })

  it('answers ready() with the state so far when the start takes longer than the wait', async () => {
    const h = harness()
    const viewer = h.make(null)
    void viewer.start()
    expect(await viewer.ready(5)).toEqual({ kind: 'starting' })
    h.children[0]!.up(5001)
    expect(await viewer.ready(50)).toMatchObject({ kind: 'up', port: 5001 })
    await viewer.stop()
  })

  it('takes the child down when the plugin process exits or is signalled, and not after stop', async () => {
    const h = harness()
    const viewer = h.make(null)
    const started = viewer.start()
    await tick()
    h.children[0]!.up(5002)
    await started
    expect(h.proc.listenerCount('exit')).toBe(1)
    expect(h.proc.listenerCount('SIGTERM')).toBe(1)
    // A TERM from the host: the child is told first, then the signal is raised again on the
    // process, now without a handler.
    h.proc.emit('SIGTERM')
    expect(h.children[0]!.killed).toEqual(['SIGTERM'])
    expect(h.proc.raised).toEqual(['SIGTERM'])
    expect(h.proc.listenerCount('exit')).toBe(0)
    expect(h.proc.listenerCount('SIGHUP')).toBe(0)
    await tick()
    // The child's exit after that TERM is not a crash: the viewer was stopped by the guard?
    // No: the guard only kills; a restart would follow. Stop first, as deactivate does.
    const again = h.make(null)
    const second = again.start()
    await tick()
    h.children[h.children.length - 1]!.up(5003)
    await second
    await again.stop()
    expect(h.proc.listenerCount('exit')).toBe(0)
    expect(h.proc.listenerCount('SIGTERM')).toBe(0)
    h.proc.emit('exit')
    expect(h.proc.raised).toEqual(['SIGTERM'])
    await viewer.stop()
  })

  it('names the footer lines', () => {
    expect(VIEWER_NOTE).toBe('Served by the Slideless viewer on this Mac')
    expect(NOTES.missing).toBe(
      "The Slideless CLI is not on the login shell's path: run team tools install slideless to see this page through its viewer"
    )
  })
})
