import { describe, expect, it } from 'vitest'
import type { ServerEventEnvelope } from '@clave/contract/events'
import { dualListener, type PushLike, workspaceStatePick } from './dual-listener'
import type { PushStatus } from '@clave/client'

/** A push client the test opens, drops and reopens by hand. */
class FakePush implements PushLike {
  status: PushStatus = 'idle'
  connects = 0
  private events = new Set<(envelope: ServerEventEnvelope) => void>()
  private statuses = new Set<(status: PushStatus) => void>()
  connect(): this {
    this.connects += 1
    if (this.status === 'idle') this.status = 'connecting'
    return this
  }
  onEvent(listener: (envelope: ServerEventEnvelope) => void): () => void {
    this.events.add(listener)
    return () => {
      this.events.delete(listener)
    }
  }
  onStatus(listener: (status: PushStatus) => void): () => void {
    this.statuses.add(listener)
    return () => {
      this.statuses.delete(listener)
    }
  }
  setStatus(status: PushStatus): void {
    this.status = status
    for (const listener of [...this.statuses]) listener(status)
  }
  emit(seq: number, event: ServerEventEnvelope['event']): void {
    for (const listener of [...this.events]) listener({ id: `e${seq}`, seq, at: seq, event })
  }
  listeners(): number {
    return this.events.size + this.statuses.size
  }
}

/** An IPC channel the test sends on by hand, counting its bindings. */
class FakeIpc<T> {
  bound = new Set<(value: T) => void>()
  binds = 0
  bind = (callback: (value: T) => void): (() => void) => {
    this.binds += 1
    this.bound.add(callback)
    return () => {
      this.bound.delete(callback)
    }
  }
  send(value: T): void {
    for (const callback of [...this.bound]) callback(value)
  }
}

const changed = (n: number): ServerEventEnvelope['event'] => ({
  _tag: 'accounts.claude_changed',
  accounts: Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    label: `A${i}`,
    hasToken: false,
    tokenSetAt: null,
    tokenExpiresAt: null,
    tokenInvalid: false
  }))
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function listen(push: FakePush | null): {
  ipc: FakeIpc<number>
  seen: number[]
  off: () => void
} {
  const ipc = new FakeIpc<number>()
  const seen: number[] = []
  const off = dualListener<'accounts.claude_changed', number>({
    bindIpc: ipc.bind,
    backing: async () => push,
    tag: 'accounts.claude_changed',
    pick: (event) => event.accounts.length
  })((value) => seen.push(value))
  return { ipc, seen, off }
}

describe('a listener on both transports hears each event once', () => {
  it('hears IPC at once, and keeps it while there is no server', async () => {
    const { ipc, seen, off } = listen(null)
    ipc.send(1)
    await tick()
    ipc.send(2)
    expect(seen).toEqual([1, 2])
    off()
    ipc.send(3)
    expect(seen).toEqual([1, 2])
    expect(ipc.bound.size).toBe(0)
  })

  it('keeps IPC until the socket is welcomed, then hears the push channel only', async () => {
    const push = new FakePush()
    const { ipc, seen } = listen(push)
    await tick()
    expect(push.connects).toBe(1)
    // Connected but not yet welcomed: main sends on both, the window hears IPC.
    ipc.send(1)
    push.emit(1, changed(1))
    expect(seen).toEqual([1])
    push.setStatus('open')
    // Welcomed: the push frame counts, the IPC send of the same event does not.
    push.emit(2, changed(2))
    ipc.send(2)
    expect(seen).toEqual([1, 2])
    expect(ipc.bound.size).toBe(0)
  })

  it('swaps at once when the socket is already open', async () => {
    const push = new FakePush()
    push.status = 'open'
    const { ipc, seen } = listen(push)
    await tick()
    push.emit(1, changed(3))
    ipc.send(3)
    expect(seen).toEqual([3])
  })

  it('falls back to IPC while the socket is down and leaves it at the next welcome', async () => {
    const push = new FakePush()
    push.status = 'open'
    const { ipc, seen } = listen(push)
    await tick()
    push.setStatus('reconnecting')
    expect(ipc.bound.size).toBe(1)
    ipc.send(4)
    push.setStatus('open')
    push.emit(1, changed(5))
    ipc.send(5)
    expect(seen).toEqual([4, 5])
    expect(ipc.bound.size).toBe(0)
    expect(ipc.binds).toBe(2)
  })

  it('drops what pick refuses, and other tags', async () => {
    const push = new FakePush()
    push.status = 'open'
    const ipc = new FakeIpc<string | null>()
    const seen: Array<string | null> = []
    dualListener<'workspaces.state_changed', string | null>({
      bindIpc: ipc.bind,
      backing: async () => push,
      tag: 'workspaces.state_changed',
      pick: (event) => (event.origin === 'mine' ? undefined : event.origin)
    })((value) => seen.push(value))
    await tick()
    push.emit(1, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'mine' })
    push.emit(2, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'w2' })
    push.emit(3, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: null })
    push.emit(4, changed(1))
    expect(seen).toEqual(['w2', null])
  })

  it('leaves nothing bound after unsubscribe, before or after the swap', async () => {
    const push = new FakePush()
    const early = listen(push)
    early.off()
    await tick()
    expect(early.ipc.bound.size).toBe(0)
    expect(push.listeners()).toBe(0)
    const late = listen(push)
    await tick()
    push.setStatus('open')
    late.off()
    expect(late.ipc.bound.size).toBe(0)
    expect(push.listeners()).toBe(0)
    push.emit(1, changed(1))
    expect(late.seen).toEqual([])
  })

  it('keeps IPC when the push client refuses to connect', async () => {
    const push = new FakePush()
    push.connect = () => {
      throw new Error('This push client was closed')
    }
    const { ipc, seen } = listen(push)
    await tick()
    ipc.send(7)
    expect(seen).toEqual([7])
    expect(ipc.bound.size).toBe(1)
  })
})

describe('the workspace pick drops the window’s own echo and nothing else', () => {
  const change = (origin: string | null): Parameters<ReturnType<typeof workspaceStatePick>>[0] => ({
    _tag: 'workspaces.state_changed',
    workspaces: [],
    pins: [{ p: origin }],
    origin
  })
  it('drops the change this window wrote, keeps every other', () => {
    const pick = workspaceStatePick(() => 'w1')
    expect(pick(change('w1'))).toBeUndefined()
    expect(pick(change('w2'))).toEqual({ workspaces: [], pins: [{ p: 'w2' }] })
    expect(pick(change(null))).toEqual({ workspaces: [], pins: [{ p: null }] })
  })
  it('reads the window’s key at each event, so a key that arrives late still counts', () => {
    let mine: string | null = null
    const pick = workspaceStatePick(() => mine)
    expect(pick(change('w1'))).toBeDefined()
    mine = 'w1'
    expect(pick(change('w1'))).toBeUndefined()
    // A window with no key yet drops nothing, not even a change with no origin.
    mine = null
    expect(pick(change(null))).toBeDefined()
  })
})
