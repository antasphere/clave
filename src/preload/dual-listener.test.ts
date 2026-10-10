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

/** The preload's `onServerAvailable` as the listener sees it: the waits
 *  taken, fired by hand when the server comes, withdrawn by unsubscribe. */
class FakeServer {
  push: PushLike | null = null
  waiting = new Set<(push: PushLike) => void>()
  withdrawn = 0
  onPush = (ready: (push: PushLike) => void): (() => void) => {
    if (this.push) {
      ready(this.push)
      return () => {}
    }
    this.waiting.add(ready)
    return () => {
      if (this.waiting.delete(ready)) this.withdrawn += 1
    }
  }
  announce(push: PushLike): void {
    this.push = push
    for (const ready of [...this.waiting]) ready(push)
    this.waiting.clear()
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

function listen(
  server: FakeServer,
  catchUp?: () => Promise<ReadonlyArray<number>>
): {
  ipc: FakeIpc<number>
  seen: number[]
  off: () => void
} {
  const ipc = new FakeIpc<number>()
  const seen: number[] = []
  const off = dualListener<'accounts.claude_changed', number>({
    bindIpc: ipc.bind,
    onPush: server.onPush,
    tag: 'accounts.claude_changed',
    pick: (event) => event.accounts.length,
    ...(catchUp && { catchUp })
  })((value) => seen.push(value))
  return { ipc, seen, off }
}

/** A server already announced with `push`. */
const serverWith = (push: PushLike | null): FakeServer => {
  const server = new FakeServer()
  server.push = push
  return server
}

describe('a listener on both transports hears each event once', () => {
  it('hears IPC at once, and keeps it while there is no server', async () => {
    const { ipc, seen, off } = listen(serverWith(null))
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
    const { ipc, seen } = listen(serverWith(push))
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
    const { ipc, seen } = listen(serverWith(push))
    push.emit(1, changed(3))
    ipc.send(3)
    expect(seen).toEqual([3])
  })

  it('falls back to IPC while the socket is down and leaves it at the next welcome', async () => {
    const push = new FakePush()
    push.status = 'open'
    const { ipc, seen } = listen(serverWith(push))
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
      onPush: serverWith(push).onPush,
      tag: 'workspaces.state_changed',
      pick: (event) => (event.origin === 'mine' ? undefined : event.origin)
    })((value) => seen.push(value))
    push.emit(1, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'mine' })
    push.emit(2, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'w2' })
    push.emit(3, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: null })
    push.emit(4, changed(1))
    expect(seen).toEqual(['w2', null])
  })

  it('leaves nothing bound after unsubscribe, before or after the swap', async () => {
    const push = new FakePush()
    const early = listen(serverWith(push))
    early.off()
    expect(early.ipc.bound.size).toBe(0)
    expect(push.listeners()).toBe(0)
    const late = listen(serverWith(push))
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
    const { ipc, seen } = listen(serverWith(push))
    ipc.send(7)
    expect(seen).toEqual([7])
    expect(ipc.bound.size).toBe(1)
  })
})

describe('a listener bound before the server is known', () => {
  // Wave 4, lane B (PRDCT-3295): the window binds its listeners at start,
  // main names the server seconds later. A one-shot ask at bind time left
  // every such listener on IPC for the rest of the window's life.
  it('hears IPC meanwhile, then the push channel once the server comes and is welcomed', async () => {
    const server = new FakeServer()
    const { ipc, seen } = listen(server)
    ipc.send(1)
    expect(server.waiting.size).toBe(1)
    const push = new FakePush()
    server.announce(push)
    expect(push.connects).toBe(1)
    // Announced but not welcomed: still IPC.
    ipc.send(2)
    push.emit(1, changed(9))
    expect(seen).toEqual([1, 2])
    push.setStatus('open')
    push.emit(2, changed(3))
    ipc.send(3)
    expect(seen).toEqual([1, 2, 3])
    expect(ipc.bound.size).toBe(0)
  })

  it('withdraws its wait when unsubscribed before the server comes, and binds nothing after', async () => {
    const server = new FakeServer()
    const { ipc, seen, off } = listen(server)
    expect(server.waiting.size).toBe(1)
    off()
    expect(server.waiting.size).toBe(0)
    expect(server.withdrawn).toBe(1)
    expect(ipc.bound.size).toBe(0)
    const push = new FakePush()
    server.announce(push)
    expect(push.connects).toBe(0)
    expect(push.listeners()).toBe(0)
    push.setStatus('open')
    push.emit(1, changed(1))
    expect(seen).toEqual([])
  })
})

describe('the catch-up read at the welcome', () => {
  it('reads the server at the welcome and delivers each value, after the swap', async () => {
    const server = new FakeServer()
    let reads = 0
    const { ipc, seen } = listen(server, async () => {
      reads += 1
      return [40 + reads]
    })
    ipc.send(1)
    const push = new FakePush()
    server.announce(push)
    expect(reads).toBe(0)
    push.setStatus('open')
    expect(reads).toBe(1)
    expect(ipc.bound.size).toBe(0)
    await tick()
    expect(seen).toEqual([1, 41])
    // A later event is an event; the welcome is not read again without a new one.
    push.emit(1, changed(5))
    expect(seen).toEqual([1, 41, 5])
    expect(reads).toBe(1)
  })

  it('reads again at every welcome, so a reconnection catches up too', async () => {
    const push = new FakePush()
    let reads = 0
    const { seen } = listen(serverWith(push), async () => [50 + ++reads])
    push.setStatus('open')
    await tick()
    push.setStatus('reconnecting')
    push.setStatus('open')
    await tick()
    expect(reads).toBe(2)
    expect(seen).toEqual([51, 52])
  })

  it('reads nothing when bound on a socket already open: the caller reads the server itself', async () => {
    const push = new FakePush()
    push.status = 'open'
    let reads = 0
    const { seen } = listen(serverWith(push), async () => [++reads])
    await tick()
    expect(reads).toBe(0)
    expect(seen).toEqual([])
  })

  it('holds an event of the tag that arrives while the read is out, and delivers it after the answer', async () => {
    // One usage read of one account must not cost the other accounts their
    // catch-up (the verifier's P2): the event waits, the answer lands, the
    // event follows, and the window ends on the newest state.
    const push = new FakePush()
    let release: (values: number[]) => void = () => {}
    const { seen } = listen(
      serverWith(push),
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    push.setStatus('open')
    push.emit(1, changed(7))
    push.emit(2, changed(8))
    expect(seen).toEqual([])
    release([6])
    await tick()
    expect(seen).toEqual([6, 7, 8])
    // The read is over: the next event is delivered at once.
    push.emit(3, changed(9))
    expect(seen).toEqual([6, 7, 8, 9])
  })

  it('drops the answer when the window’s own echo arrived while the read was out', async () => {
    // The window wrote after the read went out (the verifier's P1): the
    // answer is older than the window's own state and is dropped; what else
    // was held is delivered.
    const push = new FakePush()
    push.status = 'connecting'
    const ipc = new FakeIpc<string | null>()
    const seen: Array<string | null> = []
    let release: (values: Array<string | null>) => void = () => {}
    dualListener<'workspaces.state_changed', string | null>({
      bindIpc: ipc.bind,
      onPush: serverWith(push).onPush,
      tag: 'workspaces.state_changed',
      pick: (event) => (event.origin === 'mine' ? undefined : event.origin),
      catchUp: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })((value) => seen.push(value))
    push.setStatus('open')
    push.emit(1, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'w2' })
    push.emit(2, { _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'mine' })
    release(['server'])
    await tick()
    expect(seen).toEqual(['w2'])
  })

  it('drops the older answer when a second welcome starts a newer read', async () => {
    // Two welcomes with the first read still out (the verifier's P3): the
    // first answer, whenever it lands, is older than the second's.
    const push = new FakePush()
    const releases: Array<(values: number[]) => void> = []
    const { seen } = listen(
      serverWith(push),
      () =>
        new Promise((resolve) => {
          releases.push(resolve)
        })
    )
    push.setStatus('open')
    push.emit(1, changed(1))
    push.setStatus('reconnecting')
    push.setStatus('open')
    // The first welcome's held event is delivered when the second read starts.
    expect(seen).toEqual([1])
    releases[1]([20])
    await tick()
    releases[0]([10])
    await tick()
    expect(seen).toEqual([1, 20])
  })

  it('delivers what it held when the read fails', async () => {
    const push = new FakePush()
    let fail: (error: Error) => void = () => {}
    const { seen } = listen(
      serverWith(push),
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    push.setStatus('open')
    push.emit(1, changed(3))
    fail(new Error('This server holds no such thing.'))
    await tick()
    expect(seen).toEqual([3])
  })

  it('delivers several values in order, and nothing after unsubscribe', async () => {
    const push = new FakePush()
    let release: (values: number[]) => void = () => {}
    const first = listen(serverWith(push), async () => [1, 2, 3])
    const second = listen(
      serverWith(push),
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    push.setStatus('open')
    await tick()
    expect(first.seen).toEqual([1, 2, 3])
    second.off()
    release([9])
    await tick()
    expect(second.seen).toEqual([])
  })

  it('swallows a read that fails: the next change arrives on the push channel', async () => {
    const push = new FakePush()
    const { seen } = listen(serverWith(push), async () => {
      throw new Error('This server holds no such thing.')
    })
    push.setStatus('open')
    await tick()
    push.emit(1, changed(2))
    expect(seen).toEqual([2])
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
