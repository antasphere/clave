import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getClaveServerEndpoint,
  isClaveServerBootSettled,
  markClaveServerBootSettled,
  resetClaveServerBootForTests,
  setClaveServerEndpoint,
  whenClaveServerBootSettled
} from './endpoint'

/**
 * The boot's decision as a signal (wave 3): what the agent tools wait on
 * before choosing their road. Settled means decided, a server named or none;
 * a wait resolves when the mark lands, at once when it already did, and at
 * the latest after its ceiling, so a lost mark never holds a caller forever.
 */
beforeEach(() => {
  resetClaveServerBootForTests()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  resetClaveServerBootForTests()
})

describe('the boot signal', () => {
  it('starts undecided with no endpoint, and resolves its waiters when marked', async () => {
    expect(isClaveServerBootSettled()).toBe(false)
    expect(getClaveServerEndpoint()).toBeNull()
    let resolved: boolean | null = null
    const wait = whenClaveServerBootSettled().then((decided) => {
      resolved = decided
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBeNull()
    setClaveServerEndpoint({ url: 'http://127.0.0.1:1', token: 't' })
    markClaveServerBootSettled()
    await wait
    expect(resolved).toBe(true)
    expect(isClaveServerBootSettled()).toBe(true)
  })
  it('resolves at once once decided, with or without a server', async () => {
    markClaveServerBootSettled()
    let resolved: boolean | null = null
    void whenClaveServerBootSettled().then((decided) => {
      resolved = decided
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
    expect(getClaveServerEndpoint()).toBeNull()
  })
  it('gives up waiting after its ceiling when the boot never decides, and says so', async () => {
    let resolved: boolean | null = null
    void whenClaveServerBootSettled(1_000).then((decided) => {
      resolved = decided
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    // False: the caller gave up, the boot is still undecided.
    expect(resolved).toBe(false)
    expect(isClaveServerBootSettled()).toBe(false)
    // A mark landing later resolves nobody twice and leaves no stale waiter behind.
    markClaveServerBootSettled()
    expect(await whenClaveServerBootSettled(1)).toBe(true)
  })
  it('forgets the endpoint and the decision on reset', () => {
    setClaveServerEndpoint({ url: 'u', token: 't' })
    markClaveServerBootSettled()
    resetClaveServerBootForTests()
    expect(getClaveServerEndpoint()).toBeNull()
    expect(isClaveServerBootSettled()).toBe(false)
  })
})
