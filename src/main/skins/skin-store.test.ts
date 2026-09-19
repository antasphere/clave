import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, watch } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkinStore } from './skin-store'
import { bundledSkins } from '@clave/skins/bundled'
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})

it('imports, activates, persists, reloads edits and reverts removed skins', async () => {
  vi.mocked(watch).mockClear()
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
    store.startWatching()
    expect(store.list().activeId).toBeNull()
    expect(active).toBeNull()
    expect(existsSync(join(dir, 'installed'))).toBe(false)
    expect(watch).not.toHaveBeenCalled()
    const source = join(dir, 'source')
    mkdirSync(join(source, 'theme'), { recursive: true })
    writeFileSync(
      join(source, 'clave-plugin.json'),
      JSON.stringify({
        ...bundledSkins[0],
        id: 'custom',
        name: 'Custom',
        tokens: undefined,
        skin: { tokens: 'theme/tokens.json', base: 'dark' }
      })
    )
    writeFileSync(
      join(source, 'theme/tokens.json'),
      JSON.stringify({ '--color-accent': '#abcdef' })
    )
    expect(store.import(source).activeId).toBe('custom')
    expect(watch).toHaveBeenCalledWith(
      join(dir, 'installed'),
      { recursive: true },
      expect.any(Function)
    )
    expect(active).toBe('custom')
    expect(JSON.parse(readFileSync(join(dir, 'installed/custom/skin.json'), 'utf8'))).toEqual({
      '--color-accent': '#abcdef'
    })
    expect(store.list().skins.find((s) => s.id === 'custom')?.tokens['--color-accent']).toBe(
      '#abcdef'
    )
    await new Promise((resolve) => setTimeout(resolve, 2800))
    const beforeEdit = updates.length
    writeFileSync(
      join(dir, 'installed/custom/skin.json'),
      JSON.stringify({ '--color-accent': '#fedcba' })
    )
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(beforeEdit), { timeout: 3000 })
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
}, 10000)

it('watches the dedicated .clave parent before the skins directory exists', () => {
  vi.mocked(watch).mockClear()
  const dir = mkdtempSync(join(tmpdir(), 'clave-skin-parent-test-'))
  const parent = join(dir, '.clave')
  mkdirSync(parent)
  const store = new SkinStore(join(parent, 'skins'), '1.90.2', () => null, vi.fn(), vi.fn())
  try {
    store.startWatching()
    expect(watch).toHaveBeenCalledWith(parent, { recursive: true }, expect.any(Function))
    expect(existsSync(join(parent, 'skins'))).toBe(false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
