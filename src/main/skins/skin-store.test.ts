import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkinStore } from './skin-store'
import { bundledSkins } from '../../../packages/skins/bundled'
it('imports, activates, persists, reloads edits and reverts removed skins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-skin-test-'))
  let active: string | null = null
  const updates: unknown[] = []
  const store = new SkinStore(
    join(dir, 'installed'),
    '1.90.2',
    () => active,
    (id) => {
      active = id
    },
    (state) => updates.push(state)
  )
  try {
    const source = join(dir, 'source')
    mkdirSync(source)
    writeFileSync(
      join(source, 'clave-plugin.json'),
      JSON.stringify({ ...bundledSkins[0], id: 'custom', name: 'Custom', tokens: undefined })
    )
    writeFileSync(join(source, 'skin.json'), JSON.stringify({ '--color-accent': '#abcdef' }))
    expect(store.import(source).activeId).toBe('custom')
    expect(active).toBe('custom')
    expect(store.list().skins.find((s) => s.id === 'custom')?.tokens['--color-accent']).toBe(
      '#abcdef'
    )
    store.startWatching()
    writeFileSync(
      join(dir, 'installed/custom/skin.json'),
      JSON.stringify({ '--color-accent': '#fedcba' })
    )
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(1), { timeout: 3000 })
    expect(store.list().skins.find((s) => s.id === 'custom')?.tokens['--color-accent']).toBe(
      '#fedcba'
    )
    expect(store.remove('custom').activeId).toBe('dark')
    expect(() => store.remove('dark')).toThrow()
    expect(() => store.activate('../source')).toThrow()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
