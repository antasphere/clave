import { afterEach, describe, expect, it } from 'vitest'
import { inMemorySessionWindows, installSessionWindows, sessionWindows } from './windows'

afterEach(() => installSessionWindows(null))

describe('the in-memory session windows port', () => {
  it('keeps the bindings and nothing else', async () => {
    const port = inMemorySessionWindows()
    port.bind('s1', 'w1')
    expect(port.windowOf('s1')).toBe('w1')
    expect(port.windowOf('s2')).toBeNull()
    port.unbind('s1')
    expect(port.windowOf('s1')).toBeNull()
    expect(port.workspaceOf('w1')).toBeNull()
    expect(() => port.send('w1', 'pty:data:s1', 'x')).not.toThrow()
    await expect(port.beforeStop('s1')).resolves.toBeUndefined()
  })
  it('is the port in force until the shell installs its own, and the shell’s after', () => {
    const first = sessionWindows()
    expect(sessionWindows()).toBe(first)
    const own = inMemorySessionWindows()
    installSessionWindows(own)
    expect(sessionWindows()).toBe(own)
    installSessionWindows(null)
    expect(sessionWindows()).not.toBe(own)
  })
})
