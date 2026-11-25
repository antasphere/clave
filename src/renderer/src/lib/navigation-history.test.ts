import { describe, expect, it } from 'vitest'
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  isCovered,
  isEmptyPlace,
  moveTo,
  placesToward,
  recordPlace,
  replaceAt,
  samePlace,
  sameSpot,
  stepTarget,
  type NavigationHistory,
  type Place,
  type PlacePlugin
} from './navigation-history'

/** A tab shown alone, nothing beside it. */
function tab(name: string, over: Partial<Place> = {}): Place {
  return {
    workspaceId: 'ws-a',
    view: 'terminals',
    section: null,
    tabs: [name],
    focused: name,
    groupView: null,
    tabView: null,
    plugin: null,
    beside: { [name]: null },
    ...over
  }
}

/** Several tabs side by side: no card beside any of them. */
function mosaic(tabs: string[], focused: string): Place {
  return tab(tabs[0], { tabs, focused, beside: null })
}

const EMPTY: Place = tab('none', { tabs: [], focused: null, beside: null })

function walk(...places: Place[]): NavigationHistory {
  return places.reduce(recordPlace, EMPTY_HISTORY)
}

const page = (over: Partial<Extract<PlacePlugin, { kind: 'page' }>['page']> = {}): PlacePlugin => ({
  kind: 'page',
  page: {
    pluginId: 'plugin.one',
    actionId: 'home',
    pluginName: 'One',
    icon: 'chart',
    title: 'Home',
    url: 'http://127.0.0.1:4000/home',
    ...over
  }
})

describe('recordPlace (PRDCT-5155)', () => {
  it('appends each new place and puts it on screen, leaving the history it was given alone', () => {
    const a = tab('tab-a')
    const b = tab('tab-b')
    const one = recordPlace(EMPTY_HISTORY, a)
    const two = recordPlace(one, b)
    expect(one.entries).toEqual([a])
    expect(one.index).toBe(0)
    expect(two.entries[0]).toBe(a)
    expect(two.entries[1]).toBe(b)
    expect(two.index).toBe(1)
    expect(one.entries).toHaveLength(1)
  })

  it('returns the very same history for the place already on screen', () => {
    const h = walk(tab('tab-a'), tab('tab-b'))
    // Equal, not identical: a fresh read of the stores builds a new object.
    const again = tab('tab-b')
    expect(recordPlace(h, again)).toBe(h)
  })

  it('replaces the current entry when the focus moves to another tile of the same mosaic', () => {
    const a = tab('tab-a')
    const m1 = mosaic(['tab-1', 'tab-2'], 'tab-1')
    const h = walk(a, m1)
    const refocused = mosaic(['tab-1', 'tab-2'], 'tab-2')
    const moved = recordPlace(h, refocused)
    expect(moved.entries).toHaveLength(2)
    expect(moved.entries[0]).toBe(a)
    expect(moved.entries[1]).toBe(refocused)
    expect(moved.index).toBe(1)
    // The tiles picked in another order are the same mosaic too.
    const reordered = mosaic(['tab-2', 'tab-1'], 'tab-2')
    const again = recordPlace(moved, reordered)
    expect(again.entries).toHaveLength(2)
    expect(again.entries[1]).toBe(reordered)
    // Another set of tiles is another place.
    expect(recordPlace(again, mosaic(['tab-1', 'tab-3'], 'tab-1')).entries).toHaveLength(3)
  })

  it('drops the places ahead when a new place is recorded after going back', () => {
    const [a, b, c, d] = ['tab-a', 'tab-b', 'tab-c', 'tab-d'].map((name) => tab(name))
    const back = moveTo(walk(a, b, c), 0)
    const next = recordPlace(back, d)
    expect(next.entries).toHaveLength(2)
    expect(next.entries[0]).toBe(a)
    expect(next.entries[1]).toBe(d)
    expect(next.index).toBe(1)
  })

  it(`keeps the newest ${HISTORY_LIMIT} places with the index on the one shown`, () => {
    const places = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => tab(`tab-${i}`))
    const full = walk(...places)
    expect(full.entries).toHaveLength(HISTORY_LIMIT)
    expect(full.entries[0]).toBe(places[5])
    expect(full.entries[HISTORY_LIMIT - 1]).toBe(places[HISTORY_LIMIT + 4])
    expect(full.index).toBe(HISTORY_LIMIT - 1)
    // Back in the middle of a full history, a new place drops what was ahead.
    const x = tab('tab-x')
    const after = recordPlace(moveTo(full, 49), x)
    expect(after.entries).toHaveLength(51)
    expect(after.entries[50]).toBe(x)
    expect(after.entries[0]).toBe(places[5])
    expect(after.index).toBe(50)
  })

  it('never records an empty place', () => {
    expect(recordPlace(EMPTY_HISTORY, EMPTY)).toBe(EMPTY_HISTORY)
    const h = walk(tab('tab-a'))
    expect(recordPlace(h, EMPTY)).toBe(h)
  })

  it('counts a page, a view or a plugin with no tab under it as something on screen', () => {
    expect(isEmptyPlace(EMPTY)).toBe(true)
    expect(isEmptyPlace({ ...EMPTY, view: 'settings', section: 'general' })).toBe(false)
    expect(isEmptyPlace({ ...EMPTY, groupView: 'group-1' })).toBe(false)
    expect(isEmptyPlace({ ...EMPTY, tabView: 'tab-1' })).toBe(false)
    expect(isEmptyPlace({ ...EMPTY, plugin: page() })).toBe(false)
    expect(isEmptyPlace({ ...EMPTY, tabs: ['tab-1'], focused: 'tab-1' })).toBe(false)
  })
})

describe('samePlace and sameSpot', () => {
  it('tell another tile of the same mosaic from the same place', () => {
    const m = mosaic(['tab-1', 'tab-2', 'tab-3'], 'tab-1')
    const reordered = mosaic(['tab-3', 'tab-1', 'tab-2'], 'tab-1')
    const refocused = mosaic(['tab-1', 'tab-2', 'tab-3'], 'tab-3')
    expect(samePlace(m, mosaic(['tab-1', 'tab-2', 'tab-3'], 'tab-1'))).toBe(true)
    expect(samePlace(m, reordered)).toBe(false)
    expect(sameSpot(m, reordered)).toBe(true)
    expect(samePlace(m, refocused)).toBe(false)
    expect(sameSpot(m, refocused)).toBe(true)
    expect(sameSpot(m, mosaic(['tab-1', 'tab-2'], 'tab-1'))).toBe(false)
    expect(sameSpot(m, mosaic(['tab-1', 'tab-2', 'tab-4'], 'tab-1'))).toBe(false)
  })

  it('compare the card beside a tab by kind and id, not by when it was opened', () => {
    const card = { kind: 'artefact' as const, id: '/work/deck', openedAt: '2026-01-01T10:00:00Z' }
    const shown = tab('tab-1', { beside: { 'tab-1': card } })
    // An agent opening the same artefact again shows the same page: the same place.
    const reopened = tab('tab-1', {
      beside: { 'tab-1': { ...card, openedAt: '2026-01-01T11:00:00Z' } }
    })
    expect(samePlace(shown, reopened)).toBe(true)
    expect(recordPlace(recordPlace(EMPTY_HISTORY, shown), reopened).entries).toHaveLength(1)
    const variants: Place[] = [
      tab('tab-1', { beside: { 'tab-1': { ...card, id: '/work/other' } } }),
      tab('tab-1', { beside: { 'tab-1': { kind: 'document', id: '/work/deck' } } }),
      tab('tab-1', { beside: { 'tab-1': null } }),
      tab('tab-1', { beside: null }),
      tab('tab-1', { beside: {} }),
      tab('tab-1', { beside: { 'tab-1': card, 'tab-2': null } })
    ]
    for (const other of variants) {
      expect(samePlace(shown, other)).toBe(false)
      expect(sameSpot(shown, other)).toBe(false)
      expect(samePlace(other, shown)).toBe(false)
    }
    expect(samePlace(shown, tab('tab-1', { beside: { 'tab-1': { ...card } } }))).toBe(true)
    // The same id under the other kind is another card.
    const doc = tab('tab-1', { beside: { 'tab-1': { kind: 'document', id: 'doc-1' } } })
    const art = tab('tab-1', { beside: { 'tab-1': { kind: 'artefact', id: 'doc-1' } } })
    expect(samePlace(doc, art)).toBe(false)
    expect(sameSpot(doc, art)).toBe(false)
  })

  it('compare plugin pages by plugin, action and address, never by title', () => {
    const shown = tab('tab-1', { plugin: page(), beside: null })
    expect(samePlace(shown, { ...shown, plugin: page({ title: 'Renamed', icon: 'other' }) })).toBe(
      true
    )
    for (const plugin of [
      page({ url: 'http://127.0.0.1:4000/other' }),
      page({ actionId: 'other' }),
      page({ pluginId: 'plugin.two' }),
      { kind: 'panel' as const, pluginId: 'plugin.one', panelId: 'home' },
      null
    ]) {
      expect(samePlace(shown, { ...shown, plugin })).toBe(false)
      expect(sameSpot(shown, { ...shown, plugin })).toBe(false)
    }
    const panel = { kind: 'panel' as const, pluginId: 'plugin.one', panelId: 'home' }
    expect(samePlace({ ...shown, plugin: panel }, { ...shown, plugin: { ...panel } })).toBe(true)
    expect(
      samePlace({ ...shown, plugin: panel }, { ...shown, plugin: { ...panel, panelId: 'b' } })
    ).toBe(false)
  })

  it('treat the workspace, the view and the pages over the mosaic as part of the place', () => {
    const base = tab('tab-1')
    const one = (over: Partial<Place>): Place => ({ ...base, ...over })
    // Each pair differs in one field only.
    const pairs: Array<[Place, Place]> = [
      [base, one({ workspaceId: 'ws-b' })],
      [base, one({ workspaceId: null })],
      [one({ view: 'agents', beside: null }), one({ view: 'ongoing', beside: null })],
      [
        one({ view: 'settings', section: 'general', beside: null }),
        one({ view: 'settings', section: 'keymaps', beside: null })
      ],
      [one({ groupView: 'group-1', beside: null }), one({ groupView: 'group-2', beside: null })],
      [one({ tabView: 'tab-1', beside: null }), one({ tabView: 'tab-2', beside: null })]
    ]
    for (const [a, b] of pairs) {
      expect(samePlace(a, b)).toBe(false)
      expect(sameSpot(a, b)).toBe(false)
    }
  })
})

describe('a page over the tabs (PRDCT-5155)', () => {
  /** What the column shows over tabs `tabs`, `focused` the one in focus. */
  const over = (tabs: string[], focused: string | null, cover: Partial<Place>): Place => ({
    ...tab('unused'),
    tabs,
    focused,
    beside: null,
    ...cover
  })
  const covers: Array<[string, Partial<Place>]> = [
    ['Settings', { view: 'settings', section: 'general' }],
    ['Extensions', { view: 'extensions', section: 'installed' }],
    ['Ongoing', { view: 'ongoing' }],
    ['a plugin’s page', { plugin: page() }],
    ['a plugin’s panel', { plugin: { kind: 'panel', pluginId: 'plugin.one', panelId: 'home' } }],
    ['a group’s page', { groupView: 'group-1' }],
    ['a tab’s page', { tabView: 'tab-1' }]
  ]

  it('is a page filling the column; the Agents view and the bare mosaic are not', () => {
    for (const [name, cover] of covers)
      expect([name, isCovered(over([], null, cover))]).toEqual([name, true])
    expect(isCovered(over(['agent-1'], 'agent-1', { view: 'agents' }))).toBe(false)
    expect(isCovered(tab('tab-1'))).toBe(false)
    expect(isCovered(mosaic(['tab-1', 'tab-2'], 'tab-1'))).toBe(false)
  })

  it('is the same spot whatever tabs are hidden under it and whichever has the focus', () => {
    for (const [name, cover] of covers) {
      const before = over(['tab-1', 'tab-2'], 'tab-1', cover)
      for (const hidden of [over([], null, cover), over(['tab-9'], 'tab-9', cover)]) {
        expect([name, sameSpot(before, hidden), sameSpot(hidden, before)]).toEqual([
          name,
          true,
          true
        ])
        // Still another place by the letter: the tabs a restore puts back under the page.
        expect([name, samePlace(before, hidden)]).toEqual([name, false])
      }
    }
  })

  it('never makes two pages, or a page and the mosaic, the same spot', () => {
    const board = over(['tab-1'], 'tab-1', { groupView: 'group-1' })
    expect(sameSpot(board, over(['tab-1'], 'tab-1', { groupView: 'group-2' }))).toBe(false)
    expect(sameSpot(board, over(['tab-1'], 'tab-1', { tabView: 'tab-1' }))).toBe(false)
    expect(sameSpot(board, tab('tab-1'))).toBe(false)
    const general = over(['tab-1'], 'tab-1', { view: 'settings', section: 'general' })
    expect(
      sameSpot(general, over(['tab-1'], 'tab-1', { view: 'settings', section: 'keymaps' }))
    ).toBe(false)
    expect(sameSpot(general, { ...general, workspaceId: 'ws-b' })).toBe(false)
    // The Agents view shows the selected agent's tab: another agent is another place.
    const agents = over(['agent-1'], 'agent-1', { view: 'agents' })
    expect(sameSpot(agents, over(['agent-2'], 'agent-2', { view: 'agents' }))).toBe(false)
  })

  it('takes the slot of the page when an agent opens a tab under it, and Back leaves the page', () => {
    const before = tab('tab-a')
    const board = over(['tab-a'], 'tab-a', { groupView: 'group-1' })
    const h = walk(before, board)
    const opened = over(['tab-new'], 'tab-new', { groupView: 'group-1' })
    const after = recordPlace(h, opened)
    expect(after.entries).toHaveLength(2)
    expect(after.entries[1]).toBe(opened)
    expect(after.index).toBe(1)
    expect(stepTarget(after, -1, () => true)).toBe(0)
    // A tab closed under Settings: the same.
    const settings = over(['tab-a', 'tab-b'], 'tab-a', { view: 'settings', section: 'general' })
    const closed = over(['tab-a'], 'tab-a', { view: 'settings', section: 'general' })
    const s = recordPlace(walk(before, settings), closed)
    expect(s.entries).toEqual([before, closed])
    expect(s.index).toBe(1)
  })
})

describe('stepTarget', () => {
  const names = ['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4']
  const places = names.map((name) => tab(name))
  const h = moveTo(walk(...places), 2)
  const without =
    (...gone: string[]) =>
    (p: Place): boolean =>
      !gone.includes(p.tabs[0])

  it('skips the places that are gone, in both directions', () => {
    expect(stepTarget(h, -1, without())).toBe(1)
    expect(stepTarget(h, 1, without())).toBe(3)
    expect(stepTarget(h, -1, without('tab-1'))).toBe(0)
    expect(stepTarget(h, 1, without('tab-3'))).toBe(4)
  })

  it('returns null at either end, and when everything that way is gone', () => {
    expect(stepTarget(moveTo(h, 0), -1, without())).toBeNull()
    expect(stepTarget(moveTo(h, 4), 1, without())).toBeNull()
    expect(stepTarget(h, -1, without('tab-0', 'tab-1'))).toBeNull()
    expect(stepTarget(h, 1, without('tab-3', 'tab-4'))).toBeNull()
    expect(stepTarget(EMPTY_HISTORY, -1, without())).toBeNull()
    expect(stepTarget(EMPTY_HISTORY, 1, without())).toBeNull()
  })
})

describe('placesToward', () => {
  const places = Array.from({ length: 30 }, (_, i) => tab(`tab-${i}`))
  const h = moveTo(walk(...places), 25)
  const all = (): boolean => true

  it('lists the places nearest first, twenty at most unless told otherwise', () => {
    const back = placesToward(h, -1, all)
    expect(back.map((entry) => entry.index)).toEqual(Array.from({ length: 20 }, (_, i) => 24 - i))
    expect(back[0].place).toBe(places[24])
    expect(placesToward(h, 1, all).map((entry) => entry.index)).toEqual([26, 27, 28, 29])
    expect(placesToward(h, -1, all, 3).map((entry) => entry.index)).toEqual([24, 23, 22])
  })

  it('leaves out the places that are gone and still fills the limit past them', () => {
    const alive = (p: Place): boolean => !['tab-24', 'tab-22'].includes(p.tabs[0])
    expect(placesToward(h, -1, alive, 3).map((entry) => entry.index)).toEqual([23, 21, 20])
    expect(placesToward(moveTo(h, 0), -1, alive)).toEqual([])
  })
})

describe('moveTo and replaceAt', () => {
  const places = ['tab-0', 'tab-1', 'tab-2'].map((name) => tab(name))
  const h = walk(...places)

  it('move the index inside the history only', () => {
    const moved = moveTo(h, 1)
    expect(moved.index).toBe(1)
    expect(moved.entries).toBe(h.entries)
    for (const index of [-1, 3, 1.5]) expect(moveTo(h, index)).toBe(h)
  })

  it('replace one entry inside the history only, the index where it was', () => {
    const x = tab('tab-x')
    const replaced = replaceAt(moveTo(h, 0), 1, x)
    expect(replaced.entries).toEqual([places[0], x, places[2]])
    expect(replaced.index).toBe(0)
    expect(h.entries[1]).toBe(places[1])
    for (const index of [-1, 3, 0.5]) expect(replaceAt(h, index, x)).toBe(h)
  })
})
