import { beforeAll, describe, expect, it } from 'vitest'
import { sessionKey } from '@clave/contract/fleet'
import type { Artefact } from '@clave/contract/artefacts/model'

/**
 * The window's mirror of the sessions' artefacts (PRDCT-4474): an artefact
 * shows unless the person hid THAT open of it; the split stays in its
 * bounds; what the window keeps of its own is pruned at its first list,
 * machine by machine, for the sessions no longer listed.
 */
const memory = new Map<string, string>()
const REMOTE = sessionKey({ serverId: 'srv', sessionId: 'w1' })
const artefact = (sessionId: string, openedAt = '2026-11-12T10:00:00.000Z'): Artefact => ({
  sessionId,
  target: '/work/deck',
  page: '/work/deck/index.html',
  title: 'deck',
  openedAt
})
let listed: Artefact[] = []
let changed: ((change: { sessionId: string; artefact: Artefact | null }) => void) | null = null
const bridge = {
  artefacts: {
    list: async () => listed,
    onChanged: (cb: typeof changed) => {
      changed = cb
      return () => {}
    },
    onSlidelessState: () => () => {},
    slidelessState: async () => ({ phase: 'ready', version: '1', error: null }),
    installSlideless: async () => ({ phase: 'installing', version: null, error: null })
  },
  onServerConnected: () => () => {}
}

let mod: typeof import('./artefact-store')
beforeAll(async () => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = bridge
  // Kept by an earlier run: a session still listed, one of this Mac gone,
  // and one of a server that has not answered yet.
  memory.set(
    'clave-artefact-view',
    JSON.stringify({
      hidden: { s1: 'old', gone: 'x', [REMOTE]: 'y' },
      split: { s1: 0.9, gone: 0.3, [REMOTE]: 0.4 }
    })
  )
  mod = await import('./artefact-store')
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the artefact store', () => {
  it('shows an artefact unless that very open was hidden', () => {
    const a = artefact('s1')
    expect(mod.isShown(a, {})).toBe(true)
    expect(mod.isShown(a, { s1: a.openedAt })).toBe(false)
    // The agent opens it again: a new openedAt shows it again.
    expect(mod.isShown(artefact('s1', '2026-11-12T11:00:00.000Z'), { s1: a.openedAt })).toBe(true)
  })

  it('keeps the split between a quarter and three quarters', () => {
    expect(mod.clampSplit(0.1)).toBe(0.25)
    expect(mod.clampSplit(0.9)).toBe(0.75)
    expect(mod.clampSplit(0.6)).toBe(0.6)
    expect(mod.clampSplit(Number.NaN)).toBe(0.5)
    // Read back clamped from storage too.
    expect(mod.useArtefactStore.getState().split.s1).toBe(0.75)
  })

  it('prunes at its first list what it keeps for sessions no longer listed, machine by machine', async () => {
    listed = [artefact('s1')]
    mod.initArtefacts()
    await settle()
    const { hidden, split, artefacts } = mod.useArtefactStore.getState()
    expect(Object.keys(artefacts)).toEqual(['s1'])
    expect(hidden).toEqual({ s1: 'old', [REMOTE]: 'y' })
    expect(split).toEqual({ s1: 0.75, [REMOTE]: 0.4 })
    expect(JSON.parse(memory.get('clave-artefact-view')!)).toEqual({ hidden, split })
    // The server answers later with nothing for that session: pruned then.
    listed = [artefact('s1'), artefact(sessionKey({ serverId: 'srv', sessionId: 'w2' }))]
    await mod.refreshArtefacts()
    expect(mod.useArtefactStore.getState().hidden).toEqual({ s1: 'old' })
  })

  it('hides and shows again, persisted; an open by the agent arrives pushed', async () => {
    const store = mod.useArtefactStore.getState()
    store.setHidden('s1', '2026-11-12T10:00:00.000Z')
    expect(mod.useArtefactStore.getState().hidden.s1).toBe('2026-11-12T10:00:00.000Z')
    store.setSplit('s1', 0.3)
    expect(JSON.parse(memory.get('clave-artefact-view')!).split.s1).toBe(0.3)
    store.setHidden('s1', null)
    expect(mod.useArtefactStore.getState().hidden.s1).toBeUndefined()
    changed?.({ sessionId: 's9', artefact: artefact('s9') })
    expect(mod.useArtefactStore.getState().artefacts.s9?.title).toBe('deck')
    changed?.({ sessionId: 's9', artefact: null })
    expect(mod.useArtefactStore.getState().artefacts.s9).toBeUndefined()
  })

  it('reads and installs Slideless per machine', async () => {
    const store = mod.useArtefactStore.getState()
    store.readSlideless('local')
    await settle()
    expect(mod.useArtefactStore.getState().slideless.local?.phase).toBe('ready')
    await store.install('srv')
    expect(mod.useArtefactStore.getState().slideless.srv?.phase).toBe('installing')
    expect(mod.ownerOfSession(REMOTE)).toBe('srv')
    expect(mod.ownerOfSession('s1')).toBe('local')
  })
})
