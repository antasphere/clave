/* Folio's updates (PRDCT-4832): an update is a finished answer of a Folio tab
   the person was not on the page for. One per tab, the newest; announced once
   ("I have an update for you on <group>."), played on the person's ask. The
   rules are pure here; the store (`store/updates-store.ts`) holds the list,
   the announcer (`lib/updates-voice.ts`) says them. Names are never stored on
   an update: the group and the tab are read live from the session store when
   shown or spoken, so a rename shows at once. */

export interface Update {
  /** `${sessionId}|${pageKey}` */
  id: string
  sessionId: string
  pageKey: string
  /** The page's `spoken` markdown: what a reading reads. */
  markdown: string
  /** The page's title when it was filed. */
  title: string
  at: number
  announced: boolean
}

export const updateId = (sessionId: string, pageKey: string): string => `${sessionId}|${pageKey}`

/** File an update: one per session, the newest wins, appended at the END (a
 *  replacement moves to the end, not yet announced). Pure. */
export function fileUpdate(list: Update[], next: Omit<Update, 'id' | 'announced'>): Update[] {
  return [
    ...list.filter((u) => u.sessionId !== next.sessionId),
    { ...next, id: updateId(next.sessionId, next.pageKey), announced: false }
  ]
}

/** The list without the update of a session. Pure; the same list when it had
 *  none. */
export function withoutSession(list: Update[], sessionId: string): Update[] {
  return list.some((u) => u.sessionId === sessionId)
    ? list.filter((u) => u.sessionId !== sessionId)
    : list
}

/** The list without one update. Pure; the same list when it was not there. */
export function withoutUpdate(list: Update[], id: string): Update[] {
  return list.some((u) => u.id === id) ? list.filter((u) => u.id !== id) : list
}

/** The oldest update not yet announced, or null. Pure. */
export function nextToAnnounce(list: Update[]): Update | null {
  return list.find((u) => !u.announced) ?? null
}

const cleanName = (name: string): string => name.trim().replace(/[\s.!?…,;:]+$/u, '') || 'a tab'

/** What the voice says of an update: `I have an update for you on <name>.`
 *  The name trimmed; a name ending in punctuation keeps one final period
 *  only. Pure. */
export function announcement(name: string): string {
  return `I have an update for you on ${cleanName(name)}.`
}

/** ONE line for every update not yet announced: `names` their distinct
 *  spoken names, oldest first, `count` how many updates. One name: `an
 *  update` or `<n> updates`; two: `A and B`; three: `A, B and C`; more: the
 *  first two and how many other names. Pure. */
export function announcementFor(names: string[], count: number): string {
  const shown = names.map(cleanName)
  if (shown.length <= 1) {
    const name = shown[0] ?? 'a tab'
    return count > 1
      ? `I have ${count} updates for you on ${name}.`
      : `I have an update for you on ${name}.`
  }
  const list =
    shown.length === 2
      ? `${shown[0]} and ${shown[1]}`
      : shown.length === 3
        ? `${shown[0]}, ${shown[1]} and ${shown[2]}`
        : `${shown[0]}, ${shown[1]} and ${shown.length - 2} more`
  return `I have updates for you on ${list}.`
}

/** The names an update is shown and said by, read live: the sidebar group
 *  the tab sits in (null when none) and the tab's own name. Pure. */
export function updateName(
  sessionId: string,
  sessions: ReadonlyArray<{ id: string; name: string }>,
  groups: ReadonlyArray<{ name: string; sessionIds: readonly string[] }>
): { group: string | null; tab: string } {
  const tab = sessions.find((s) => s.id === sessionId)?.name?.trim() || 'Untitled tab'
  const group = groups.find((g) => g.sessionIds.includes(sessionId))?.name?.trim() || null
  return { group, tab }
}

/** The one name an update goes by: its group, else its tab. Pure. */
export function spokenName(name: { group: string | null; tab: string }): string {
  return name.group ?? name.tab
}

export type ChipState = 'waiting' | 'preparing' | 'playing' | 'paused'

/** What the update chip shows, or null when it is not there: a reading in
 *  progress whose page is not on screen first, else the oldest waiting
 *  update and how many more wait. Pure. */
export function chipShown(
  updates: Update[],
  current: {
    sessionId: string
    onScreen: boolean
    reading: { state: 'preparing' | 'playing' | 'paused' }
  } | null
): { state: ChipState; sessionId: string; more: number } | null {
  if (current && !current.onScreen)
    return { state: current.reading.state, sessionId: current.sessionId, more: updates.length }
  const oldest = updates[0]
  return oldest ? { state: 'waiting', sessionId: oldest.sessionId, more: updates.length - 1 } : null
}

/** "Block n of m" for a reading's tick. Pure. */
export function blockLabel(reading: { tick: number; blocks: number }): string {
  const of = Math.max(1, reading.blocks)
  return `Block ${Math.min(Math.max(0, reading.tick), of - 1) + 1} of ${of}`
}
