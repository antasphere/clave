import type { PluginPage } from '../components/plugins/plugin-ui-store'
import type { ActiveView } from '../store/session-types'

/**
 * Back and Forward through the places the content area showed (PRDCT-5155).
 *
 * A place is what the content column shows, plus the workspace it shows it
 * in: the view, the tabs of the mosaic and the one focused, a group's or a
 * tab's page over them, a plugin's page or panel, and what sits beside a tab
 * shown alone. The history is the list of places in the order the person
 * went through them, whoever made the move: a click, a key, an agent opening
 * a tab or an artefact. Per window, in memory, empty at launch.
 *
 * This module is the rule and nothing else: plain data in, plain data out,
 * no store and no window. Reading a place off the stores and putting one
 * back are `navigation-place.ts`; the recorder is `store/navigation-store.ts`.
 */

/** The view of the content column (`ActiveView`). */
export type PlaceView = ActiveView

/** What shows beside a tab shown alone: its artefact or its linked document. */
export interface BesideCard {
  kind: 'artefact' | 'document'
  /** artefact: its `target`; document: its id */
  id: string
  /** artefact only: the `openedAt` of the open that showed */
  openedAt?: string
}

/** A plugin's page (an action answered it) or main panel, covering the content column. */
export type PlacePlugin =
  | { kind: 'page'; page: PluginPage }
  | { kind: 'panel'; pluginId: string; panelId: string }

export interface Place {
  workspaceId: string | null
  view: PlaceView
  /** settingsSection when view is 'settings', extensionsSection when 'extensions', else null */
  section: string | null
  /** selectedSessionIds as they were: sessions and file tabs, in order */
  tabs: string[]
  /** focusedSessionId */
  focused: string | null
  /** activeGroupViewId, only when that group exists and has a view, else null */
  groupView: string | null
  /** activeSessionViewId, only when that session exists and has a view, else null */
  tabView: string | null
  /** the plugin page or main panel covering the content column, else null */
  plugin: PlacePlugin | null
  /** What shows beside each SESSION tab of `tabs` (file tabs never have one): its artefact,
   *  its document, or null. `null` for the whole field when no card can show: the mosaic is
   *  covered (view is not 'terminals', or a plugin, a group view or a tab view fills the
   *  column) or it holds several tabs (the pane draws a card beside a tab shown alone only).
   *  Then nothing beside a tab is visible, it is not part of the place, and a restore leaves
   *  it alone. */
  beside: Record<string, BesideCard | null> | null
}

export interface NavigationHistory {
  readonly entries: readonly Place[]
  /** The place on screen, -1 when the history is empty. */
  readonly index: number
}

export const EMPTY_HISTORY: NavigationHistory = Object.freeze({ entries: [], index: -1 })

/** How many places a window keeps; the oldest go first. */
export const HISTORY_LIMIT = 100

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && sameList([...a].sort(), [...b].sort())
}

function samePlugin(a: PlacePlugin | null, b: PlacePlugin | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'page' && b.kind === 'page') {
    return (
      a.page.pluginId === b.page.pluginId &&
      a.page.actionId === b.page.actionId &&
      a.page.url === b.page.url
    )
  }
  if (a.kind === 'panel' && b.kind === 'panel') {
    return a.pluginId === b.pluginId && a.panelId === b.panelId
  }
  return false
}

function sameCard(a: BesideCard | null, b: BesideCard | null): boolean {
  if (a === null || b === null) return a === b
  // Not `openedAt`: an agent opening the same artefact again shows the same page, and a
  // place that differed only by it would make one Back step look like it did nothing.
  return a.kind === b.kind && a.id === b.id
}

function sameBeside(a: Place['beside'], b: Place['beside']): boolean {
  if (a === null || b === null) return a === b
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameCard(a[key], b[key]))
}

/** A card's identity for what the person has seen: an artefact by its target and the open
 *  that showed it (an agent opening it again shows a new open), a document by its id. */
export function cardKey(card: BesideCard): string {
  return card.kind === 'artefact'
    ? `artefact:${card.id}@${card.openedAt ?? ''}`
    : `document:${card.id}`
}

/**
 * What going to a place does with the card beside a tab: `'leave'` when a card shows now
 * (`current`) that the person has not seen (an agent opened it while another place was on
 * screen): it stays, neither hidden nor replaced by the card the place had (`_want`, which
 * therefore never changes the answer), since it is the agent's output the person comes back
 * for. `'apply'` otherwise: the place's card, or none, is put back.
 */
export function besideAction(
  _want: BesideCard | null,
  current: BesideCard | null,
  seen: (card: BesideCard) => boolean
): 'leave' | 'apply' {
  return current !== null && !seen(current) ? 'leave' : 'apply'
}

/** Every field but the tabs and the focus. */
function sameSurroundings(a: Place, b: Place): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.view === b.view &&
    a.section === b.section &&
    a.groupView === b.groupView &&
    a.tabView === b.tabView &&
    samePlugin(a.plugin, b.plugin) &&
    sameBeside(a.beside, b.beside)
  )
}

/** Every field equal: the tabs in the same order, the same tab focused. */
export function samePlace(a: Place, b: Place): boolean {
  return sameSurroundings(a, b) && sameList(a.tabs, b.tabs) && a.focused === b.focused
}

/** A page fills the content column: Settings, Extensions, Ongoing, a plugin's page or panel,
 *  a group's or a tab's own page. The tabs under it are hidden. (The Agents view is no such
 *  page: it shows the selected agent's tab.) */
export function isCovered(p: Place): boolean {
  return (
    p.view === 'settings' ||
    p.view === 'extensions' ||
    p.view === 'ongoing' ||
    p.plugin !== null ||
    p.groupView !== null ||
    p.tabView !== null
  )
}

/** What the person sees is the same: the same mosaic, whichever of its tiles has the focus
 *  and in whatever order its tabs were picked (another tile of it was clicked), or the same
 *  page over the tabs, whatever tabs are hidden under it (an agent opened a tab under a
 *  group's page, a tab was closed under Settings). */
export function sameSpot(a: Place, b: Place): boolean {
  // The same surroundings: covered both, or neither.
  return sameSurroundings(a, b) && (isCovered(a) || sameIds(a.tabs, b.tabs))
}

/** Nothing on screen: the bare mosaic with no tab in it. Never recorded. */
export function isEmptyPlace(p: Place): boolean {
  return (
    p.view === 'terminals' &&
    p.tabs.length === 0 &&
    p.groupView === null &&
    p.tabView === null &&
    p.plugin === null
  )
}

/**
 * The history once `place` is on screen. The same place changes nothing (the
 * same object comes back, so nothing subscribed renders again); the same spot
 * (another tile of the same mosaic, other tabs under the same page) takes the
 * current entry's slot; anything else drops the places ahead (as a browser
 * does after going back) and is appended, the oldest falling off past
 * `HISTORY_LIMIT`.
 */
export function recordPlace(h: NavigationHistory, place: Place): NavigationHistory {
  if (isEmptyPlace(place)) return h
  const current = h.index >= 0 ? h.entries[h.index] : undefined
  if (current && samePlace(current, place)) return h
  if (current && sameSpot(current, place)) return replaceAt(h, h.index, place)
  const entries = [...h.entries.slice(0, h.index + 1), place]
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT)
  return { entries: entries.slice(overflow), index: entries.length - 1 - overflow }
}

/** The nearest entry in that direction whose place is still alive and would show something
 *  else than the place on screen (a T1 left for T2 and come back to, T2 then closed: one
 *  Back goes past the first T1); null when none. `shown` is what a place would show once
 *  what is gone is left out (a mosaic of B and A, B closed since, shows A alone): the
 *  comparison is made on that, so a place that would look like the one on screen is passed. */
export function stepTarget(
  h: NavigationHistory,
  delta: -1 | 1,
  alive: (p: Place) => boolean,
  shown: (p: Place) => Place = (p) => p
): number | null {
  const current = h.entries[h.index]
  const here = current && shown(current)
  for (let i = h.index + delta; i >= 0 && i < h.entries.length; i += delta) {
    const place = h.entries[i]
    if (alive(place) && !(here && sameSpot(shown(place), here))) return i
  }
  return null
}

const inRange = (h: NavigationHistory, index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < h.entries.length

/** The same entries, `index` on screen; out of range, the history as it was. */
export function moveTo(h: NavigationHistory, index: number): NavigationHistory {
  if (!inRange(h, index) || index === h.index) return h
  return { entries: h.entries, index }
}

/** The entry at `index` replaced by `place`; out of range, the history as it was. */
export function replaceAt(h: NavigationHistory, index: number, place: Place): NavigationHistory {
  if (!inRange(h, index)) return h
  const entries = [...h.entries]
  entries[index] = place
  return { entries, index: h.index }
}

/** The alive places in that direction, nearest first, at most `limit`: the list a
 *  right-click on Back or Forward shows. A place that would show the same as the row before
 *  it (the place on screen, for the first row) is left out, so no place is listed twice in a
 *  row and the first row is where one step goes (`stepTarget`), compared as `shown`. */
export function placesToward(
  h: NavigationHistory,
  delta: -1 | 1,
  alive: (p: Place) => boolean,
  limit = 20,
  shown: (p: Place) => Place = (p) => p
): Array<{ index: number; place: Place }> {
  const out: Array<{ index: number; place: Place }> = []
  const current = h.entries[h.index]
  let last: Place | undefined = current && shown(current)
  for (let i = h.index + delta; i >= 0 && i < h.entries.length && out.length < limit; i += delta) {
    const place = h.entries[i]
    if (!alive(place)) continue
    const looks = shown(place)
    if (last && sameSpot(looks, last)) continue
    out.push({ index: i, place })
    last = looks
  }
  return out
}
