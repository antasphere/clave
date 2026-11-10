import { describe, expect, it, vi } from 'vitest'

// The catalog names every helper Clave declares (PRDCT-4330): the Settings
// page lists the registry, and the registry knows a helper only once its file
// is loaded, which in the standalone server's settings graph is through the
// catalog alone. Every module of this folder is loaded here; a helper
// declared in any of them and left out of the catalog fails.
vi.mock('electron', () => {
  throw new Error('a helper module imported electron')
})

describe('the catalog', () => {
  it('names every helper the registry knows, and nothing else', async () => {
    const modules = import.meta.glob(['./*.ts', '!./*.test.ts'])
    for (const load of Object.values(modules)) await load()
    const { listHelpers } = await import('./registry')
    const catalog = await import('./catalog')
    const named = Object.values(catalog).map((helper) => (helper as { id: string }).id)
    expect([...named].sort()).toEqual(
      listHelpers()
        .map((h) => h.id)
        .sort()
    )
    expect(named).toEqual(expect.arrayContaining(['push-summary', 'commit-message', 'tab-title']))
  })
})
