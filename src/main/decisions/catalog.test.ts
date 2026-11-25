import { describe, expect, it, vi } from 'vitest'

// The catalog names every decision Clave declares (PRDCT-5179), as the
// helpers' catalog does: the Settings page lists the registry, and the
// registry knows a decision only once its file is loaded, which in the
// standalone server's settings graph is through the catalog alone. Every
// module of this folder is loaded here; a decision declared in any of them
// and left out of the catalog fails. No module of the folder may reach
// Electron.
vi.mock('electron', () => {
  throw new Error('a decision module imported electron')
})

describe('the catalog', () => {
  it('names every decision the registry knows, and nothing else', async () => {
    const modules = import.meta.glob(['./*.ts', '!./*.test.ts'])
    for (const load of Object.values(modules)) await load()
    const { listDecisions } = await import('./registry')
    const catalog = await import('./catalog')
    const named = Object.values(catalog).map((decision) => (decision as { id: string }).id)
    expect([...named].sort()).toEqual(
      listDecisions()
        .map((d) => d.id)
        .sort()
    )
  })
})
