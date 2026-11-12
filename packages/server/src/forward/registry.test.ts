import { describe, expect, it } from 'vitest'
import { isForwardLease } from '@clave/contract/forward'
import { ForwardRegistry } from './registry'

describe('the forward registry', () => {
  it('mints a lease of 32 lowercase hex characters, fresh each time', () => {
    const registry = new ForwardRegistry()
    const one = registry.register(4000)
    const two = registry.register(4000)
    expect(one.lease).toMatch(/^[0-9a-f]{32}$/)
    expect(isForwardLease(one.lease)).toBe(true)
    expect(two.lease).not.toBe(one.lease)
  })
  it('resolves a lease to its port on loopback, and nothing else', () => {
    const registry = new ForwardRegistry()
    const { lease } = registry.register(4123)
    expect(registry.resolve(lease)).toEqual({ port: 4123 })
    expect(registry.resolve('0'.repeat(32))).toBeUndefined()
    expect(registry.size()).toBe(1)
  })
  it('releases once, and a second release changes nothing', () => {
    const registry = new ForwardRegistry()
    const first = registry.register(4001)
    const second = registry.register(4002)
    first.release()
    first.release()
    expect(registry.resolve(first.lease)).toBeUndefined()
    expect(registry.resolve(second.lease)).toEqual({ port: 4002 })
    expect(registry.size()).toBe(1)
  })
  it('refuses a port that is not an integer in 1..65535', () => {
    const registry = new ForwardRegistry()
    for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => registry.register(port), String(port)).toThrow(/port/)
    expect(registry.size()).toBe(0)
  })
})
