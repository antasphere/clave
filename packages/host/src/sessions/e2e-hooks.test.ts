import { afterEach, describe, expect, it, vi } from 'vitest'

// The hooks namespace exists under the test flag and nowhere else: a hook
// installed outside test mode would expose the session host, the settings
// source and the echo injection to anything running inside the process.
const mode = vi.hoisted(() => ({ on: false }))
vi.mock('../test-mode', () => ({
  get TEST_NO_ACTIVATE() {
    return mode.on
  }
}))

type Hooked = typeof globalThis & { __claveE2E?: Record<string, unknown> }

afterEach(() => {
  delete (globalThis as Hooked).__claveE2E
  vi.resetModules()
})

describe('the end-to-end hooks namespace', () => {
  it('installs nothing outside test mode', async () => {
    mode.on = false
    const { installE2eHooks } = await import('./e2e-hooks')
    installE2eHooks({ terminalJournal: { file: '/tmp/journal' } })
    expect((globalThis as Hooked).__claveE2E).toBeUndefined()
  })
  it('installs under the test flag, extending the namespace in place', async () => {
    mode.on = true
    const { installE2eHooks } = await import('./e2e-hooks')
    installE2eHooks({ terminalJournal: { file: '/tmp/journal' } })
    const first = (globalThis as Hooked).__claveE2E
    expect(first).toEqual({ terminalJournal: { file: '/tmp/journal' } })
    installE2eHooks({ echo: { inject: () => {} } })
    expect((globalThis as Hooked).__claveE2E).toBe(first)
    expect(Object.keys((globalThis as Hooked).__claveE2E ?? {}).sort()).toEqual([
      'echo',
      'terminalJournal'
    ])
  })
})
