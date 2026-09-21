import { describe, expect, it, vi, type Mock } from 'vitest'
import { AgentStateSchema, type Session } from '../../../shared/session-model'
import { bindKernelState, type KernelStateBridge, type KernelStateSink } from './kernel-state'

const record = (state: Session['state']): Session => ({
  id: 'session-1',
  title: 'Fixture',
  cwd: '/tmp',
  transport: 'events',
  windowKey: 'main',
  adapterId: 'echo',
  provider: 'echo',
  state,
  createdAt: 1
})

interface Harness {
  calls: { setState: [string, string][]; setAlive: [string, boolean][] }
  stop: Mock
  bridge: KernelStateBridge
  sink: KernelStateSink
  /** Deliver a kernel state on the live channel; false when nothing listens. */
  emit: (state: string) => boolean
}

/** A bridge whose channel and list response are driven by the test. */
function harness(options: { list?: Session[]; listDelay?: Promise<void> } = {}): Harness {
  const calls: { setState: [string, string][]; setAlive: [string, boolean][] } = {
    setState: [],
    setAlive: []
  }
  let listener: ((state: string) => void) | null = null
  const stop = vi.fn(() => {
    listener = null
  })
  const bridge: KernelStateBridge = {
    onAgentState: (_id, callback) => {
      listener = callback
      return stop
    },
    sessionsList: async () => {
      if (options.listDelay) await options.listDelay
      return options.list ?? []
    }
  }
  const sink: KernelStateSink = {
    isAlive: () => true,
    setAlive: (id, alive) => calls.setAlive.push([id, alive]),
    setState: (id, state) => calls.setState.push([id, state])
  }
  return {
    calls,
    stop,
    bridge,
    sink,
    emit(state: string): boolean {
      if (!listener) return false
      listener(state)
      return true
    }
  }
}

describe('the kernel-state binding', () => {
  it('hydrates the sidebar from the session record when no live state has arrived', async () => {
    const h = harness({ list: [record('blocked')] })
    const dispose = bindKernelState('session-1', h.bridge, h.sink)
    await vi.waitFor(() => expect(h.calls.setState).toEqual([['session-1', 'blocked']]))
    dispose()
  })

  it('never lets the record overwrite a state the live channel already delivered', async () => {
    let release = (): void => {}
    const listDelay = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({ list: [record('blocked')], listDelay })
    const dispose = bindKernelState('session-1', h.bridge, h.sink)
    expect(h.emit('working')).toBe(true)
    release()
    await listDelay
    await Promise.resolve()
    expect(h.calls.setState).toEqual([['session-1', 'working']])
    dispose()
  })

  it('stops listening on dispose, so no later kernel state reaches the store', async () => {
    const h = harness({ list: [] })
    const dispose = bindKernelState('session-1', h.bridge, h.sink)
    expect(h.emit('working')).toBe(true)
    dispose()
    expect(h.stop).toHaveBeenCalledTimes(1)
    // The disposer must have released the channel: nothing can be delivered,
    // and the store holds only what arrived while the binding was live.
    expect(h.emit('blocked')).toBe(false)
    expect(h.calls.setState).toEqual([['session-1', 'working']])
  })

  it('never hydrates from a record that arrives after dispose', async () => {
    let release = (): void => {}
    const listDelay = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({ list: [record('blocked')], listDelay })
    bindKernelState('session-1', h.bridge, h.sink)()
    release()
    await listDelay
    await Promise.resolve()
    expect(h.calls.setState).toEqual([])
  })

  it('carries every word of the kernel vocabulary, ended as the alive flag', () => {
    const h = harness()
    const dispose = bindKernelState('session-1', h.bridge, h.sink)
    for (const state of AgentStateSchema.options) h.emit(state)
    expect(h.calls.setState.map(([, state]) => state)).toEqual(
      AgentStateSchema.options.filter((state) => state !== 'ended')
    )
    expect(h.calls.setAlive).toEqual([['session-1', false]])
    dispose()
  })

  it('drops a word the session model does not define', () => {
    const h = harness()
    const dispose = bindKernelState('session-1', h.bridge, h.sink)
    h.emit('thinking')
    h.emit('')
    expect(h.calls.setState).toEqual([])
    expect(h.calls.setAlive).toEqual([])
    dispose()
  })

  it('leaves the alive flag alone when the session is already not alive', () => {
    const h = harness()
    const dispose = bindKernelState('session-1', h.bridge, { ...h.sink, isAlive: () => false })
    h.emit('ended')
    expect(h.calls.setAlive).toEqual([])
    dispose()
  })
})
