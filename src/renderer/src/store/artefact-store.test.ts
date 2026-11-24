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

/** Several artefacts per session (PRDCT-5022): what a session shows in the window. */
describe('the artefact a session shows', () => {
  const a = (target: string, openedAt: string): Artefact => ({
    sessionId: 's1',
    target,
    page: `${target}/index.html`,
    title: target.split('/').pop()!,
    openedAt
  })
  const deck = a('/work/deck', '2026-11-24T08:00:00.000Z')
  const talk = a('/work/talk', '2026-11-24T09:00:00.000Z')

  it('is the front one, the last opened, with no pick', () => {
    expect(mod.shownOf([deck, talk], undefined)).toBe(talk)
    expect(mod.shownOf([], undefined)).toBeUndefined()
    expect(mod.shownOf(undefined, undefined)).toBeUndefined()
  })

  it('is the one picked, while the front stays the one it was picked on', () => {
    expect(mod.shownOf([deck, talk], { target: deck.target, front: talk.openedAt })).toBe(deck)
    // Picked on another front: a newer open by the agent shows its own.
    expect(mod.shownOf([deck, talk], { target: deck.target, front: deck.openedAt })).toBe(talk)
    // The pick is gone from the list: the front.
    expect(mod.shownOf([talk], { target: deck.target, front: talk.openedAt })).toBe(talk)
  })

  it('groups the servers’ list by session in its order, and derives every session', () => {
    const other = { ...deck, sessionId: 's2' }
    const lists = mod.groupBySession([deck, other, talk])
    expect(lists).toEqual({ s1: [deck, talk], s2: [other] })
    expect(mod.shownAll(lists, { s1: { target: deck.target, front: talk.openedAt } })).toEqual({
      s1: deck,
      s2: other
    })
  })

  it('a pick in the store shows that artefact until the agent opens another', () => {
    const store = mod.useArtefactStore.getState()
    store.setLists({ s1: [deck, talk] })
    expect(mod.useArtefactStore.getState().artefacts.s1).toBe(talk)
    mod.useArtefactStore.getState().pick('s1', deck.target)
    expect(mod.useArtefactStore.getState().artefacts.s1).toBe(deck)
    const again = a('/work/deck', '2026-11-24T10:00:00.000Z')
    const newer = a('/work/notes', '2026-11-24T10:30:00.000Z')
    mod.useArtefactStore.getState().setLists({ s1: [talk, again, newer] }, 's1')
    expect(mod.useArtefactStore.getState().artefacts.s1).toBe(newer)
    mod.useArtefactStore.getState().setLists({ s1: [] }, 's1')
    expect(mod.useArtefactStore.getState().artefacts.s1).toBeUndefined()
    expect(mod.useArtefactStore.getState().lists.s1).toBeUndefined()
  })
})
