import type { RefObject } from 'react'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MagnifyingGlassIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { useShortcutLabel } from '../store/keymap-store'
import { usePaneSearchStore } from './pane-search'

/**
 * Find in one chat session: the field in that session's own header, beside
 * its title, so it reads as "search THIS conversation" rather than the
 * sidebar's search across sessions.
 *
 * The field only asks; the view searches (the chat-view plugin's
 * `useTranscriptSearch`, through `usePaneSearchStore`), because only the view
 * holds the whole conversation. While the query settles (the debounce) or
 * older history is read in, a small spinner stands where the count goes.
 * Enter goes to the next older match, Shift+Enter back towards the present,
 * Escape closes.
 */
export function PaneSearch({
  sessionId,
  open,
  onClose,
  inputRef
}: {
  sessionId: string
  open: boolean
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
}): React.JSX.Element | null {
  const find = usePaneSearchStore((s) => s.finds[sessionId])
  const { setQuery, stepFind } = usePaneSearchStore.getState()
  const shortcut = useShortcutLabel('focusSidebarSearch')
  if (!open) return null
  const query = find?.query ?? ''
  const result = find?.result
  const busy = !!result && (result.pending || result.paging)
  const status = !query.trim()
    ? ''
    : result?.paging
      ? 'Searching earlier…'
      : result?.pending
        ? ''
        : !result || result.total === 0
          ? result?.atStart
            ? 'No matches in this session'
            : 'No matches'
          : `${result.position} of ${result.total}${result.atStart ? ' · start' : ''}`
  return (
    <div
      className="pane-search"
      role="search"
      data-pane-search={sessionId}
      data-busy={busy ? 'true' : undefined}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <MagnifyingGlassIcon className="pane-search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(sessionId, e.target.value)}
        placeholder="Search this session"
        aria-label="Search this session"
        title={shortcut ? `Search this session (${shortcut})` : 'Search this session'}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            stepFind(sessionId, e.shiftKey ? 'newer' : 'older')
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      />
      {busy && <span className="pane-search-spinner" role="status" aria-label="Searching" />}
      {status && (
        <span className="pane-search-count" aria-live="polite">
          {status}
        </span>
      )}
      <button
        type="button"
        className="pane-search-btn"
        aria-label="Older match"
        title="Older match (Enter)"
        disabled={!query.trim() || !!result?.paging}
        onClick={() => stepFind(sessionId, 'older')}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        className="pane-search-btn"
        aria-label="Newer match"
        title="Newer match (Shift+Enter)"
        disabled={!query.trim() || !result?.total}
        onClick={() => stepFind(sessionId, 'newer')}
      >
        <ChevronDownIcon />
      </button>
      <button
        type="button"
        className="pane-search-btn"
        aria-label="Close search"
        title="Close search (Esc)"
        onClick={onClose}
      >
        <XMarkIcon />
      </button>
    </div>
  )
}
