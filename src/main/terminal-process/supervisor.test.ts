/**
 * The supervisor over fakes: a starter that answers scripted processes and
 * a connect that answers scripted ports, so what is pinned is the
 * supervision itself (PRDCT-3434): the first start awaited and its failure
 * thrown; a process that exits ends its port and is started again, with
 * spawns refused in between and routed to the new port after; the port
 * finding the process gone is the same cue; the deaths counted within the
 * window and the supervisor giving up past the limit, saying why on every
 * spawn; readiness following the current port; the close ending the current
 * process and never starting another. The real process over the wire is
 * `scripts/server-process.test.mjs` (from the built bundle) and the e2e
 * `server-boot` spec in separate mode.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { GrpcTerminals, TerminalProcess } from '@clave/server'
import {
  supervisedTerminals,
  type StartedTerminalProcess,
  type SupervisorState
} from './supervisor'

interface FakeProcess extends StartedTerminalProcess {
  /** End the process as if it died. */
  die(code: number | string): void
  stopped: boolean
}

interface FakeConnection {
  address: string
  onDown: (why: string) => void
  closed: boolean
  spawns: number
  readyAnswer: boolean
  port: GrpcTerminals
}

const makeProcess = (n: number): FakeProcess => {
  let end: (code: number | string | null) => void = () => {}
  const exited = new Promise<number | string | null>((resolve) => {
    end = resolve
  })
  const fake: FakeProcess = {
    address: `127.0.0.1:${1000 + n}`,
    token: `token-${n}`,
    pid: 100 + n,
    exited,
    stopped: false,
    stop: async () => {
      fake.stopped = true
      end('SIGTERM')
    },
    die: (code) => end(code)
  }
  return fake
}

const handle = (): TerminalProcess => ({
  pid: 1,
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => () => undefined,
  onExit: () => () => undefined
})

/** A supervisor over `processes`, started in order; `failing` are the
 *  starts (1-based) that reject instead. */
async function harness(options: {
  processes?: number
  failing?: number[]
  /** The start (1-based) that waits until `release()` is called. */
  gated?: number
  maxRestarts?: number
  windowMs?: number
}): Promise<{
  processes: FakeProcess[]
  connections: FakeConnection[]
  starts: number
  states: SupervisorState[]
  supervisor: Awaited<ReturnType<typeof supervisedTerminals>>
  log: string[]
  release: () => void
}> {
  const processes: FakeProcess[] = []
  const connections: FakeConnection[] = []
  const states: SupervisorState[] = []
  const log: string[] = []
  const rec = { starts: 0 }
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const supervisor = await supervisedTerminals({
    start: async () => {
      rec.starts += 1
      if (options.failing?.includes(rec.starts)) throw new Error(`start ${rec.starts} refused`)
      if (options.gated === rec.starts) await gate
      const p = makeProcess(rec.starts)
      processes.push(p)
      return p
    },
    connect: ({ address, onDown }) => {
      const c: FakeConnection = {
        address,
        onDown,
        closed: false,
        spawns: 0,
        readyAnswer: true,
        port: {
          address,
          spawn: () => {
            c.spawns += 1
            return handle()
          },
          ready: async () => c.readyAnswer,
          down: () => false,
          close: async () => {
            c.closed = true
          }
        }
      }
      connections.push(c)
      return c.port
    },
    log: (line) => log.push(line),
    onChange: (state) => states.push(state),
    ...(options.maxRestarts !== undefined && { maxRestarts: options.maxRestarts }),
    ...(options.windowMs !== undefined && { windowMs: options.windowMs })
  })
  return {
    processes,
    connections,
    get starts() {
      return rec.starts
    },
    states,
    supervisor,
    log,
    release: () => release()
  }
}

const spawnSpec = { file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** A death is delivered to the supervisor on the process's exit promise, a
 *  microtask after `die`: a test that asks `settled()` in the same turn sees
 *  no restart in flight yet. Let it land first. */
const dieAndSettle = async (
  process: FakeProcess,
  supervisor: Awaited<ReturnType<typeof supervisedTerminals>>,
  code: number | string = 1
): Promise<void> => {
  process.die(code)
  await tick()
  await supervisor.settled()
}

describe('the terminal process supervisor', () => {
  it('starts one process, routes spawns and readiness to its port, and says so in its state', async () => {
    const h = await harness({})
    expect(h.starts).toBe(1)
    expect(h.supervisor.state()).toEqual({
      pid: 101,
      address: '127.0.0.1:1001',
      generation: 1,
      givenUp: null
    })
    h.supervisor.spawn(spawnSpec)
    expect(h.connections[0].spawns).toBe(1)
    expect(await h.supervisor.ready()).toBe(true)
    h.connections[0].readyAnswer = false
    expect(await h.supervisor.ready()).toBe(false)
  })

  it('the first start that fails is thrown to the caller, and nothing is retried', async () => {
    await expect(harness({ failing: [1] })).rejects.toThrow(/start 1 refused/)
  })

  it('a process that exits has its port closed and is started again; spawns are refused in between and go to the new port after', async () => {
    // The second start waits until released, so the in-between state can be seen.
    const h = await harness({ gated: 2 })
    h.processes[0].die(137)
    await tick()
    // In between: the old port closed, no current process, a spawn refused with the reason.
    expect(h.connections[0].closed).toBe(true)
    expect(h.supervisor.state().pid).toBeNull()
    expect(() => h.supervisor.spawn(spawnSpec)).toThrow(CapabilityUnavailable)
    expect(() => h.supervisor.spawn(spawnSpec)).toThrow(/being started again/)
    expect(await h.supervisor.ready()).toBe(false)
    h.release()
    await h.supervisor.settled()
    expect(h.starts).toBe(2)
    expect(h.supervisor.state()).toMatchObject({
      pid: 102,
      address: '127.0.0.1:1002',
      generation: 2
    })
    h.supervisor.spawn(spawnSpec)
    expect(h.connections[1].spawns).toBe(1)
    expect(h.connections[0].spawns).toBe(0)
    expect(await h.supervisor.ready()).toBe(true)
    expect(h.log.some((l) => /lost: it exited \(137\)/.test(l))).toBe(true)
    // The state was told twice: the loss, then the new process.
    expect(h.states.map((s) => s.pid)).toEqual([101, null, 102])
  })

  it('the port finding the process gone is the same cue: the process is stopped and another started', async () => {
    const h = await harness({})
    h.connections[0].onDown('UNAVAILABLE')
    await h.supervisor.settled()
    expect(h.processes[0].stopped).toBe(true)
    expect(h.starts).toBe(2)
    expect(h.supervisor.state().generation).toBe(2)
    // The exit the stop caused does not start a third.
    await tick()
    await h.supervisor.settled()
    expect(h.starts).toBe(2)
  })

  it('a start that fails after a death counts as a death and is tried again', async () => {
    const h = await harness({ failing: [2] })
    await dieAndSettle(h.processes[0], h.supervisor)
    expect(h.starts).toBe(3)
    expect(h.supervisor.state()).toMatchObject({ pid: 103, generation: 3, givenUp: null })
  })

  it('gives up past the restart limit within the window, says why on every spawn, and answers not ready', async () => {
    const h = await harness({ maxRestarts: 2, windowMs: 60_000 })
    for (let i = 0; i < 3; i++)
      await dieAndSettle(h.processes[h.processes.length - 1], h.supervisor)
    // Deaths 1 and 2 restarted (starts 2 and 3); death 3 is over the limit.
    expect(h.starts).toBe(3)
    const state = h.supervisor.state()
    expect(state.pid).toBeNull()
    expect(state.givenUp).toMatch(/died 3 times within 60 s/)
    expect(() => h.supervisor.spawn(spawnSpec)).toThrow(/keeps dying and is not started again/)
    expect(await h.supervisor.ready()).toBe(false)
    expect(h.log.some((l) => /not started again/.test(l))).toBe(true)
  })

  it('deaths outside the window are forgotten', async () => {
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const h = await harness({ maxRestarts: 1, windowMs: 1_000 })
      await dieAndSettle(h.processes[0], h.supervisor)
      expect(h.starts).toBe(2)
      now += 2_000
      await dieAndSettle(h.processes[1], h.supervisor)
      expect(h.starts).toBe(3)
      expect(h.supervisor.state().givenUp).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('the close ends the current process and its port, and a death afterwards starts nothing', async () => {
    const h = await harness({})
    await h.supervisor.close()
    expect(h.connections[0].closed).toBe(true)
    expect(h.processes[0].stopped).toBe(true)
    expect(() => h.supervisor.spawn(spawnSpec)).toThrow(/stopping/)
    await tick()
    await h.supervisor.settled()
    expect(h.starts).toBe(1)
  })

  it('a newcomer that dies at once hands the restart over: settled waits for the next start, and the state names it', async () => {
    // Process 1 dies, process 2 starts and dies at once, process 3 is gated:
    // the handle of the first restart must not be wiped by its own end
    // while the second is in flight (the round-1 verifier's finding).
    const h = await harness({ gated: 3 })
    await dieAndSettle(h.processes[0], h.supervisor)
    expect(h.supervisor.state().pid).toBe(102)
    h.processes[1].die(1)
    await tick()
    expect(h.starts).toBe(3)
    const settled = h.supervisor.settled().then(() => 'settled')
    const first = await Promise.race([settled, tick().then(() => 'pending')])
    expect(first).toBe('pending')
    expect(h.supervisor.state().pid).toBeNull()
    h.release()
    expect(await settled).toBe('settled')
    expect(h.supervisor.state()).toMatchObject({ pid: 103, generation: 3, givenUp: null })
    expect(await h.supervisor.ready()).toBe(true)
  })

  it('a close while a handed-over restart is in flight waits for it and stops the newcomer', async () => {
    const h = await harness({ gated: 3 })
    await dieAndSettle(h.processes[0], h.supervisor)
    h.processes[1].die(1)
    await tick()
    const closing = h.supervisor.close()
    h.release()
    await closing
    expect(h.starts).toBe(3)
    expect(h.processes[2].stopped).toBe(true)
    expect(h.supervisor.state().pid).toBeNull()
    expect(() => h.supervisor.spawn(spawnSpec)).toThrow(/stopping/)
  })

  it('a close during a restart waits for it and stops the newcomer', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const started: FakeProcess[] = []
    const supervisor = await supervisedTerminals({
      start: async () => {
        const p = makeProcess(started.length + 1)
        started.push(p)
        if (started.length === 2) await gate
        return p
      },
      connect: ({ address }) => ({
        address,
        spawn: () => handle(),
        ready: async () => true,
        down: () => false,
        close: async () => {}
      })
    })
    started[0].die(1)
    await tick()
    const closing = supervisor.close()
    release()
    await closing
    expect(started).toHaveLength(2)
    expect(started[1].stopped).toBe(true)
    expect(supervisor.state().pid).toBeNull()
  })
})
