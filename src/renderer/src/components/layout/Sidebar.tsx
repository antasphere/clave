import { SessionViewBadge } from '../../views/registry'
import { emitTabClosed } from '../../lib/exchange-capture'
import { requestGroupDissolve } from '../../lib/group-dissolve'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useSessionStore,
  GROUP_TERMINAL_COLORS,
  resolveColorHex,
  inActiveWorkspace,
  type GroupTerminalColor
} from '../../store/session-store'
import { resolveGroupLaunchCwd } from '../../store/group-defaults'
import { useWorkspaceStore, getWorkspaceById } from '../../store/workspace-store'
import ColorPicker from '../ui/ColorPicker'
import { SessionItem as BaseSessionItem } from '../session/SessionItem'
import { FileTabItem } from '../session/FileTabItem'
import { SessionGroupItem } from '../session/SessionGroupItem'
import { ContextMenu } from '../ui/ContextMenu'
import { ConfirmDialog } from '@clave/ui/components'
import { GroupCommandDialog } from '../ui/GroupCommandDialog'
import { ExportClaveDialog } from '../ui/ExportClaveDialog'
import { cn } from '@clave/ui/components'
import { SectionHeading } from './SidebarSections'
import { WhatsNewBanner } from '../help/WhatsNewBanner'
import { TelemetryNoticeBanner } from '../help/TelemetryNoticeBanner'
import { FeedbackBanner, FeedbackDialogHost } from '../help/FeedbackBanner'
import { SessionLauncher } from './SessionLauncher'
import { GroupSwitcher, type SwitcherEntry } from './GroupSwitcher'
import { launchSession } from '../../lib/launch-session'
import { agentAcceptsPrompt, getLastAgentSetup, useLaunchPrefsStore } from '../../store/launch-prefs'
import { RemoteDirectoryPicker } from '../ui/RemoteDirectoryPicker'
import { useAgentStore } from '../../store/agent-store'
import { usePinnedStore, substituteTokens, pinGroupFromCurrent, removePinnedGroupWithCleanup, resyncPinnedGroup, findPinnedByGroupId, isPinnedOutOfSync, getHiddenGroupIds, revealGroup, spawnTemplate, exportClaveFile, getExportFileName } from '../../store/pinned-store'
import { PinnedGroupsGrid } from '../session/PinnedGroupsGrid'
import { GroupPickerDialog } from '../session/GroupPickerDialog'
import { useHistoryStore } from '../../store/history-store'
import { useSidebarDnd } from '../../hooks/use-sidebar-dnd'
import { SidebarFooter, UpdateBanner } from './SidebarFooter'
import { ClaudeAccountMenuHeader } from './ClaudeAccountMenuHeader'
import { accountSpawnFields, accountSessionFields } from '../../store/claude-profile-store'
import { primeClaudeAccountsUsage } from '../../store/usage-store'
import { WordmarkStrip } from './Wordmark'
import { ScrollArea } from '@clave/ui/components'
import { shortcutLabel } from '../../store/keymap-store'
import {
  PencilSquareIcon,
  TrashIcon,
  Squares2X2Icon,
  FolderMinusIcon,
  CommandLineIcon,
  ClockIcon,
  XMarkIcon,
  DocumentDuplicateIcon,
  BookmarkIcon,
  ArrowDownTrayIcon,
  PlayIcon,
  FolderIcon,
  ShieldExclamationIcon,
  ClipboardDocumentIcon,
  MagnifyingGlassIcon,
  WindowIcon,
  ArrowTopRightOnSquareIcon,
  GlobeAltIcon
} from '@heroicons/react/24/outline'

interface ContextMenuState {
  x: number
  y: number
  items: { label: string; onClick: () => void; shortcut?: string; disabled?: boolean; icon?: React.ReactNode; danger?: boolean }[]
  header?: React.ReactNode
}

function GroupColorPickerHeader({ groupId, initialColor }: { groupId: string; initialColor: GroupTerminalColor | null }) {
  const setGroupColor = useSessionStore((s) => s.setGroupColor)
  const currentColor = useSessionStore((s) => s.groups.find((g) => g.id === groupId)?.color ?? null)

  return (
    <ColorPicker
      value={currentColor ?? initialColor}
      onChange={(color) => setGroupColor(groupId, color)}
      showNoColor
    />
  )
}

/** Animated gap spacer for drop displacement */
function DropGap({ active, edge = 'before' }: { active: boolean; edge?: 'before' | 'after' }) {
  // The drop line takes NO space: a zero-height wrapper in the flow and a bar
  // drawn over the seam between rows. It used to be a 16px (once 36px) slot
  // inserted into the list, and every move of the line shifted the rows under
  // a cursor that had not moved — the hit-test then needed compensation for
  // gaps opening and closing, and still lost: hovering your own last row
  // closed the gap, the card shrank, and the cursor was "outside" it.
  return (
    <div
      className={cn(
        'sidebar-drop-gap relative h-0',
        edge === 'after' && 'sidebar-drop-gap--after',
        active && 'sidebar-drop-gap-active'
      )}
      aria-hidden
    >
      {active && <div className="sidebar-drop-line" />}
    </div>
  )
}

/** Check if a gap should show before an item (normalizes 'before X' and 'after previous') */
function shouldShowGapBefore(
  dropIndicator: { targetId: string; position: string } | null,
  itemId: string,
  prevItemId: string | null
): boolean {
  if (!dropIndicator) return false
  if (dropIndicator.targetId === itemId && dropIndicator.position === 'before') return true
  if (prevItemId && dropIndicator.targetId === prevItemId && dropIndicator.position === 'after') return true
  return false
}


/**
 * Whether a scroll viewport has more in it than fits — the question the foot
 * seam is the answer to. Measured rather than inferred from the session count:
 * a group unfolding, a banner appearing, or the window shrinking all change it
 * without changing what is in the list.
 *
 * Both the viewport AND the content wrapper Radix puts inside it are observed.
 * The viewport alone catches the window resizing and nothing else — its own box
 * does not move when a group unfolds three sessions inside it, which is exactly
 * the case the seam has to appear for.
 */
function useOverflows(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // A sub-pixel difference is a rounding artefact, not something to scroll.
    const measure = (): void => setOverflows(el.scrollHeight - el.clientHeight > 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    const content = el.firstElementChild
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [ref])
  return overflows
}

export function Sidebar() {
  // No traffic lights in fullscreen, so the wordmark's clearance for them goes.
  const sessions = useSessionStore((s) => s.sessions)
  const selectedSessionIds = useSessionStore((s) => s.selectedSessionIds)
  // When there's an active selection, unselected tabs/groups fade so the
  // selection stands out by contrast.
  const hasSelection = selectedSessionIds.length > 0
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const selectSessions = useSessionStore((s) => s.selectSessions)
  const addSession = useSessionStore((s) => s.addSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const groups = useSessionStore((s) => s.groups)
  const displayOrder = useSessionStore((s) => s.displayOrder)
  const createGroup = useSessionStore((s) => s.createGroup)
  const setGroupColor = useSessionStore((s) => s.setGroupColor)
  const toggleGroupCollapsed = useSessionStore((s) => s.toggleGroupCollapsed)
  const setGroupView = useSessionStore((s) => s.setGroupView)
  const setActiveGroupView = useSessionStore((s) => s.setActiveGroupView)
  const moveItems = useSessionStore((s) => s.moveItems)
  const addGroupTerminal = useSessionStore((s) => s.addGroupTerminal)
  const removeGroupTerminal = useSessionStore((s) => s.removeGroupTerminal)
  const setGroupTerminalSessionId = useSessionStore((s) => s.setGroupTerminalSessionId)
  const fileTabs = useSessionStore((s) => s.fileTabs)
  const removeFileTab = useSessionStore((s) => s.removeFileTab)
  const searchQuery = useSessionStore((s) => s.searchQuery)
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState<string | null>(null)
  const [terminalDialogState, setTerminalDialogState] = useState<{
    groupId: string
    terminalId: string | null // null = adding new
  } | null>(null)

  // Remote session picker state
  const [remotePickerState, setRemotePickerState] = useState<{
    locationId: string
    locationName: string
    claudeMode: boolean
    antigravityMode: boolean
    codexMode: boolean
  } | null>(null)

  const spawnRemoteSession = useCallback(async (
    locationId: string, cwd: string, claudeMode: boolean, antigravityMode?: boolean, codexMode?: boolean
  ) => {
    try {
      const shellId = await window.electronAPI.sshOpenShell(locationId, cwd)

      if (antigravityMode) {
        setTimeout(() => {
          window.electronAPI.sshShellWrite(shellId, 'agy\r')
        }, 500)
      } else if (codexMode) {
        setTimeout(() => {
          window.electronAPI.sshShellWrite(shellId, 'codex\r')
        }, 500)
      } else if (claudeMode) {
        // Write claude command after shell initializes (login shell needs time)
        setTimeout(() => {
          window.electronAPI.sshShellWrite(shellId, 'claude\r')
        }, 500)
      }

      const folderName = cwd.split('/').filter(Boolean).pop() || cwd

      addSession({
        id: shellId,
        cwd,
        folderName,
        name: folderName,
        alive: true,
        activityStatus: 'idle',
        promptWaiting: null,
        claudeMode: (antigravityMode || codexMode) ? false : claudeMode,
        antigravityMode: antigravityMode ?? false,
        codexMode: codexMode ?? false,
        dangerousMode: false,
        claudeSessionId: null,
        locationId,
        shellId,
        sessionType: claudeMode ? 'remote-claude' : 'remote-terminal'
      })
    } catch (err) {
      console.error('Failed to create remote session:', err)
    }
  }, [addSession])

  // Selection anchor for Cmd+Shift range select (Finder behavior)
  const selectionAnchorRef = useRef<string | null>(null)

  // Scroll container ref for DnD
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pinnedZoneRef = useRef<HTMLDivElement>(null)
  // Whether the list runs past the bottom of its viewport — what decides the
  // seam at the foot (see the rule under </ScrollArea>).
  const listOverflows = useOverflows(scrollContainerRef)

  // Handle drop on pinned zone
  const handlePinnedDrop = useCallback((groupId: string) => {
    const existing = findPinnedByGroupId(groupId)
    if (!existing) {
      pinGroupFromCurrent(groupId)
    }
    // If already pinned, do nothing (visual highlight was already shown)
  }, [])

  // Pointer-based DnD
  const { isDragging, draggedIds, dropIndicator, isOverPinnedZone, handlePointerDown } = useSidebarDnd({
    containerRef: scrollContainerRef,
    moveItems,
    pinnedZoneRef,
    onPinnedDrop: handlePinnedDrop
  })

  // Determine if dragging a group (for pinned zone drop target)
  const draggedGroupId = useMemo(() => {
    if (!isDragging || draggedIds.length !== 1) return null
    const isGroup = groups.some((g) => g.id === draggedIds[0])
    return isGroup ? draggedIds[0] : null
  }, [isDragging, draggedIds, groups])

  // Load Claude account profiles. (Workspace boot + .clave file watchers moved
  // to AppShell's sequential boot effect — adoption needs the registry first.)
  useEffect(() => {
    import('../../store/claude-profile-store').then(async ({ loadClaudeProfiles, useClaudeProfileStore }) => {
      await loadClaudeProfiles()
      // Every account's read, so the launcher's rows and the session menus
      // have a number the first time they open.
      void primeClaudeAccountsUsage(useClaudeProfileStore.getState().profiles.map((p) => p.id))
    })
  }, [])

  // Detect file drag over window (for showing pinned section as drop target).
  //
  // We deliberately avoid the classic dragenter/dragleave counter: those events
  // bubble per-element and must net out perfectly, but Chromium/Electron does
  // not reliably deliver the final dragleave/drop to `window` when a file drag
  // ends outside the normal flow (dragged back to Finder, ESC-cancelled, or
  // consumed by a child drop target). The counter then sticks > 0 and the drop
  // zone stays visible forever. Instead we debounce `dragover`, which fires
  // continuously while a file drag is over the window and stops the instant the
  // drag ends in any way — so the flag can never get stuck.
  const [isFileDragOverWindow, setIsFileDragOverWindow] = useState(false)
  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = null
      setIsFileDragOverWindow(false)
    }
    const handleDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      setIsFileDragOverWindow(true)
      if (clearTimer) clearTimeout(clearTimer)
      // If no dragover fires for a beat, the drag has ended — hide the zone.
      clearTimer = setTimeout(() => {
        clearTimer = null
        setIsFileDragOverWindow(false)
      }, 120)
    }
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      if (clearTimer) clearTimeout(clearTimer)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [])

  const aliveSessionIds = useMemo(
    () => new Set<string>(sessions.filter((s) => s.alive).map((s) => s.id)),
    [sessions]
  )

  // Track pinned group visibility to filter hidden groups from the sessions list
  const pinnedGroups = usePinnedStore((s) => s.pinnedGroups)
  const hiddenGroupIds = useMemo(() => getHiddenGroupIds(), [pinnedGroups])

  // Workspace scoping: the sidebar shows only the active workspace's world.
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  // Subscribing to the map (rather than calling the getter) is what re-renders
  // the group `+` rows when a launch changes the workspace's remembered agent.
  const launchPrefsByWorkspace = useLaunchPrefsStore((s) => s.byWorkspace)
  void launchPrefsByWorkspace
  // Whether a group's `+` will actually seed its prompt. `claude agents` refuses
  // a positional prompt, so with it remembered the `+` still launches — it just
  // cannot carry the brief, and the row has to say so rather than promise it.
  const groupPromptApplies = agentAcceptsPrompt(getLastAgentSetup(activeWorkspaceId))

  // Templates launcher popover (anchored to the Sessions header's folder-plus icon)
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  // The group switcher's filter — which group the list is narrowed to, null = All.
  // Deliberately component state, not store state: it is a way of looking at
  // the list, not a property of the workspace, and it should not survive a
  // restart the way a hidden group does.
  const [groupFilter, setGroupFilter] = useState<string | null>(null)

  // Sessions that exist only as the hidden half of something else — a group
  // terminal's shell, a session view's serving process. They must never render
  // as rows: the displayOrder path never contains them, but the no-order
  // fallback and the search catch-all enumerate `sessions` directly.
  const linkedHiddenIds = useMemo(() => {
    const ids = new Set<string>()
    for (const g of groups) {
      for (const t of g.terminals) if (t.sessionId) ids.add(t.sessionId)
    }
    for (const s of sessions) {
      if (s.view?.serverSessionId) ids.add(s.view.serverSessionId)
    }
    return ids
  }, [groups, sessions])

  // The groups the switcher offers, in list order. Built from the store with the
  // same predicates the list applies, NOT from displayItems: that goes null the
  // moment a search is running and empties out under the switcher's own filter,
  // so deriving from it would blank every chip at exactly the two moments the
  // switcher is being used.
  // Every group the workspace KNOWS ABOUT, not the handful currently running.
  // The pins are the source: a `.clave` workspace declares dozens of groups and
  // auto-discovers more from the tree, while only a few are ever spawned. Listing
  // only the live ones — which is what this did at first — makes a switcher that
  // can take you exactly where you already are, and leaves a declared group
  // reachable only through the picker dialog. Live groups with no pin are
  // appended so nothing on screen is missing from the panel.
  const switcherEntries = useMemo<SwitcherEntry[]>(() => {
    const entries: SwitcherEntry[] = []
    const claimed = new Set<string>()
    for (const pg of pinnedGroups) {
      if (!inActiveWorkspace(pg, activeWorkspaceId)) continue
      const live =
        pg.activeGroupId && groups.some((g) => g.id === pg.activeGroupId)
          ? pg.activeGroupId
          : null
      if (live) claimed.add(live)
      entries.push({
        key: `pin:${pg.id}`,
        name: pg.name,
        color: pg.color,
        liveGroupId: live,
        pinnedId: pg.id
      })
    }
    for (const g of groups) {
      if (claimed.has(g.id)) continue
      if (g.sessionIds.length === 0) continue
      if (!inActiveWorkspace(g, activeWorkspaceId)) continue
      entries.push({
        key: `group:${g.id}`,
        name: g.name,
        color: g.color ?? null,
        liveGroupId: g.id,
        pinnedId: null
      })
    }
    return entries
  }, [pinnedGroups, groups, activeWorkspaceId])

  // The same query narrows the chips and the session list below it: one question,
  // two views of the answer. Running groups sort ahead of idle ones so a match
  // you can act on now is the one Enter takes.
  const shownSwitcherEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    // At rest the panel shows only what is RUNNING — the switcher is for moving
    // between the groups you have going, and every declared group in a workspace
    // that auto-discovers the tree would bury those few under dozens you are not
    // using. Searching is the moment you are reaching past them, so that is the
    // moment the rest appear.
    if (!q) return switcherEntries.filter((e) => e.liveGroupId)
    const matched = switcherEntries.filter((e) => e.name.toLowerCase().includes(q))
    return [...matched].sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1
      if (aStarts !== bStarts) return aStarts - bStarts
      const aLive = a.liveGroupId ? 0 : 1
      const bLive = b.liveGroupId ? 0 : 1
      return aLive - bLive
    })
  }, [switcherEntries, searchQuery])

  const filteredSessions = useMemo(() => {
    if (!searchQuery) return null
    const q = searchQuery.toLowerCase()
    // Search deliberately ignores the switcher's filter and looks across every
    // group. Searching inside the current narrowing would only ever find what is
    // already on screen — the point of typing is to reach what is NOT.
    //
    // Every session in the workspace, taken straight from the store rather than
    // from the list's own visible set: that set drops the sessions of groups a
    // pinned toolbar toggle has hidden, so search could only ever find what was
    // already on screen — the opposite of what typing is for.
    const searchable = sessions.filter(
      (s) => !linkedHiddenIds.has(s.id) && inActiveWorkspace(s, activeWorkspaceId)
    )
    return searchable.filter((s) => {
      if (
        s.name.toLowerCase().includes(q) ||
        s.folderName.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q)
      ) {
        return true
      }
      // A group's name matches its sessions too, so typing a group's name is a
      // way to reach it — which is what Enter then acts on.
      const group = groups.find((g) => g.sessionIds.includes(s.id))
      return !!group && group.name.toLowerCase().includes(q)
    })
  }, [sessions, linkedHiddenIds, activeWorkspaceId, searchQuery, groups])

  // Picking a chip does one of two things. A group that is not running gets
  // spawned — the same act the picker dialog performs, which is where a declared
  // group had to be reached from before. A running one filters the list to it,
  // and back to All on a second click. Either way the query has done its job, so
  // it clears; leaving it set would keep the list showing matches rather than the
  // group just picked.
  const handleSwitcherPick = useCallback(
    (entry: SwitcherEntry) => {
      setSearchQuery('')
      if (!entry.liveGroupId) {
        if (entry.pinnedId) void spawnTemplate(entry.pinnedId)
        return
      }
      const liveId = entry.liveGroupId
      // A pinned toolbar toggle may be hiding it; picking a group has to produce
      // that group rather than an empty list with nothing to say why.
      revealGroup(liveId)
      setGroupFilter((current) => (current === liveId ? null : liveId))
    },
    [setSearchQuery]
  )

  const handleSwitcherAll = useCallback(() => {
    setSearchQuery('')
    setGroupFilter(null)
  }, [setSearchQuery])

  // Groups the query matched that are NOT running. They cannot appear among the
  // session results — they have no sessions yet — so they get a card of their own
  // below them, with the button that starts them.
  const idleSearchMatches = useMemo(
    () => (searchQuery.trim() ? shownSwitcherEntries.filter((e) => !e.liveGroupId) : []),
    [shownSwitcherEntries, searchQuery]
  )

  // Enter acts on the first chip the search left standing.
  const handleSearchSubmit = useCallback(() => {
    const first = shownSwitcherEntries[0]
    if (first) handleSwitcherPick(first)
    else setSearchQuery('')
  }, [shownSwitcherEntries, handleSwitcherPick, setSearchQuery])

  const isSearchMode = searchQuery.trim().length > 0

  // Build display list from displayOrder (or fall back to creation order)
  const displayItems = useMemo(() => {
    if (filteredSessions) return null

    const order =
      displayOrder.length > 0
        ? displayOrder
        : (() => {
            const items: string[] = []
            const placedGroups = new Set<string>()
            for (const session of sessions) {
              if (linkedHiddenIds.has(session.id)) continue
              const group = groups.find((g) => g.sessionIds.includes(session.id))
              if (group) {
                if (!placedGroups.has(group.id)) {
                  placedGroups.add(group.id)
                  items.push(group.id)
                }
              } else {
                items.push(session.id)
              }
            }
            return items
          })()

    return order
      .map((id) => {
        if (groups.some((g) => g.id === id)) return { type: 'group' as const, groupId: id }
        if (sessions.some((s) => s.id === id)) return { type: 'session' as const, sessionId: id }
        if (fileTabs.some((f) => f.id === id)) return { type: 'fileTab' as const, fileTabId: id }
        return null
      })
      .filter(
        (item): item is NonNullable<typeof item> => {
          if (item === null) return false
          if (item.type === 'session') {
            const session = sessions.find((s) => s.id === item.sessionId)
            return !!session && inActiveWorkspace(session, activeWorkspaceId)
          }
          // File tabs are lightweight viewers, deliberately global.
          if (item.type === 'fileTab') return true
          if (item.type === 'group') {
            const group = groups.find((g) => g.id === item.groupId)
            // An empty group stays on screen (it draws a "No sessions" row):
            // closing the last tab must not make the group vanish with it.
            if (!group) return false
            // Hide groups toggled off via pinned buttons
            if (hiddenGroupIds.has(item.groupId)) return false
            if (!inActiveWorkspace(group, activeWorkspaceId)) return false
            return true
          }
          return false
        }
      )
  }, [displayOrder, sessions, groups, fileTabs, filteredSessions, hiddenGroupIds, activeWorkspaceId, linkedHiddenIds])

  // A filter pointing at a group that has gone away — closed, emptied, or left
  // behind by a workspace switch — falls back to All rather than showing an
  // empty list whose only way out is a chip that is no longer there.
  const activeGroupFilter =
    groupFilter && groups.some((g) => g.id === groupFilter && g.sessionIds.length > 0)
      ? groupFilter
      : null

  // The switcher's filter, applied last so everything above it still sees the whole
  // list. Grouped sessions only: filtering to a group means the loose sessions
  // and the file tabs step aside too.
  const visibleItems = useMemo(() => {
    if (!displayItems) return null
    if (!activeGroupFilter) return displayItems
    return displayItems.filter(
      (item) => item.type === 'group' && item.groupId === activeGroupFilter
    )
  }, [displayItems, activeGroupFilter])

  // Flat ordered list of session/file tab IDs for range selection
  const flatSessionOrder = useMemo(() => {
    if (filteredSessions) return filteredSessions.map((s) => s.id)
    if (!visibleItems) return sessions.map((s) => s.id)
    const order: string[] = []
    for (const item of visibleItems) {
      if (item.type === 'session') {
        order.push(item.sessionId)
      } else if (item.type === 'fileTab') {
        order.push(item.fileTabId)
      } else {
        const group = groups.find((g) => g.id === item.groupId)
        if (group) order.push(...group.sessionIds)
      }
    }
    return order
  }, [filteredSessions, visibleItems, sessions, groups])

  // Live ref so row-facing handlers can read the current order without listing it
  // as a dependency. Keeping those handlers' identity stable lets the memoized row
  // components skip re-rendering when an unrelated session's status changes.
  const flatSessionOrderRef = useRef(flatSessionOrder)
  flatSessionOrderRef.current = flatSessionOrder

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const current = useSessionStore.getState()
      const session = current.sessions.find((s) => s.id === sessionId)
      if (session) emitTabClosed(session, current.groups, 'user', null)
      try {
        await window.electronAPI.killSession(sessionId)
      } catch {
        // session may already be dead
      }
      removeSession(sessionId)
    },
    [removeSession]
  )

  /** The group's own `+`: launch a session INTO this group, with the workspace's
   *  remembered agent setup, the GROUP's default prompt, and the directory the
   *  group's declared sessions open in — its cwd, because a group is about one
   *  place, unless the `.clave` anchored those sessions at the workspace root
   *  (`rootSession`), in which case the `+` lands there too. Either way the
   *  prompt's @-tokens resolve against the workspace root and the group's cwd,
   *  exactly as a pinned group's session prompts do. */
  const handleGroupNewSession = useCallback(async (groupId: string) => {
    const group = useSessionStore.getState().groups.find((g) => g.id === groupId)
    if (!group) return
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const root = getWorkspaceById(workspaceId)?.rootDir ?? null
    // Where the `+` lands: the group's own directory, unless the `.clave` it was
    // stamped from anchors its sessions at the workspace root. `group.cwd` stays
    // the project dir the prompt's @-tokens resolve against either way.
    // resolveGroupLaunchCwd owns the rule, pins included.
    const cwd = resolveGroupLaunchCwd(group, usePinnedStore.getState().pinnedGroups)
    await launchSession({
      setup: getLastAgentSetup(workspaceId),
      cwd,
      initialPrompt: group.prompt
        ? substituteTokens(group.prompt, root, group.cwd ?? root ?? '')
        : undefined,
      groupId
    })
  }, [])

  // Delete and Ungroup both dissolve the group and stop its quick-launch
  // terminals (lib/group-dissolve.ts owns what dies and when to ask first);
  // the confirmation, when one is due, is rendered by AppShell, which is
  // mounted whether or not this sidebar is.
  const handleDeleteGroup = useCallback((groupId: string) => {
    void requestGroupDissolve(groupId, 'delete')
  }, [])
  const handleUngroup = useCallback((groupId: string) => {
    void requestGroupDissolve(groupId, 'ungroup')
  }, [])

  // Spawn a group terminal and auto-focus it
  const spawnGroupTerminal = useCallback(
    async (groupId: string, terminalId: string, command: string, commandMode: 'prefill' | 'auto', cwdOverride?: string | null) => {
      const state = useSessionStore.getState()
      const group = state.groups.find((g) => g.id === groupId)
      if (!group) return

      const cwd = cwdOverride || group.cwd || state.sessions.find((s) => group.sessionIds.includes(s.id))?.cwd
      if (!cwd) return

      try {
        const sessionInfo = await window.electronAPI.spawnSession(cwd, {
          claudeMode: false,
          initialCommand: command || undefined,
          autoExecute: command ? commandMode === 'auto' : false,
          // Group terminals live in their group's workspace, not the active one.
          workspaceId: group.workspaceId ?? undefined,
          // Owner on the record: what brings it back inside the group next
          // launch instead of as a mystery tab beside it.
          link: { kind: 'group-terminal', groupId, terminalId }
        })
        const newSession = {
          id: sessionInfo.id,
          cwd: sessionInfo.cwd,
          folderName: sessionInfo.folderName,
          name: sessionInfo.folderName,
          alive: sessionInfo.alive,
          activityStatus: 'idle' as const,
          promptWaiting: null,
          claudeMode: false,
          dangerousMode: false,
          claudeSessionId: sessionInfo.claudeSessionId,
          sessionType: 'local' as const,
          workspaceId: group.workspaceId
        }

        const currentState = useSessionStore.getState()
        useSessionStore.setState({
          sessions: [...currentState.sessions, newSession],
          selectedSessionIds: [sessionInfo.id],
          focusedSessionId: sessionInfo.id
        })
        setGroupTerminalSessionId(groupId, terminalId, sessionInfo.id)
      } catch (err) {
        console.error('Failed to spawn group terminal:', err)
      }
    },
    [setGroupTerminalSessionId]
  )

  // Click a colored terminal icon: focus if alive, spawn if dead
  const handleTerminalIconClick = useCallback(
    (groupId: string, terminalId: string) => {
      const state = useSessionStore.getState()
      const group = state.groups.find((g) => g.id === groupId)
      const config = group?.terminals.find((t) => t.id === terminalId)
      if (!config) return

      if (config.sessionId) {
        const session = state.sessions.find((s) => s.id === config.sessionId && s.alive)
        if (session) {
          selectSession(config.sessionId, false)
          return
        }
      }

      spawnGroupTerminal(groupId, terminalId, config.command, config.commandMode, config.cwd)
    },
    [selectSession, spawnGroupTerminal]
  )

  // Click the grey/+ add icon: open dialog in "add" mode
  const handleAddTerminalClick = useCallback(
    (groupId: string) => {
      setTerminalDialogState({ groupId, terminalId: null })
    },
    []
  )

  // Right-click a terminal icon: show edit/delete context menu
  const handleTerminalIconContextMenu = useCallback(
    (groupId: string, terminalId: string, e: React.MouseEvent) => {
      const group = useSessionStore.getState().groups.find((g) => g.id === groupId)
      const config = group?.terminals.find((t) => t.id === terminalId)
      if (!config) return

      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Edit',
            icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => setTerminalDialogState({ groupId, terminalId })
          },
          // A terminal that declares a serverUrl can become the group's web
          // view: clicking the group then shows the served page in the main pane.
          ...(config.serverUrl
            ? [
                {
                  label: 'Use as group view',
                  icon: <GlobeAltIcon className="w-3.5 h-3.5" />,
                  onClick: () => {
                    setGroupView(groupId, {
                      url: config.serverUrl!,
                      title: config.command || undefined,
                      terminalId
                    })
                    setActiveGroupView(groupId)
                  }
                }
              ]
            : []),
          {
            label: 'Delete',
            icon: <TrashIcon className="w-3.5 h-3.5" />,
            danger: true,
            onClick: () => {
              if (config.sessionId) {
                window.electronAPI.killSession(config.sessionId).catch(() => {})
              }
              removeGroupTerminal(groupId, terminalId)
            }
          }
        ]
      })
    },
    [removeGroupTerminal, setGroupView, setActiveGroupView]
  )

  const hideAgentSession = useSessionStore((s) => s.hideAgentSession)

  const handleDuplicateSession = useCallback(
    async (sessionId: string) => {
      const state = useSessionStore.getState()
      const session = state.sessions.find((s) => s.id === sessionId)
      if (!session) return

      let newSessionId: string | null = null

      if (session.sessionType === 'remote-terminal' || session.sessionType === 'remote-claude') {
        if (session.locationId) {
          // spawnRemoteSession calls addSession internally, so we need to track the new ID.
          // Remote duplicates write `claude\r` bare and stay un-primed — carrying a prompt
          // would mean timing a write after the CLI boots; out of scope for v1.
          const shellId = await window.electronAPI.sshOpenShell(session.locationId, session.cwd)
          if (session.antigravityMode) {
            setTimeout(() => {
              window.electronAPI.sshShellWrite(shellId, 'agy\r')
            }, 500)
          } else if (session.codexMode) {
            setTimeout(() => {
              window.electronAPI.sshShellWrite(shellId, 'codex\r')
            }, 500)
          } else if (session.claudeMode) {
            setTimeout(() => {
              window.electronAPI.sshShellWrite(shellId, 'claude\r')
            }, 500)
          }
          const folderName = session.cwd.split('/').filter(Boolean).pop() || session.cwd
          addSession({
            id: shellId,
            cwd: session.cwd,
            folderName,
            name: folderName,
            alive: true,
            activityStatus: 'idle',
            promptWaiting: null,
            claudeMode: session.claudeMode,
            antigravityMode: session.antigravityMode,
            codexMode: session.codexMode,
            dangerousMode: false,
            claudeSessionId: null,
            locationId: session.locationId,
            shellId,
            sessionType: session.sessionType,
            detectedUrl: null
          })
          newSessionId = shellId
        }
      } else {
        // Local session
        try {
          const dupOtherProvider = session.antigravityMode || session.codexMode || session.piMode || session.claudeAgentsMode
          // A Claude account belongs to a Claude session of either kind:
          // `claude agents` takes the token like `claude` does (round 2 of
          // verification found the clone of an agents tab on the machine login).
          const dupClaudeKind = !(session.antigravityMode || session.codexMode || session.piMode)
          // Re-prime the clone with the same one-shot prompt (agent modes only;
          // `claude agents` rejects a positional prompt). Undefined for a normal
          // (un-primed) session → same as today.
          const initialPrompt = session.claudeAgentsMode ? undefined : session.initialPrompt || undefined
          const sessionInfo = await window.electronAPI.spawnSession(session.cwd, {
            claudeMode: dupOtherProvider ? false : session.claudeMode,
            antigravityMode: session.antigravityMode,
            codexMode: session.codexMode,
            piMode: session.piMode,
            claudeAgentsMode: session.claudeAgentsMode,
            dangerousMode: session.dangerousMode,
            model: session.model,
            launchProfileId: session.launchProfileId,
            piProvider: session.piProvider,
            piThinking: session.piThinking,
            initialPrompt,
            // The clone runs on its source's account: main reads the token by
            // this id at spawn, so leaving it out would put the clone on the
            // machine login while every readout still named the account.
            ...(dupClaudeKind ? accountSpawnFields(session) : {}),
            // A duplicate belongs where its source lives, not to the active view.
            workspaceId: session.workspaceId
          })
          addSession({
            id: sessionInfo.id,
            cwd: sessionInfo.cwd,
            folderName: sessionInfo.folderName,
            name: sessionInfo.folderName,
            alive: sessionInfo.alive,
            activityStatus: 'idle',
            promptWaiting: null,
            claudeMode: dupOtherProvider ? false : session.claudeMode,
            antigravityMode: session.antigravityMode,
            codexMode: session.codexMode,
            piMode: session.piMode,
            claudeAgentsMode: session.claudeAgentsMode,
            dangerousMode: session.dangerousMode,
            model: sessionInfo.model,
            workspaceId: session.workspaceId,
            claudeSessionId: sessionInfo.claudeSessionId,
            piSessionId: sessionInfo.piSessionId,
            launchProfileId: sessionInfo.launchProfileId,
            piProvider: sessionInfo.piProvider,
            piThinking: sessionInfo.piThinking,
            ...(dupClaudeKind ? accountSessionFields(session) : {}),
            // Persist so re-duplicating the clone also re-primes.
            initialPrompt,
            sessionType: 'local',
            detectedUrl: null
          })
          newSessionId = sessionInfo.id
        } catch (err) {
          console.error('Failed to duplicate session:', err)
        }
      }

      // A duplicate sits right after its original, wherever that is — inside
      // the group that holds it, or beside it at the top level. It is the one
      // launch that is ABOUT another row, so it is the one that does not go to
      // the top of the list with every other new session.
      if (newSessionId) {
        useSessionStore.getState().moveItems([newSessionId], sessionId, 'after')
      }
    },
    [addSession]
  )

  const handleResumeSession = useCallback(
    async (sessionId: string, dangerousMode: boolean) => {
      const state = useSessionStore.getState()
      const session = state.sessions.find((s) => s.id === sessionId)
      const conversationId = session?.piMode ? session.piSessionId : session?.claudeSessionId
      if (!session || !conversationId) return

      try {
        // Preserve the provider and resolved launch metadata from the original
        // run. Pi resume uses its historical provider/model/thinking while the
        // launch profile still contributes the current command and extra args.
        const isAgents = !!session.claudeAgentsMode
        const isPi = !!session.piMode
        const sessionInfo = await window.electronAPI.spawnSession(session.cwd, {
          claudeMode: !isAgents && !isPi,
          claudeAgentsMode: isAgents,
          piMode: isPi,
          dangerousMode: isPi ? false : dangerousMode,
          model: session.model,
          launchProfileId: session.launchProfileId,
          piProvider: session.piProvider,
          piThinking: session.piThinking,
          resumeSessionId: conversationId,
          // The conversation resumes on the account it ran on.
          ...(isPi ? {} : accountSpawnFields(session)),
          // The resumed conversation stays in its session's workspace.
          workspaceId: session.workspaceId
        })
        addSession({
          id: sessionInfo.id,
          cwd: sessionInfo.cwd,
          folderName: sessionInfo.folderName,
          name: session.name || sessionInfo.folderName,
          alive: sessionInfo.alive,
          activityStatus: 'idle',
          promptWaiting: null,
          claudeMode: !isAgents && !isPi,
          claudeAgentsMode: isAgents,
          piMode: isPi,
          dangerousMode: isPi ? false : dangerousMode,
          model: sessionInfo.model,
          workspaceId: session.workspaceId,
          claudeSessionId: sessionInfo.claudeSessionId,
          piSessionId: sessionInfo.piSessionId,
          launchProfileId: sessionInfo.launchProfileId,
          piProvider: sessionInfo.piProvider,
          piThinking: sessionInfo.piThinking,
          ...(isPi ? {} : accountSessionFields(session)),
          sessionType: 'local'
        })
        useSessionStore.getState().selectSession(sessionInfo.id, false)
        useSessionStore.getState().setFocusedSession(sessionInfo.id)
      } catch (err) {
        console.error('Failed to resume session:', err)
      }
    },
    [addSession]
  )

  /** "Move to window …" entries for a session or a group: one per OTHER open
   *  window (named by the workspace it shows), plus a new window on this
   *  workspace. A move keeps the tab's id and scrollback (tmux-backed tabs
   *  only — main refuses the rest, and the tab simply stays). */
  const moveToWindowItems = useCallback(
    async (move: (targetWindowId: number) => Promise<unknown>): Promise<ContextMenuState['items']> => {
      const api = window.electronAPI
      if (!api?.windowList) return []
      const { windowId: mine, workspaces } = useWorkspaceStore.getState()
      const list = await api.windowList().catch(() => [])
      const nameOf = (wsId: string | null): string =>
        workspaces.find((w) => w.id === wsId)?.name ?? 'No workspace'
      const items: ContextMenuState['items'] = list
        .filter((w) => w.windowId !== mine)
        .map((w) => ({
          label: `Move to window ${w.windowId} · ${nameOf(w.workspaceId)}`,
          icon: <WindowIcon className="w-3.5 h-3.5" />,
          onClick: () => {
            void move(w.windowId)
          }
        }))
      items.push({
        label: 'Move to new window',
        icon: <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />,
        onClick: () => {
          void api.windowOpen?.().then((res) => {
            if (res?.windowId !== undefined) {
              // The new renderer needs a moment to boot before it can adopt.
              setTimeout(() => void move(res.windowId), 2500)
            }
          })
        }
      })
      return items
    },
    []
  )

  const moveSessionToWindow = useCallback((sessionId: string, targetWindowId: number) => {
    return window.electronAPI?.windowMoveSessions?.([sessionId], targetWindowId) ?? Promise.resolve()
  }, [])

  const moveGroupToWindow = useCallback((groupId: string, targetWindowId: number) => {
    const group = useSessionStore.getState().groups.find((g) => g.id === groupId)
    if (!group) return Promise.resolve()
    // Hand main a plain copy: the store object carries nothing main needs
    // beyond its fields, and the target window re-creates it from these.
    // Terminal links stay: their live sessions travel with the group.
    const plain = {
      ...group,
      sessionIds: [...group.sessionIds],
      terminals: group.terminals.map((t) => ({ ...t }))
    }
    return window.electronAPI?.windowMoveGroup?.(plain, targetWindowId) ?? Promise.resolve()
  }, [])

  const handleSessionContextMenu = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.preventDefault()
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)

      // Agent-specific context menu
      if (session?.sessionType === 'agent') {
        const items: ContextMenuState['items'] = [
          {
            label: 'Rename',
            icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => setRenamingId(sessionId)
          },
          {
            label: 'Hide from sidebar',
            icon: <XMarkIcon className="w-3.5 h-3.5" />,
            onClick: () => hideAgentSession(sessionId)
          },
          {
            label: 'Clear messages',
            icon: <TrashIcon className="w-3.5 h-3.5" />,
            onClick: () => {
              if (session.agentId) useAgentStore.getState().clearMessages(session.agentId)
            }
          }
        ]
        setContextMenu({ x: e.clientX, y: e.clientY, items })
        return
      }

      const items: ContextMenuState['items'] = [
        {
          label: 'Rename',
          icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
          onClick: () => setRenamingId(sessionId)
        },
        {
          label: 'Duplicate',
          icon: <DocumentDuplicateIcon className="w-3.5 h-3.5" />,
          onClick: () => handleDuplicateSession(sessionId)
        }
      ]
      // A Claude session says which account it runs on, and how much of that
      // account is left, at the top of its menu: the one place to look when a
      // window runs out and the question is "which subscription is this on".
      const header =
        session && (session.claudeMode || session.claudeAgentsMode) ? (
          <ClaudeAccountMenuHeader session={session} />
        ) : undefined
      if (session && !session.alive && ((session.claudeMode && session.claudeSessionId) || (session.piMode && session.piSessionId))) {
        items.push(
          {
            label: 'Resume',
            icon: <PlayIcon className="w-3.5 h-3.5" />,
            onClick: () => handleResumeSession(sessionId, false)
          },
          ...(session.piMode
            ? []
            : [{
                label: 'Resume (skip permissions)',
                icon: <ShieldExclamationIcon className="w-3.5 h-3.5" />,
                onClick: () => handleResumeSession(sessionId, true)
              }])
        )
      }
      const state = useSessionStore.getState()
      if (state.selectedSessionIds.length >= 1) {
        items.push({
          label: 'Group',
          icon: <Squares2X2Icon className="w-3.5 h-3.5" />,
          shortcut: shortcutLabel('groupSelectedSessions') ?? undefined,
          onClick: () => createGroup(state.selectedSessionIds)
        })
      }
      items.push({
        label: 'Delete',
        icon: <TrashIcon className="w-3.5 h-3.5" />,
        danger: true,
        onClick: () => handleDeleteSession(sessionId)
      })
      const { clientX: x, clientY: y } = e
      setContextMenu({ x, y, items, header })
      // The window entries arrive a beat later (main is asked which windows
      // exist); the menu re-renders in place with them appended.
      if (session?.alive) {
        void moveToWindowItems((target) => moveSessionToWindow(sessionId, target)).then((extra) => {
          if (extra.length === 0) return
          setContextMenu((current) =>
            current && current.x === x && current.y === y
              ? { ...current, items: [...items.slice(0, -1), ...extra, items[items.length - 1]] }
              : current
          )
        })
      }
    },
    [createGroup, handleDeleteSession, handleDuplicateSession, handleResumeSession, hideAgentSession, moveToWindowItems, moveSessionToWindow]
  )

  const handleGroupContextMenu = useCallback(
    (e: React.MouseEvent, groupId: string) => {
      e.preventDefault()
      const group = useSessionStore.getState().groups.find((g) => g.id === groupId)
      const currentColor = group?.color ?? null
      const existingPin = findPinnedByGroupId(groupId)
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        header: (
          <GroupColorPickerHeader
            groupId={groupId}
            initialColor={currentColor}
          />
        ),
        items: [
          existingPin
            ? isPinnedOutOfSync(groupId)
              ? {
                  label: 'Re-sync pin',
                  icon: <BookmarkIcon className="w-3.5 h-3.5" />,
                  onClick: () => resyncPinnedGroup(groupId)
                }
              : null
            : {
                label: 'Pin group',
                icon: <BookmarkIcon className="w-3.5 h-3.5" />,
                onClick: () => pinGroupFromCurrent(groupId)
              },
          {
            label: 'Rename',
            icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => setRenamingId(groupId)
          },
          {
            label: 'Add terminal',
            icon: <CommandLineIcon className="w-3.5 h-3.5" />,
            onClick: () => setTerminalDialogState({ groupId, terminalId: null })
          },
          {
            label: 'History',
            icon: <ClockIcon className="w-3.5 h-3.5" />,
            shortcut: shortcutLabel('openHistory') ?? undefined,
            onClick: () => useHistoryStore.getState().openHistory(groupId)
          },
          group?.view
            ? {
                label: 'Show web view',
                icon: <GlobeAltIcon className="w-3.5 h-3.5" />,
                onClick: () => setActiveGroupView(groupId)
              }
            : null,
          group?.view
            ? {
                label: 'Detach web view',
                icon: <GlobeAltIcon className="w-3.5 h-3.5" />,
                onClick: () => setGroupView(groupId, null)
              }
            : null,
          {
            label: 'Ungroup',
            icon: <FolderMinusIcon className="w-3.5 h-3.5" />,
            onClick: () => handleUngroup(groupId)
          },
          {
            label: 'Delete',
            icon: <TrashIcon className="w-3.5 h-3.5" />,
            danger: true,
            onClick: () => handleDeleteGroup(groupId)
          }
        ].filter((item): item is NonNullable<typeof item> => item !== null)
      })
      const { clientX: x, clientY: y } = e
      void moveToWindowItems((target) => moveGroupToWindow(groupId, target)).then((extra) => {
        if (extra.length === 0) return
        setContextMenu((current) =>
          current && current.x === x && current.y === y
            ? {
                ...current,
                items: [...current.items.slice(0, -1), ...extra, current.items[current.items.length - 1]]
              }
            : current
        )
      })
    },
    [handleUngroup, handleDeleteGroup, setGroupColor, setGroupView, setActiveGroupView, moveToWindowItems, moveGroupToWindow]
  )

  const handleFileTabContextMenu = useCallback(
    (e: React.MouseEvent, fileTabId: string) => {
      e.preventDefault()
      const fileTab = useSessionStore.getState().fileTabs.find((f) => f.id === fileTabId)
      if (!fileTab) return
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Rename',
            icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => setRenamingId(fileTabId)
          },
          {
            label: 'Copy Path',
            icon: <ClipboardDocumentIcon className="w-3.5 h-3.5" />,
            onClick: () => navigator.clipboard.writeText(fileTab.filePath)
          },
          {
            label: 'Reveal in Finder',
            icon: <MagnifyingGlassIcon className="w-3.5 h-3.5" />,
            onClick: () => window.electronAPI?.showItemInFolder(fileTab.filePath)
          },
          {
            label: 'Close',
            icon: <XMarkIcon className="w-3.5 h-3.5" />,
            danger: true,
            onClick: () => removeFileTab(fileTabId)
          }
        ]
      })
    },
    [removeFileTab]
  )

  // Finder-style session click: Click=single, Cmd=toggle, Shift=range, Cmd+Shift=range-add
  const handleSessionClick = useCallback(
    (sessionId: string, modifiers: { metaKey: boolean; shiftKey: boolean }) => {
      // Agent sessions → switch to chat panel
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (session?.sessionType === 'agent' && session.agentId) {
        useAgentStore.getState().setActiveAgent(session.agentId)
        selectSession(sessionId, false) // selectSession sets activeView to 'agents' for agent sessions
        selectionAnchorRef.current = sessionId
        return
      }

      if (modifiers.shiftKey) {
        // Range select from anchor
        const anchorId = selectionAnchorRef.current
        if (!anchorId) {
          selectSession(sessionId, false)
          selectionAnchorRef.current = sessionId
          return
        }
        const anchorIdx = flatSessionOrderRef.current.indexOf(anchorId)
        const targetIdx = flatSessionOrderRef.current.indexOf(sessionId)
        if (anchorIdx === -1 || targetIdx === -1) {
          selectSession(sessionId, false)
          selectionAnchorRef.current = sessionId
          return
        }
        const start = Math.min(anchorIdx, targetIdx)
        const end = Math.max(anchorIdx, targetIdx)
        const rangeIds = flatSessionOrderRef.current.slice(start, end + 1)
        if (modifiers.metaKey) {
          // Cmd+Shift: add range to existing selection
          const state = useSessionStore.getState()
          const merged = [...new Set([...state.selectedSessionIds, ...rangeIds])]
          selectSessions(merged)
        } else {
          // Shift only: replace selection with range
          selectSessions(rangeIds)
        }
        // Don't update anchor on shift-click
      } else if (modifiers.metaKey) {
        // Cmd+Click: toggle individual
        selectSession(sessionId, true)
        selectionAnchorRef.current = sessionId
      } else {
        // Plain click: single select
        selectSession(sessionId, false)
        selectionAnchorRef.current = sessionId
      }
    },
    [selectSession, selectSessions]
  )

  const handleGroupClick = useCallback(
    (groupId: string, modifiers: { metaKey: boolean; shiftKey: boolean }) => {
      const state = useSessionStore.getState()
      const group = state.groups.find((g) => g.id === groupId)
      if (!group) return
      if (modifiers.metaKey) {
        // Cmd+Click: toggle all sessions in group
        const allSelected = group.sessionIds.every((id) => state.selectedSessionIds.includes(id))
        if (allSelected) {
          selectSessions(state.selectedSessionIds.filter((id) => !group.sessionIds.includes(id)))
        } else {
          selectSessions([
            ...state.selectedSessionIds,
            ...group.sessionIds.filter((id) => !state.selectedSessionIds.includes(id))
          ])
        }
        if (group.sessionIds.length > 0) {
          selectionAnchorRef.current = group.sessionIds[0]
        }
      } else {
        // Vacuously true for an empty group, on purpose: with nothing to
        // select, a click on the header takes the "already selected" path —
        // open its view if it has one, else fold and unfold the card.
        const allSelected = group.sessionIds.every((id) => state.selectedSessionIds.includes(id))
        if (group.collapsed) {
          // Collapsed group: expand it and select
          toggleGroupCollapsed(group.id)
          selectSessions(group.sessionIds)
          if (group.view) setActiveGroupView(group.id)
        } else if (allSelected) {
          if (group.view && state.activeGroupViewId !== group.id) {
            // Selected but showing the mosaic: bring the attached view back
            // before any collapse.
            selectSessions(group.sessionIds)
            setActiveGroupView(group.id)
          } else {
            // Already selected and expanded: collapse it
            toggleGroupCollapsed(group.id)
          }
        } else {
          // Not selected: select it — a group carrying a view opens on it
          selectSessions(group.sessionIds)
          if (group.view) setActiveGroupView(group.id)
        }
        if (group.sessionIds.length > 0) {
          selectionAnchorRef.current = group.sessionIds[0]
        }
      }
    },
    [selectSessions, toggleGroupCollapsed, setActiveGroupView]
  )

  const clearRenaming = useCallback(() => setRenamingId(null), [])

  // Get the top-level item ID for gap calculation
  const getItemId = useCallback((item: { type: string; sessionId?: string; fileTabId?: string; groupId?: string }) => {
    if (item.type === 'session') return item.sessionId ?? ''
    if (item.type === 'fileTab') return item.fileTabId ?? ''
    if (item.type === 'group') return item.groupId ?? ''
    return ''
  }, [])

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* The app's draggable top band — the traffic-light clearance, the mark,
          and the offset the first panel below it starts at. Shared with the
          Settings and Extensions sidebars, which replace this one whole; see
          Wordmark.tsx. */}
      <WordmarkStrip />

      {/* Session launcher — pinned above the scroll area so it never scrolls
          away with the session list. (The workspace switcher used to sit here;
          it lives in the toolbar now, behind the workspace name.) */}
      <div className="px-2 flex-shrink-0">
        <SessionLauncher onRemoteLaunch={setRemotePickerState} />
      </div>

      {/* Group switcher — pinned under the launcher for the same reason: the way to
          get back to All must not scroll away with the list it narrowed. */}
      <div className="px-2 pt-1 flex-shrink-0">
        <GroupSwitcher
          entries={shownSwitcherEntries}
          value={activeGroupFilter}
          onPick={handleSwitcherPick}
          onAll={handleSwitcherAll}
          onAddGroup={() => setGroupPickerOpen(true)}
          addGroupActive={groupPickerOpen}
          search={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchSubmit={handleSearchSubmit}
        />
      </div>

      {/* The seam the list scrolls under. The switcher above is pinned, so the
          cards pass BEHIND it — and with nothing between them they slid up into
          its bottom border, which made the panel read as the first row of the
          list rather than as the chrome the list runs under. The launcher and
          the switcher are held apart by 4px; this is the same 4px, closed by a
          hairline that gives the scroll somewhere to end. */}
      <div className="sidebar-list-seam flex-shrink-0" />

      {/* Single scrollable area for all sections */}
      <ScrollArea
        viewportRef={scrollContainerRef}
        className="flex-1 min-h-0"
      >
        {
          <>
            {/* Sessions section — the group picker opens full screen from the
                switcher's `+` above (it used to sit here, beside this heading);
                the inline pinned grid only appears as a drop target while
                dragging.

                This used to be gated on !isSearchMode, which meant the search
                branch below it could never render: typing set searchQuery, the
                gate closed, and the results it had already computed went with
                it. The gate now hides only the pinned drop zone, which is the
                one part that has nothing to say about a set of results. */}
            <SectionHeading title={isSearchMode ? 'Results' : 'Sessions'} />
            {!isSearchMode && (
              <PinnedSection
                setContextMenu={setContextMenu}
                pinnedZoneRef={pinnedZoneRef}
                isOverPinnedZone={isOverPinnedZone}
                draggedGroupId={draggedGroupId}
                isFileDragOver={isFileDragOverWindow}
                groupPickerOpen={groupPickerOpen}
                onCloseGroupPicker={() => setGroupPickerOpen(false)}
              />
            )}
            <div>
              {/* 6px between top-level items: room for the drop line to sit
                  between two cards with air on both sides of it. */}
              <div className="px-2 space-y-1.5" style={{ '--drop-seam': '6px' } as React.CSSProperties}>
                {filteredSessions ? (
                  <>
                    {filteredSessions.length === 0 && idleSearchMatches.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-text-tertiary">
                        No matching sessions
                      </div>
                    ) : (
                      filteredSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          isSelected={selectedSessionIds.includes(session.id)}
                          onClick={(modifiers) => handleSessionClick(session.id, modifiers)}
                          onContextMenu={(e) => handleSessionContextMenu(e, session.id)}
                          forceEditing={renamingId === session.id}
                          onEditingDone={clearRenaming}
                          onDelete={() => setDeleteConfirmSessionId(session.id)}
                        />
                      ))
                    )}

                    {/* Groups the query matched that are not running. They have no
                        sessions to appear among the results, so each gets a card
                        of its own — a group shown closed, with the button that
                        starts it. Starting one puts it in the switcher's chips and
                        its sessions in this list, which is the whole point: a
                        declared group was previously reachable only by leaving the
                        sidebar for the picker dialog. */}
                    {idleSearchMatches.length > 0 && (
                      <div className={filteredSessions.length > 0 ? 'pt-2' : undefined}>
                        <div className="idle-group-label">Not running</div>
                        <div className="space-y-0.5">
                          {idleSearchMatches.map((entry) => {
                            const hex = resolveColorHex(entry.color)
                            return (
                              <div
                                key={entry.key}
                                className="group-scope idle-group-card rounded-xl border"
                                style={
                                  hex
                                    ? ({
                                        '--group-bg': `${hex}10`,
                                        '--group-bg-hover': `${hex}24`,
                                        '--group-border': `${hex}30`,
                                        '--group-hover-bg': `${hex}2e`
                                      } as React.CSSProperties)
                                    : undefined
                                }
                              >
                                <FolderIcon className="sidebar-tab-icon flex-shrink-0" />
                                <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-text-secondary">
                                  {entry.name}
                                </span>
                                <button
                                  className="idle-group-start"
                                  onClick={() => handleSwitcherPick(entry)}
                                  title={`Start ${entry.name}`}
                                  aria-label={`Start ${entry.name}`}
                                >
                                  <PlayIcon className="w-3 h-3 flex-shrink-0" />
                                  <span>Start</span>
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : visibleItems ? (
                  <>
                    {visibleItems.map((item, index) => {
                      const itemId = getItemId(item)
                      const prevItemId = index > 0 ? getItemId(visibleItems[index - 1]) : null
                      const isLastItem = index === visibleItems.length - 1
                      const gapBefore = isDragging && shouldShowGapBefore(dropIndicator, itemId, prevItemId)

                      if (item.type === 'fileTab') {
                        const fileTab = fileTabs.find((f) => f.id === item.fileTabId)
                        if (!fileTab) return null
                        return (
                          <div key={fileTab.id}>
                            <DropGap active={gapBefore} />
                            <FileTabItem
                              fileTab={fileTab}
                              isSelected={selectedSessionIds.includes(fileTab.id)}
                              dimmed={hasSelection && !selectedSessionIds.includes(fileTab.id)}
                              onClick={(modifiers) => handleSessionClick(fileTab.id, modifiers)}
                              onContextMenu={(e) => handleFileTabContextMenu(e, fileTab.id)}
                              forceEditing={renamingId === fileTab.id}
                              onEditingDone={clearRenaming}
                              onPointerDown={(e) => handlePointerDown(e, fileTab.id, false)}
                              isDragging={draggedIds.includes(fileTab.id)}
                            />
                            {isLastItem && (
                              <DropGap
                                edge="after"
                                active={isDragging && dropIndicator?.targetId === itemId && dropIndicator?.position === 'after'}
                              />
                            )}
                          </div>
                        )
                      } else if (item.type === 'session') {
                        const session = sessions.find((s) => s.id === item.sessionId)
                        if (!session) return null
                        return (
                          <div key={session.id}>
                            <DropGap active={gapBefore} />
                            <SessionItem
                              session={session}
                              isSelected={selectedSessionIds.includes(session.id)}
                              dimmed={hasSelection && !selectedSessionIds.includes(session.id)}
                              onClick={(modifiers) => handleSessionClick(session.id, modifiers)}
                              onContextMenu={(e) => handleSessionContextMenu(e, session.id)}
                              forceEditing={renamingId === session.id}
                              onEditingDone={clearRenaming}
                              onPointerDown={(e) => handlePointerDown(e, session.id, false)}
                              isDragging={draggedIds.includes(session.id)}
                              onDelete={() => setDeleteConfirmSessionId(session.id)}
                            />
                            {isLastItem && (
                              <DropGap
                                edge="after"
                                active={isDragging && dropIndicator?.targetId === itemId && dropIndicator?.position === 'after'}
                              />
                            )}
                          </div>
                        )
                      } else {
                        const group = groups.find((g) => g.id === item.groupId)
                        if (!group) return null
                        const allGroupSelected =
                          group.sessionIds.length > 0 &&
                          group.sessionIds.every((id) => selectedSessionIds.includes(id))
                        const groupColorHex = resolveColorHex(group.color)
                        const railEmpty = group.sessionIds.length === 0
                        return (
                          <div key={group.id}>
                            <DropGap active={gapBefore} />
                            <div
                              // Same outer width as ungrouped tabs (no bleed). Child-tab
                              // highlights are inset instead (see grouped children container)
                              // so they don't feel like they touch the card border.
                              className="group-scope relative rounded-xl border transition-colors"
                              data-selected={allGroupSelected ? 'true' : undefined}
                              // The group publishes its colour as a small set of
                              // finished fills, and .group-scope in main.css draws
                              // every state from them — the card at rest, the card
                              // under a header hover, and every hover/selected fill
                              // of the controls INSIDE it. Publishing beats painting
                              // from here: hovering the header has to light the whole
                              // card, which an inline background on this div can only
                              // do by fighting CSS, and the grey button fills within
                              // had no way to learn the colour at all. A colourless
                              // group publishes nothing and the fallbacks hold.
                              style={groupColorHex ? ({
                                '--group-bg': `${groupColorHex}10`,
                                '--group-bg-hover': `${groupColorHex}24`,
                                '--group-bg-selected': `${groupColorHex}35`,
                                '--group-border': `${groupColorHex}30`,
                                '--group-border-selected': `${groupColorHex}60`,
                                '--group-hover-bg': `${groupColorHex}2e`,
                                '--group-active-bg': `${groupColorHex}4d`
                              } as React.CSSProperties) : undefined}
                            >
                              {dropIndicator?.targetId === group.id && dropIndicator?.position === 'inside' && (
                                <div className="absolute inset-0 rounded-xl border-2 border-accent pointer-events-none z-10 transition-opacity duration-150" />
                              )}
                              <SessionGroupItem
                                group={group}
                                onClick={(modifiers) => handleGroupClick(group.id, modifiers)}
                                onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
                                onTerminalIconClick={(tid) => handleTerminalIconClick(group.id, tid)}
                                onTerminalIconContextMenu={(tid, e) => handleTerminalIconContextMenu(group.id, tid, e)}
                                onAddTerminalClick={() => handleAddTerminalClick(group.id)}
                                onNewSession={() => void handleGroupNewSession(group.id)}
                                newSessionTitle={
                                  !group.prompt
                                    ? `New session in ${group.name}`
                                    : groupPromptApplies
                                      ? `New session in ${group.name} — starts on the group's prompt`
                                      : `New session in ${group.name} — Claude Agents can't take the group's prompt`
                                }
                                aliveSessionIds={aliveSessionIds}
                                focusedSessionId={focusedSessionId}
                                allSelected={allGroupSelected}
                                dimmed={hasSelection && !allGroupSelected}
                                forceEditing={renamingId === group.id}
                                onEditingDone={clearRenaming}
                                onPointerDown={(e) => handlePointerDown(e, group.id, true)}
                                isDragging={draggedIds.includes(group.id)}
                                dragActive={isDragging}
                              />
                              {/* Shut only when collapsed. A group with no rows
                                  keeps its rail open on a "No sessions" row of
                                  a session row's exact height, so an emptied
                                  group stands as tall as a group of one and the
                                  list does not jump when the last tab closes. */}
                              <div
                                className="grid transition-[grid-template-rows,opacity,transform] duration-250 ease-out"
                                style={{ gridTemplateRows: group.collapsed ? '0fr' : '1fr', opacity: group.collapsed ? 0 : 1, transform: group.collapsed ? 'translateY(-4px)' : 'translateY(0)' }}
                              >
                                <div className="overflow-hidden">
                                  {/* px-1 narrows the child-tab highlight so it doesn't touch the group border.
                                      The rail carries the group's colour down its
                                      sessions so the boundary reads at a glance —
                                      groups are containers, not filters.
                                      pt-0.5, not the sides' 4px: the header is a
                                      row, so the space over the first session is
                                      the seam BETWEEN two rows and reads as one
                                      stack at 2px. At 4px the header floated. */}
                                  <div
                                    className="px-1 pt-0.5 space-y-0.5 group-rail"
                                    data-selected={allGroupSelected ? 'true' : undefined}
                                    // The rows stay in the DOM while collapsed (the
                                    // grid track animates to 0); the drag hit-test
                                    // reads this to ignore them (use-sidebar-dnd).
                                    data-group-collapsed={group.collapsed ? 'true' : undefined}
                                    style={
                                      groupColorHex
                                        ? ({ '--group-rail-color': groupColorHex } as React.CSSProperties)
                                        : undefined
                                    }
                                  >
                                    {group.sessionIds.map((sid, sIdx) => {
                                      const prevSid = sIdx > 0 ? group.sessionIds[sIdx - 1] : null
                                      const isLastInGroup = sIdx === group.sessionIds.length - 1
                                      const childGapBefore = isDragging && shouldShowGapBefore(dropIndicator, sid, prevSid)

                                      // Check if this is a file tab
                                      const fileTab = fileTabs.find((f) => f.id === sid)
                                      if (fileTab) {
                                        return (
                                          <div key={fileTab.id}>
                                            <DropGap active={childGapBefore} />
                                            <FileTabItem
                                              fileTab={fileTab}
                                              isSelected={selectedSessionIds.includes(fileTab.id)}
                                              dimmed={hasSelection && !selectedSessionIds.includes(fileTab.id)}
                                              onClick={(modifiers) => handleSessionClick(fileTab.id, modifiers)}
                                              onContextMenu={(e) => handleFileTabContextMenu(e, fileTab.id)}
                                              grouped
                                              groupSelected={allGroupSelected}
                                              forceEditing={renamingId === fileTab.id}
                                              onEditingDone={clearRenaming}
                                              onPointerDown={(e) => handlePointerDown(e, fileTab.id, false)}
                                              isDragging={draggedIds.includes(fileTab.id)}
                                            />
                                            {isLastInGroup && (
                                              <DropGap
                                edge="after"
                                                active={isDragging && dropIndicator?.targetId === sid && dropIndicator?.position === 'after'}
                                              />
                                            )}
                                          </div>
                                        )
                                      }
                                      const session = sessions.find((s) => s.id === sid)
                                      if (!session) return null
                                      return (
                                        <div key={session.id}>
                                          <DropGap active={childGapBefore} />
                                          <SessionItem
                                            session={session}
                                            isSelected={selectedSessionIds.includes(session.id)}
                                            dimmed={hasSelection && !selectedSessionIds.includes(session.id)}
                                            onClick={(modifiers) => handleSessionClick(session.id, modifiers)}
                                            onContextMenu={(e) => handleSessionContextMenu(e, session.id)}
                                            grouped
                                            groupSelected={allGroupSelected}
                                            groupColorHex={groupColorHex}
                                            forceEditing={renamingId === session.id}
                                            onEditingDone={clearRenaming}
                                            onPointerDown={(e) => handlePointerDown(e, session.id, false)}
                                            isDragging={draggedIds.includes(session.id)}
                                            onDelete={() => setDeleteConfirmSessionId(session.id)}
                                          />
                                          {isLastInGroup && (
                                            <DropGap
                                edge="after"
                                              active={isDragging && dropIndicator?.targetId === sid && dropIndicator?.position === 'after'}
                                            />
                                          )}
                                        </div>
                                      )
                                    })}
                                    {/* An emptied group keeps its place. The row
                                        stands in for the session that is no longer
                                        there — same height, so the card is as tall
                                        as a group of one — and, while dragging, it
                                        is the group's drop zone: a row dropped on
                                        it joins the group (use-sidebar-dnd). */}
                                    {railEmpty && (
                                      <div
                                        className="sidebar-empty-row"
                                        data-sidebar-empty-group={group.id}
                                        data-sidebar-drop-zone="group-end"
                                        data-group-id={group.id}
                                      >
                                        No sessions
                                      </div>
                                    )}
                                    {/* The foot of the rail: while dragging, the
                                        "last position of the group" drop zone
                                        (use-sidebar-dnd) — the last row's bottom
                                        half is the other way to aim there. The
                                        group's `+` for a new session lives in the
                                        header; a row here read as one more thing
                                        to click and got clicked by mistake. */}
                                    <div
                                      // With the 2px row spacing above it, IS
                                      // the rail's bottom padding: 4px under the
                                      // last row, the same as its sides and top.
                                      className="h-0.5"
                                      data-sidebar-drop-zone="group-end"
                                      data-group-id={group.id}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                            {isLastItem && (
                              <DropGap
                                edge="after"
                                active={isDragging && dropIndicator?.targetId === itemId && dropIndicator?.position === 'after'}
                              />
                            )}
                          </div>
                        )
                      }
                    })}
                    {/* Bottom drop zone — generous target for dropping at the very end */}
                    {isDragging && <div className="min-h-[60px]" />}
                  </>
                ) : null}
              </div>
            </div>
          </>
        }
      </ScrollArea>

      {/* The seam at the foot of the list, the one at the top mirrored: the
          hairline first, then the 4px, because down here the line is the edge
          the list disappears at and the space is what holds the foot panel off
          it. Only when the list actually runs past its viewport — with nothing
          scrolling under the foot there is no edge for a seam to be, and the
          rule would read as a line lying in empty sidebar. */}
      {listOverflows && <div className="sidebar-list-seam sidebar-list-seam--foot flex-shrink-0" />}

      {/* Announcements — above the foot panel. The feedback card joins them
          while it is still expanded; once collapsed it lives on as an icon
          inside the foot panel rather than as a row of its own. */}
      <div className="flex-shrink-0 px-2 has-[>div]:pb-2 space-y-1">
        <TelemetryNoticeBanner />
        <WhatsNewBanner />
        <UpdateBanner />
        <FeedbackBanner />
      </div>

      {/* The foot: one panel — avatar, name, the agent's headroom, the doors. */}
      <div className="flex-shrink-0 px-2 pb-2">
        <SidebarFooter />
      </div>
      <FeedbackDialogHost />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          header={contextMenu.header}
        />
      )}

      {/* Delete session confirmation */}
      <ConfirmDialog
        isOpen={deleteConfirmSessionId !== null}
        title="Delete session"
        message="Are you sure you want to delete this session? This will terminate the process."
        onConfirm={() => {
          if (deleteConfirmSessionId) handleDeleteSession(deleteConfirmSessionId)
          setDeleteConfirmSessionId(null)
        }}
        onCancel={() => setDeleteConfirmSessionId(null)}
      />

      {/* Group terminal configuration dialog */}
      <GroupCommandDialog
        isOpen={terminalDialogState !== null}
        initialCommand={
          terminalDialogState?.terminalId
            ? groups.find((g) => g.id === terminalDialogState.groupId)?.terminals.find((t) => t.id === terminalDialogState.terminalId)?.command
            : undefined
        }
        initialMode={
          terminalDialogState?.terminalId
            ? groups.find((g) => g.id === terminalDialogState.groupId)?.terminals.find((t) => t.id === terminalDialogState.terminalId)?.commandMode ?? 'prefill'
            : 'prefill'
        }
        initialColor={(() => {
          if (terminalDialogState?.terminalId) {
            return groups.find((g) => g.id === terminalDialogState.groupId)?.terminals.find((t) => t.id === terminalDialogState.terminalId)?.color ?? 'blue'
          }
          // Next unused color
          const group = terminalDialogState ? groups.find((g) => g.id === terminalDialogState.groupId) : null
          const used = new Set(group?.terminals.map((t) => t.color) ?? [])
          return (GROUP_TERMINAL_COLORS.find((c) => !used.has(c)) ?? 'blue') as GroupTerminalColor
        })()}
        initialCwd={(() => {
          if (!terminalDialogState) return null
          const group = groups.find((g) => g.id === terminalDialogState.groupId)
          if (terminalDialogState.terminalId) {
            const terminal = group?.terminals.find((t) => t.id === terminalDialogState.terminalId)
            if (terminal?.cwd) return terminal.cwd
          }
          return group?.cwd || sessions.find((s) => group?.sessionIds.includes(s.id))?.cwd || null
        })()}
        initialIcon={
          terminalDialogState?.terminalId
            ? groups.find((g) => g.id === terminalDialogState.groupId)?.terminals.find((t) => t.id === terminalDialogState.terminalId)?.icon ?? 'terminal'
            : 'terminal'
        }
        onSave={async (command, mode, color, cwd, icon) => {
          if (!terminalDialogState) return
          const { groupId, terminalId } = terminalDialogState

          // Determine per-terminal cwd: store only if different from group default
          const group = groups.find((g) => g.id === groupId)
          const groupCwd = group?.cwd || sessions.find((s) => group?.sessionIds.includes(s.id))?.cwd
          const terminalCwd = cwd && cwd !== groupCwd ? cwd : null

          if (terminalId) {
            // Editing existing
            useSessionStore.getState().updateGroupTerminal(groupId, terminalId, { command, commandMode: mode, color, icon, cwd: terminalCwd })
          } else {
            // Adding new — add config, then spawn immediately
            const newId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            addGroupTerminal(groupId, { id: newId, command, commandMode: mode, color, icon, cwd: terminalCwd })
            setTerminalDialogState(null)
            await spawnGroupTerminal(groupId, newId, command, mode, cwd)
            return
          }
          setTerminalDialogState(null)
        }}
        onCancel={() => setTerminalDialogState(null)}
        onDelete={
          terminalDialogState?.terminalId
            ? () => {
                if (!terminalDialogState) return
                const { groupId, terminalId } = terminalDialogState
                if (terminalId) {
                  // Kill the session if alive
                  const config = groups.find((g) => g.id === groupId)?.terminals.find((t) => t.id === terminalId)
                  if (config?.sessionId) {
                    window.electronAPI.killSession(config.sessionId).catch(() => {})
                  }
                  removeGroupTerminal(groupId, terminalId)
                }
                setTerminalDialogState(null)
              }
            : undefined
        }
      />

      {/* Remote directory picker */}
      {remotePickerState && (
        <RemoteDirectoryPicker
          locationId={remotePickerState.locationId}
          locationName={remotePickerState.locationName}
          onSelect={(path) => {
            spawnRemoteSession(remotePickerState.locationId, path, remotePickerState.claudeMode, remotePickerState.antigravityMode, remotePickerState.codexMode)
            setRemotePickerState(null)
          }}
          onCancel={() => setRemotePickerState(null)}
        />
      )}
    </div>
  )
}

function PinnedSection({
  setContextMenu,
  pinnedZoneRef,
  isOverPinnedZone,
  draggedGroupId,
  isFileDragOver,
  groupPickerOpen,
  onCloseGroupPicker
}: {
  setContextMenu: (menu: ContextMenuState | null) => void
  pinnedZoneRef: React.RefObject<HTMLDivElement | null>
  isOverPinnedZone: boolean
  draggedGroupId: string | null
  isFileDragOver: boolean
  groupPickerOpen: boolean
  onCloseGroupPicker: () => void
}) {
  const [exportDialogPinnedId, setExportDialogPinnedId] = useState<string | null>(null)

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, pinnedId: string) => {
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Rename',
            icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
            onClick: () => {
              const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
              const newName = window.prompt('Rename pinned group', pg?.name ?? '')
              if (newName && newName.trim()) {
                usePinnedStore.getState().renamePinnedGroup(pinnedId, newName.trim())
              }
            }
          },
          {
            label: 'Export as .clave',
            icon: <ArrowDownTrayIcon className="w-3.5 h-3.5" />,
            onClick: () => setExportDialogPinnedId(pinnedId)
          },
          {
            label: 'Remove Pin',
            icon: <TrashIcon className="w-3.5 h-3.5" />,
            danger: true,
            onClick: () => removePinnedGroupWithCleanup(pinnedId)
          }
        ]
      })
    },
    [setContextMenu]
  )

  // The inline grid is now only a drop target — it appears while dragging a
  // group to pin or dragging a .clave file over the sidebar. The full launcher
  // is the GroupPickerDialog behind the Sessions header actions.
  const showDropZone = !!draggedGroupId || isFileDragOver

  return (
    <>
      {showDropZone && (
        <PinnedGroupsGrid
          ref={pinnedZoneRef}
          isOverPinnedZone={isOverPinnedZone}
          draggedGroupId={draggedGroupId}
          isFileDragOver={isFileDragOver}
        />
      )}
      {groupPickerOpen && (
        <GroupPickerDialog onClose={onCloseGroupPicker} onContextMenu={handleContextMenu} />
      )}
      <ExportClaveDialog
        isOpen={exportDialogPinnedId !== null}
        defaultFileName={exportDialogPinnedId ? getExportFileName(exportDialogPinnedId) : 'group.clave'}
        onExport={async (folder, fileName, keepSynced) => {
          if (exportDialogPinnedId) {
            await exportClaveFile(exportDialogPinnedId, folder, fileName, keepSynced)
          }
          setExportDialogPinnedId(null)
        }}
        onCancel={() => setExportDialogPinnedId(null)}
      />
    </>
  )
}

function SessionItem(props: React.ComponentProps<typeof BaseSessionItem>): React.JSX.Element {
  return (
    <div className="chat-sidebar-row">
      <BaseSessionItem {...props} />
      <SessionViewBadge sessionId={props.session.id} />
    </div>
  )
}
