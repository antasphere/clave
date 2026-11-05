import { create } from 'zustand'

/** Find in one chat session. The field is PaneSearch.tsx, in the pane's
 *  header; the searching is the view's own (the chat-view plugin's
 *  `useTranscriptSearch`), because only the view holds the whole
 *  conversation: its rows are virtualised, so the page only ever carries the
 *  stretch around the reader and a search of the page found a different
 *  count at every scroll position. This store is the line between the two:
 *  the field writes the query and the steps, the view answers with what it
 *  found. */

export type FindStep = 'older' | 'newer'

/** What the view reports back for the field to say. */
export interface FindResult {
  total: number
  /** The current match counted from the newest, 1-based; 0 when none. */
  position: number
  /** The query is still settling (the debounce) or being searched. */
  pending: boolean
  /** Older history is being read in to look further back. */
  paging: boolean
  /** The search has looked all the way to the start of the session. */
  atStart: boolean
}
const EMPTY: FindResult = { total: 0, position: 0, pending: false, paging: false, atStart: false }

export interface PaneFind {
  query: string
  step: { nonce: number; dir: FindStep }
  result: FindResult
}

interface PaneSearchState {
  /** Which pane the Cmd+F shortcut asked to search; a nonce so asking again
   *  while it is open refocuses the field. */
  sessionId: string | null
  nonce: number
  open: (sessionId: string) => void
  finds: Record<string, PaneFind>
  setQuery: (sessionId: string, query: string) => void
  stepFind: (sessionId: string, dir: FindStep) => void
  report: (sessionId: string, result: Partial<FindResult>) => void
  clear: (sessionId: string) => void
}

const blank = (): PaneFind => ({ query: '', step: { nonce: 0, dir: 'older' }, result: EMPTY })

export const usePaneSearchStore = create<PaneSearchState>((set) => ({
  sessionId: null,
  nonce: 0,
  open: (sessionId) => set((s) => ({ sessionId, nonce: s.nonce + 1 })),
  finds: {},
  setQuery: (sessionId, query) =>
    set((s) => {
      const find = s.finds[sessionId] ?? blank()
      return {
        finds: {
          ...s.finds,
          [sessionId]: {
            ...find,
            query,
            result: { ...find.result, pending: query.trim() !== '' }
          }
        }
      }
    }),
  stepFind: (sessionId, dir) =>
    set((s) => {
      const find = s.finds[sessionId] ?? blank()
      return {
        finds: { ...s.finds, [sessionId]: { ...find, step: { nonce: find.step.nonce + 1, dir } } }
      }
    }),
  report: (sessionId, result) =>
    set((s) => {
      const find = s.finds[sessionId]
      if (!find) return s
      return {
        finds: { ...s.finds, [sessionId]: { ...find, result: { ...find.result, ...result } } }
      }
    }),
  clear: (sessionId) =>
    set((s) => {
      const finds = { ...s.finds }
      delete finds[sessionId]
      return { finds }
    })
}))

/** The visible transcript scroller of a chat pane, if it shows one. */
export function searchableScroller(sessionId: string): HTMLElement | null {
  const host = document.querySelector<HTMLElement>(
    `.chat-host[data-session-id="${CSS.escape(sessionId)}"]`
  )
  if (!host) return null
  for (const el of host.querySelectorAll<HTMLElement>('.chat-scroll')) {
    if (el.offsetParent !== null && el.querySelector('.chat-column')) return el
  }
  return null
}

// One registry for every pane: highlight names are global to the document, so
// each pane keeps its own ranges here and the two highlights are rebuilt from
// all of them.
const ALL = 'pane-search'
const CURRENT = 'pane-search-current'
export const byPane = new Map<string, { all: Range[]; current: Range | null }>()
export function paint(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  const all: Range[] = []
  const current: Range[] = []
  for (const entry of byPane.values()) {
    all.push(...entry.all)
    if (entry.current) current.push(entry.current)
  }
  if (all.length) CSS.highlights.set(ALL, new Highlight(...all))
  else CSS.highlights.delete(ALL)
  if (current.length) CSS.highlights.set(CURRENT, new Highlight(...current))
  else CSS.highlights.delete(CURRENT)
}

/** Every case-insensitive occurrence of `query` in an element's text, in
 *  document order, only inside elements matching `within` when given. Text
 *  inside hidden elements is skipped. */
export function findRanges(column: HTMLElement, query: string, within?: string): Range[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, textarea, input')) return NodeFilter.FILTER_REJECT
      if (within && !parent.closest(within)) return NodeFilter.FILTER_REJECT
      return parent.getClientRects().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue!.toLocaleLowerCase()
    let at = text.indexOf(needle)
    while (at !== -1) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
      at = text.indexOf(needle, at + needle.length)
    }
  }
  return ranges
}
