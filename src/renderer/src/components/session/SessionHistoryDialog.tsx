import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ClockIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
  ShieldExclamationIcon,
  ClipboardDocumentIcon,
  PlayIcon
} from '@heroicons/react/24/outline'
import { useHistoryStore } from '../../store/history-store'
import { useSessionStore, inActiveWorkspace } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { resumeHistoryEntry } from '../../lib/session-history'
import { dotStateOf, visibleInWorkspace } from '../../lib/session-history-diff'
import { cn } from '@clave/ui/components'
import { shortenPath } from '../../lib/utils'
import { ContextMenu } from '../ui/ContextMenu'
import { entryInGroup } from '../../../../shared/history-group-match'
import type {
  HistoryListEntry,
  HistorySearchHit,
  HistorySearchScope
} from '../../../../preload/index.d'

/**
 * The session history (PRDCT-1738, reframed by PRDCT-1766): EVERY
 * conversation this Mac holds, one row each, scoped to the active workspace
 * by each conversation's own folder — the whole claude transcript store plus
 * the codex one, whether or not Clave ever ran it. The footer counts them by
 * provider, literally. Groups are FILTERS over that universe: a chip narrows
 * the list to the sessions that lived in that group (matched by id OR name —
 * group ids are minted at every launch), which the ledger knows. Click
 * resumes a claude conversation into the selected group, or focuses the tab
 * when it is still open; codex rows are listed and searchable but inert (no
 * resume exists today); a transcript Claude Code cleaned up stays listed,
 * greyed, with nothing to resume.
 *
 * One field does both depths: it filters the rows instantly (title, last
 * prompt, folder, group) and — when at least one scope toggle is on — also
 * searches INSIDE the transcripts of the rows in scope, streamed from the
 * main process, cancelled the moment the query or a toggle changes. Human
 * and Agent are on by default, Tools off; each is an independent toggle. A
 * row that matched only by text shows the excerpts that matched.
 *
 * Opened from a group's context menu (that group preselected) or ⌘⇧H (All).
 * Same surface as the group picker: a scrim, a panel, a search field in the
 * header, ONE quiet row of controls. The panel is keyed on the store's open
 * counter, so every open is a fresh read with the preset chip and an empty
 * filter.
 */

const TOGGLES: { key: HistorySearchScope; label: string; title: string }[] = [
  { key: 'human', label: 'Human', title: 'Search what you typed, inside the transcripts' },
  { key: 'agent', label: 'Agent', title: 'Search what the agent answered' },
  { key: 'tools', label: 'Tools', title: 'Search the tools it called: names, inputs, results' }
]

const SEARCH_MIN_CHARS = 2
const SEARCH_DEBOUNCE_MS = 250
const HITS_PER_ROW = 3

function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.round(d / 7)
  if (w < 5) return `${w}w ago`
  return new Date(then).toLocaleDateString()
}

/** One line of the last prompt: whitespace collapsed, cut for the row. */
function excerpt(text: string | null, max = 160): string | null {
  if (!text) return null
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return null
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The excerpt with the query marked, case-insensitively. */
function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  )
}

/** Request ids are matched in ONE main-process map across every window, so
 *  a per-window token keeps two windows' searches from cancelling each other. */
const WINDOW_TOKEN = Math.random().toString(36).slice(2, 10)
let searchSeq = 0

export function SessionHistoryDialog(): React.JSX.Element | null {
  const open = useHistoryStore((s) => s.open)
  const openSeq = useHistoryStore((s) => s.openSeq)
  const presetGroupId = useHistoryStore((s) => s.groupId)
  if (!open) return null
  return <HistoryPanel key={openSeq} presetGroupId={presetGroupId} />
}

function HistoryPanel({ presetGroupId }: { presetGroupId: string | null }): React.ReactPortal {
  const closeHistory = useHistoryStore((s) => s.closeHistory)
  const groups = useSessionStore((s) => s.groups)
  const sessions = useSessionStore((s) => s.sessions)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeRoot = workspaces.find((w) => w.id === activeWorkspaceId)?.rootDir ?? null

  const [entries, setEntries] = useState<HistoryListEntry[] | null>(null)
  const [groupId, setGroupId] = useState<string | null>(presetGroupId)
  const [query, setQuery] = useState('')
  /** The search's independent scope toggles: Human and Agent on by default. */
  const [scopes, setScopes] = useState<ReadonlySet<HistorySearchScope>>(
    () => new Set<HistorySearchScope>(['human', 'agent'])
  )
  /** Open tabs only. */
  const [openOnly, setOpenOnly] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: HistoryListEntry } | null>(null)

  // The transcript search: hits per session for the CURRENT request only,
  // and the totals once it ends. A request id per query keeps late batches
  // of a cancelled search from landing on the next one.
  const [hits, setHits] = useState<Map<string, HistorySearchHit[]>>(new Map())
  const [searchState, setSearchState] = useState<
    | { status: 'idle' }
    | { status: 'searching' }
    | { status: 'done'; files: number; truncated: boolean }
  >({ status: 'idle' })
  const requestRef = useRef<string | null>(null)

  // One read per open: the ledger, the whole claude store, the codex store.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .historyList()
      .then((r) => {
        if (!cancelled) setEntries(r.entries)
      })
      .catch((err) => {
        console.error('Failed to read the session history:', err)
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Escape closes the row's context menu when one is open (Radix dismisses
  // it on the same key), and only otherwise the dialog.
  const menuRef = useRef(menu)
  useEffect(() => {
    menuRef.current = menu
  }, [menu])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menuRef.current) setMenu(null)
      else closeHistory()
    }
    // Capture phase, registered at mount: Radix dismisses its menu from a
    // capture listener too, and React flushes that discrete update before
    // a bubble listener would run — which then saw no menu and closed the
    // dialog. Registered first, this one decides first.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [closeHistory])

  const chipGroups = useMemo(
    () =>
      groups
        .filter((g) => inActiveWorkspace(g, activeWorkspaceId))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [groups, activeWorkspaceId]
  )
  const selectedGroup = groupId ? (chipGroups.find((g) => g.id === groupId) ?? null) : null

  /** Live conversation → its run state, the sidebar's own words. Memoised on
   *  a STABLE signature, not on the sessions array: that array gets a fresh
   *  identity on every store update (activity, output, renames), and hanging
   *  the map — and therefore the search scope — off it cancelled and
   *  restarted a running transcript search on churn this very dialog renders. */
  const liveSignature = useMemo(
    () =>
      sessions
        .filter((s) => s.alive && (s.claudeSessionId || s.piSessionId))
        .map((s) => `${s.claudeSessionId ?? s.piSessionId}:${s.agentState ?? 'idle'}`)
        .sort()
        .join('|'),
    [sessions]
  )
  const liveStates = useMemo(
    () =>
      new Map<string, string>(
        liveSignature === ''
          ? []
          : liveSignature.split('|').map((pair) => {
              const at = pair.lastIndexOf(':')
              return [pair.slice(0, at), pair.slice(at + 1)] as const
            })
      ),
    [liveSignature]
  )

  // The rows in SCOPE: workspace and group, before any text. This is what a
  // transcript search reads, and what the field narrows.
  const inScope = useMemo(() => {
    if (!entries) return []
    return entries.filter((e) => {
      // A stamped entry by its workspace; an unstamped one (the seed, a
      // store-only transcript) by its own cwd against the workspace root.
      if (!visibleInWorkspace(e, activeWorkspaceId, activeRoot)) return false
      if (selectedGroup && !entryInGroup(e.groups, selectedGroup)) return false
      if (openOnly && !liveStates.has(e.claudeSessionId)) return false
      return true
    })
  }, [entries, selectedGroup, activeWorkspaceId, activeRoot, openOnly, liveStates])

  /** The literal counts line's numbers, over the rows in scope. */
  const counts = useMemo(() => {
    let claude = 0
    let codex = 0
    let antigravity = 0
    let pi = 0
    for (const e of inScope) {
      if (e.provider === 'codex') codex++
      else if (e.provider === 'pi') pi++
      else if (e.provider === 'antigravity') antigravity++
      else claude++
    }
    return { claude, codex, pi, antigravity }
  }, [inScope])

  const trimmed = query.trim()
  const searching = scopes.size > 0 && trimmed.length >= SEARCH_MIN_CHARS
  const searchIds = useMemo(
    () => inScope.filter((e) => e.transcript.exists).map((e) => e.claudeSessionId),
    [inScope]
  )
  /** The toggles as one stable string, so the search effect restarts only
   *  when the SET changes, never on a re-render. */
  const scopesKey = useMemo(() => [...scopes].sort().join(','), [scopes])

  // Hits arrive per file; only the current request's land.
  useEffect(() => {
    return window.electronAPI.onHistorySearchHits(({ requestId, hits: batch }) => {
      if (requestId !== requestRef.current) return
      setHits((prev) => {
        const next = new Map(prev)
        for (const h of batch)
          next.set(h.claudeSessionId, [...(next.get(h.claudeSessionId) ?? []), h])
        return next
      })
    })
  }, [])

  // Start (debounced) or stop the transcript search as the query, the
  // toggles or the rows in scope change; a change mid-search cancels the
  // running one.
  useEffect(() => {
    const cancelRunning = (): void => {
      if (requestRef.current) {
        window.electronAPI.historySearchCancel(requestRef.current)
        requestRef.current = null
      }
    }
    if (!searching) {
      cancelRunning()
      setHits(new Map())
      setSearchState({ status: 'idle' })
      return
    }
    const timer = setTimeout(() => {
      cancelRunning()
      const requestId = `history-${WINDOW_TOKEN}-${++searchSeq}`
      requestRef.current = requestId
      setHits(new Map())
      setSearchState({ status: 'searching' })
      window.electronAPI
        .historySearch({
          requestId,
          query: trimmed,
          scopes: scopesKey.split(',') as HistorySearchScope[],
          claudeSessionIds: searchIds
        })
        .then((done) => {
          if (requestRef.current !== requestId) return
          setSearchState({ status: 'done', files: done.filesSearched, truncated: done.truncated })
        })
        .catch((err) => {
          console.error('Transcript search failed:', err)
          if (requestRef.current === requestId) setSearchState({ status: 'idle' })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      cancelRunning()
    }
    // searchIds changes identity only when the scope's membership changes.
  }, [searching, trimmed, scopesKey, searchIds])

  /** The instant text match: title, last prompt, folder, group names. */
  const instantMatch = useCallback((e: HistoryListEntry, q: string): boolean => {
    if (!q) return true
    return [e.title, e.name, e.transcript.lastPrompt ?? '', e.cwd, ...e.groups.map((g) => g.name)]
      .join('\n')
      .toLowerCase()
      .includes(q)
  }, [])

  const rows = useMemo(() => {
    const q = trimmed.toLowerCase()
    // Typing narrows instantly by the row's own text; a running transcript
    // search ADDS the rows whose insides matched. With every toggle off the
    // field is a plain filter.
    const list = inScope.filter(
      (e) => instantMatch(e, q) || (searching && hits.has(e.claudeSessionId))
    )
    return list.sort((a, b) => b.lastHumanAt.localeCompare(a.lastHumanAt))
  }, [inScope, trimmed, searching, hits, instantMatch])

  const resume = useCallback(
    (entry: HistoryListEntry, dangerousMode: boolean) => {
      // Nothing to resume: a codex conversation (no resume exists), or a
      // claude one whose transcript or folder is gone while its tab is not
      // open. The dialog stays, the row's own title says why.
      if (entry.provider !== 'claude' && entry.provider !== 'pi') return
      if (!liveStates.has(entry.claudeSessionId) && (!entry.transcript.exists || !entry.cwd)) return
      closeHistory()
      void resumeHistoryEntry(entry, { groupId: selectedGroup?.id ?? null, dangerousMode })
    },
    [closeHistory, selectedGroup, liveStates]
  )

  const latestGroupName = (e: HistoryListEntry): string | null =>
    e.groups.length > 0 ? e.groups[e.groups.length - 1].name || null : null

  const countsLine = ((): string => {
    const parts = [`${counts.claude} claude session${counts.claude === 1 ? '' : 's'}`]
    parts.push(`${counts.codex} codex`)
    parts.push(`${counts.pi} pi`)
    if (counts.antigravity > 0) parts.push(`${counts.antigravity} antigravity`)
    return parts.join(' · ')
  })()

  const footer = ((): string => {
    if (!entries) return ' '
    if (searching) {
      if (searchState.status === 'searching')
        return `${countsLine} · searching ${searchIds.length} transcript${searchIds.length === 1 ? '' : 's'}…`
      if (searchState.status === 'done') {
        const n = [...hits.values()].reduce((a, b) => a + b.length, 0)
        // "· N shown" keeps the line honest: the instant text match can show
        // rows the transcript search found nothing in.
        return `${countsLine} · ${n} hit${n === 1 ? '' : 's'} in ${hits.size} of ${searchState.files} transcript${searchState.files === 1 ? '' : 's'}${searchState.truncated ? ' · stopped at the cap' : ''} · ${rows.length} shown`
      }
      return countsLine
    }
    if (trimmed) return `${countsLine} · ${rows.length} shown`
    return `${countsLine} · click to resume, ⌥-click to skip permissions`
  })()

  return createPortal(
    <div
      className="group-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Session history"
      data-history-dialog
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closeHistory()
      }}
    >
      <div className="group-picker-panel group-picker-panel--history">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
          <ClockIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          <h2 className="text-control font-medium text-text-primary">History</h2>
          <div className="search-field ml-2">
            <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && rows[0]) resume(rows[0], e.altKey)
              }}
              placeholder="Search every conversation…"
              aria-label="Search every conversation"
              spellCheck={false}
              data-history-filter
            />
            {query && (
              <button
                className="search-field-clear"
                onClick={() => setQuery('')}
                title="Clear search"
                aria-label="Clear search"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
            )}
          </div>
          <button className="panel-icon-btn" onClick={closeHistory} aria-label="Close">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="history-controls">
          <div className="history-controls-row">
            <div className="history-chips" role="tablist" aria-label="Groups">
              <button
                type="button"
                className="group-switcher-chip"
                data-history-chip="all"
                data-selected={groupId === null ? 'true' : undefined}
                onClick={() => setGroupId(null)}
              >
                All
              </button>
              {chipGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className="group-switcher-chip"
                  data-history-chip={g.id}
                  data-selected={g.id === groupId ? 'true' : undefined}
                  onClick={() => setGroupId(g.id === groupId ? null : g.id)}
                  title={`Sessions that lived in "${g.name}" — by group id or name`}
                >
                  {g.name}
                </button>
              ))}
              <button
                type="button"
                className="group-switcher-chip"
                data-history-open
                data-selected={openOnly ? 'true' : undefined}
                title="Only conversations open as a tab right now"
                onClick={() => setOpenOnly((v) => !v)}
              >
                Open
              </button>
            </div>
            <div className="history-chips history-chips--toggles" aria-label="Search inside">
              <span className="history-toggles-label">Search in</span>
              {TOGGLES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="switch"
                  aria-checked={scopes.has(t.key)}
                  className="group-switcher-chip"
                  data-history-scope={t.key}
                  data-selected={scopes.has(t.key) ? 'true' : undefined}
                  title={t.title}
                  onClick={() =>
                    setScopes((prev) => {
                      const next = new Set(prev)
                      if (next.has(t.key)) next.delete(t.key)
                      else next.add(t.key)
                      return next
                    })
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3" data-history-list>
          {entries === null ? (
            <p className="py-10 text-center text-xs text-text-tertiary">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-tertiary">
              {entries.length === 0
                ? 'No conversations yet. Sessions appear here as they run.'
                : searching && searchState.status === 'searching'
                  ? 'Searching…'
                  : searching
                    ? `Nothing matches "${trimmed}".`
                    : selectedGroup
                      ? `No sessions in "${selectedGroup.name}"${query ? ' match' : ''}.`
                      : 'No matching sessions.'}
            </p>
          ) : (
            rows.map((e) => {
              const live = liveStates.has(e.claudeSessionId)
              const dotState = dotStateOf(live, liveStates.get(e.claudeSessionId))
              const missing = !e.transcript.exists
              const inert = e.provider !== 'claude' && e.provider !== 'pi'
              const prompt = excerpt(e.transcript.lastPrompt)
              const gname =
                latestGroupName(e) ??
                (e.source === 'transcript' && e.cwd ? (e.cwd.split('/').pop() ?? null) : null)
              const rowHits = searching ? (hits.get(e.claudeSessionId) ?? []) : []
              return (
                <button
                  key={e.claudeSessionId}
                  type="button"
                  className="history-row"
                  data-history-row={e.claudeSessionId}
                  data-history-provider={e.provider}
                  data-live={live ? 'true' : undefined}
                  data-state={dotState}
                  data-missing={missing ? 'true' : undefined}
                  data-hits={searching ? rowHits.length : undefined}
                  onClick={(ev) => resume(e, ev.altKey)}
                  onContextMenu={(ev) => {
                    ev.preventDefault()
                    setMenu({ x: ev.clientX, y: ev.clientY, entry: e })
                  }}
                  title={
                    inert
                      ? `A ${e.provider} conversation — listed for the record; resume exists for claude sessions only.`
                      : missing
                        ? 'Transcript no longer on disk — Claude Code cleaned it up; nothing to resume.'
                        : live
                          ? 'Open — click to focus the tab'
                          : `Resume in ${selectedGroup?.name ?? 'the sidebar'} · ⌥-click to skip permissions`
                  }
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="history-dot flex-shrink-0"
                      data-state={dotState}
                      aria-label={dotState}
                    />
                    <span className="history-row-title truncate">{e.title}</span>
                    {inert && <span className="history-row-group flex-shrink-0">{e.provider}</span>}
                    {gname && <span className="history-row-group truncate">{gname}</span>}
                    <span className="history-row-time tabular-nums">
                      {relativeTime(e.lastHumanAt)}
                    </span>
                  </span>
                  {searching && rowHits.length > 0 ? (
                    rowHits.slice(0, HITS_PER_ROW).map((h, i) => (
                      <span key={i} className="history-hit truncate" data-history-hit>
                        <Highlight text={h.excerpt} query={trimmed} />
                      </span>
                    ))
                  ) : (
                    <span
                      className={cn(
                        'history-row-prompt truncate',
                        !prompt && 'history-row-prompt--none'
                      )}
                    >
                      {missing ? 'Transcript gone' : (prompt ?? shortenPath(e.cwd))}
                    </span>
                  )}
                  {searching && rowHits.length > HITS_PER_ROW && (
                    <span className="history-hit history-row-prompt--none">
                      +{rowHits.length - HITS_PER_ROW} more
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-1.5 px-4 py-2.5 border-t border-border-subtle text-[11px] text-text-tertiary/70">
          <span className="truncate" data-history-footer>
            {footer}
          </span>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          className="z-[70]"
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Resume',
              icon: <PlayIcon className="w-3.5 h-3.5" />,
              disabled:
                menu.entry.provider !== 'claude' ||
                ((!menu.entry.transcript.exists || !menu.entry.cwd) &&
                  !liveStates.has(menu.entry.claudeSessionId)),
              onClick: () => resume(menu.entry, false)
            },
            {
              label: 'Resume (skip permissions)',
              icon: <ShieldExclamationIcon className="w-3.5 h-3.5" />,
              disabled:
                menu.entry.provider !== 'claude' ||
                !menu.entry.transcript.exists ||
                !menu.entry.cwd,
              onClick: () => resume(menu.entry, true)
            },
            {
              label: 'Copy session id',
              icon: <ClipboardDocumentIcon className="w-3.5 h-3.5" />,
              onClick: () => void navigator.clipboard.writeText(menu.entry.claudeSessionId)
            }
          ]}
        />
      )}
    </div>,
    document.body
  )
}
