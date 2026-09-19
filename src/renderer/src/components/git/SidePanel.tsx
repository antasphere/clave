import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useSessionStore } from '../../store/session-store'
import { PANEL_ROOTS, panelRootLadder, type PanelScope } from '../../store/session-types'
import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { FileTree } from '../files/FileTree'
import { RemoteFileTree } from '../files/RemoteFileTree'
import { GitStatusPanel, MultiRepoGitPanel } from './GitStatusPanel'
import { MagicPullButton, MagicSyncButton, ViewModeToggle, PanelModeToggle, CollapseAllButton, CommitBarToggle, JourneyButton, GitSyncBadge } from './GitPanelControls'
import { GitBatchProvider, GitBatchProgressBar } from './GitBatchProgress'
import { useMultiRepoStatus } from '../../hooks/use-multi-repo-status'
import { useGitStatus } from '../../hooks/use-git-status'
import { shortenPath } from '../../lib/utils'
import { HelpPanel } from '../help/HelpPanel'
import { Tooltip, TooltipTrigger, TooltipContent, IconButton } from '@clave/ui/components'
import {
  InformationCircleIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  ArrowUturnLeftIcon,
  DocumentTextIcon
} from '@heroicons/react/24/outline'

/** Which root the panel hangs from. The rungs, their glyphs and the phrase the
 *  tooltips read all come from PANEL_ROOTS, so the panel and the Settings pane
 *  that picks its default cannot drift apart. The panel used to know only the
 *  focused tab's own folder, which is why it drew nothing at all with no tab
 *  focused: it had no folder to be about. */
export type { PanelScope }
const SCOPES: PanelScope[] = PANEL_ROOTS.map((r) => r.id)
const byScope = <T,>(pick: (r: (typeof PANEL_ROOTS)[number]) => T): Record<PanelScope, T> =>
  Object.fromEntries(PANEL_ROOTS.map((r) => [r.id, pick(r)])) as Record<PanelScope, T>
const SCOPE_GLYPH = byScope((r) => r.glyph)
const SCOPE_LABEL = byScope((r) => r.label)
const SCOPE_HOME = byScope((r) => r.home)
/** The scope and navigation maps are keyed by session. With no session focused
 *  the panel still has a root (the workspace) and can still be navigated, so
 *  that state needs a key of its own. */
const NO_SESSION_KEY = '__no-session__'

/** Close a hand-rolled popover on a click outside it or on Escape. */
function useDismiss(
  open: boolean,
  surface: React.RefObject<HTMLElement | null>,
  trigger: React.RefObject<HTMLElement | null>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent): void => {
      const t = e.target as Node
      if (
        surface.current &&
        !surface.current.contains(t) &&
        trigger.current &&
        !trigger.current.contains(t)
      ) {
        close()
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, surface, trigger, close])
}

function getParentPaths(fullPath: string): { path: string; name: string }[] {
  const homedir = fullPath.match(/^\/Users\/[^/]+/)?.[0] ?? ''
  const parts = fullPath.split('/').filter(Boolean)
  const result: { path: string; name: string }[] = []
  for (let i = parts.length; i >= 1; i--) {
    const p = '/' + parts.slice(0, i).join('/')
    const name = p === homedir ? '~' : parts[i - 1]
    result.push({ path: p, name })
  }
  result.push({ path: '/', name: '/' })
  return result
}

/**
 * The panel, with the batch-op context around it.
 *
 * The provider has to sit ABOVE the body rather than inside its JSX: the body
 * calls `useMultiRepoStatus`, which reaches for the batch runner to drive its
 * refresh, and a provider rendered by the same component is not above the hooks
 * that component ran. It failed the way context mistakes do — the hook threw,
 * React unmounted the subtree, and the panel simply came up blank.
 */
export function SidePanel(): React.JSX.Element {
  return (
    <GitBatchProvider>
      <SidePanelBody />
    </GitBatchProvider>
  )
}

function SidePanelBody(): React.JSX.Element {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const sidePanelTab = useSessionStore((s) => s.sidePanelTab)
  const setSidePanelTab = useSessionStore((s) => s.setSidePanelTab)


  const focusedSession = sessions.find((s) => s.id === focusedSessionId)
  const sessionCwd = focusedSession?.cwd ?? null

  // Determine if focused session is remote
  const isRemoteSession = focusedSession?.sessionType === 'remote-terminal' ||
    focusedSession?.sessionType === 'remote-claude' ||
    focusedSession?.sessionType === 'agent'
  const remoteLocationId = isRemoteSession ? focusedSession?.locationId : undefined

  // For agent sessions, resolve cwd from agent store if session cwd is empty
  const agentCwd = useMemo(() => {
    if (focusedSession?.sessionType !== 'agent' || !focusedSession.agentId) return null
    const agent = useAgentStore.getState().agents.find((a) => a.id === focusedSession.agentId)
    return agent?.cwd ?? null
  }, [focusedSession?.sessionType, focusedSession?.agentId])

  const effectiveCwd = isRemoteSession ? (sessionCwd || agentCwd || '~') : sessionCwd

  // Resolve location name for remote sessions
  const locationName = useMemo(() => {
    if (!remoteLocationId) return null
    return useLocationStore.getState().locations.find((l) => l.id === remoteLocationId)?.name ?? null
  }, [remoteLocationId])

  // ── The root: which of the three folders the panel hangs from ──────────
  const groups = useSessionStore((s) => s.groups)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const focusedGroup = useMemo(
    () =>
      focusedSessionId
        ? groups.find((g) => g.sessionIds.includes(focusedSessionId)) ?? null
        : null,
    [groups, focusedSessionId]
  )
  const workspaceRoot = useMemo(() => {
    const id = focusedSession?.workspaceId ?? activeWorkspaceId
    return (id ? workspaces.find((w) => w.id === id)?.rootDir : null) ?? null
  }, [focusedSession?.workspaceId, activeWorkspaceId, workspaces])

  // A remote session's folder is on another machine: the two local roots are
  // not it, so the chip stays hidden there and the panel follows the session.
  const scopeRoots: Record<PanelScope, string | null> = {
    session: sessionCwd,
    group: isRemoteSession ? null : focusedGroup?.cwd ?? null,
    workspace: isRemoteSession ? null : workspaceRoot
  }

  // The choice is remembered per session; another session takes its own, or
  // the default. The default is a ladder, not a fixed rung: the root chosen in
  // Settings when the focused tab has that folder, else the next rung down —
  // which is what a panel with no session focused lands on, instead of on
  // nothing. It ships pointed at the GROUP, so every tab in a group opens on
  // the one folder the group is about (usually the repo the work is in) rather
  // than on whichever subfolder each tab happens to be launched in; a tab
  // outside any group has no group rung and falls to its own folder.
  const [scopeChoices, setScopeChoices] = useState<ReadonlyMap<string, PanelScope>>(
    () => new Map()
  )
  const navKey = focusedSessionId ?? NO_SESSION_KEY
  const defaultPanelRoot = useSessionStore((s) => s.defaultPanelRoot)
  const defaultScope: PanelScope =
    panelRootLadder(defaultPanelRoot).find((s) => scopeRoots[s]) ?? 'workspace'
  const chosenScope = scopeChoices.get(navKey)
  const scope: PanelScope =
    chosenScope && scopeRoots[chosenScope] ? chosenScope : defaultScope
  const rootCwd = scopeRoots[scope]

  const [customCwd, _setCustomCwd] = useState<string | null>(null)
  const navMapRef = useRef(new Map<string, string>())        // navKey -> current customCwd
  const navStackRef = useRef(new Map<string, string[]>())    // navKey -> back stack
  const prevNavKeyRef = useRef(navKey)
  const [canGoBack, setCanGoBack] = useState(false)
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const pathButtonRef = useRef<HTMLButtonElement>(null)
  const pathMenuRef = useRef<HTMLDivElement>(null)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const scopeButtonRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)

  const updateCanGoBack = useCallback(() => {
    const stack = navStackRef.current.get(navKey)
    setCanGoBack(!!stack && stack.length > 0)
  }, [navKey])

  // Navigate forward — pushes current cwd onto the back stack
  const setCustomCwd = useCallback(
    (path: string | null) => {
      if (path) {
        // Push current location onto the back stack before navigating
        const currentCwd = customCwd ?? rootCwd
        if (currentCwd && currentCwd !== path) {
          const stack = navStackRef.current.get(navKey) ?? []
          stack.push(currentCwd)
          navStackRef.current.set(navKey, stack)
        }
        navMapRef.current.set(navKey, path)
      } else {
        // Reset to root — clear everything
        navStackRef.current.delete(navKey)
        navMapRef.current.delete(navKey)
      }
      _setCustomCwd(path)
      updateCanGoBack()
    },
    [navKey, customCwd, rootCwd, updateCanGoBack]
  )

  // Navigate back — pops from the stack
  const goBack = useCallback(() => {
    const stack = navStackRef.current.get(navKey)
    if (!stack || stack.length === 0) return
    const prev = stack.pop()!
    if (stack.length === 0) navStackRef.current.delete(navKey)
    const newCwd = prev === rootCwd ? null : prev
    _setCustomCwd(newCwd)
    if (newCwd) {
      navMapRef.current.set(navKey, newCwd)
    } else {
      navMapRef.current.delete(navKey)
    }
    updateCanGoBack()
  }, [navKey, rootCwd, updateCanGoBack])

  // Restore from nav map when focused session changes
  useEffect(() => {
    if (navKey !== prevNavKeyRef.current) {
      prevNavKeyRef.current = navKey
      _setCustomCwd(navMapRef.current.get(navKey) ?? null)
      updateCanGoBack()
    }
  }, [navKey, updateCanGoBack])

  // A new root is a new place: the navigation into the old one does not carry
  // over, and the way back is to switch back.
  const setScope = useCallback(
    (next: PanelScope) => {
      setScopeChoices((prev) => {
        const m = new Map(prev)
        m.set(navKey, next)
        return m
      })
      navStackRef.current.delete(navKey)
      navMapRef.current.delete(navKey)
      _setCustomCwd(null)
      setCanGoBack(false)
    },
    [navKey]
  )

  const closePathMenu = useCallback(() => setPathMenuOpen(false), [])
  const closeScopeMenu = useCallback(() => setScopeMenuOpen(false), [])
  useDismiss(pathMenuOpen, pathMenuRef, pathButtonRef, closePathMenu)
  useDismiss(scopeMenuOpen, scopeMenuRef, scopeButtonRef, closeScopeMenu)

  const cwd = customCwd ?? rootCwd
  const isCustom = customCwd !== null

  // Force files tab for remote sessions
  const effectiveTab = isRemoteSession ? 'files' : sidePanelTab
  const isGitTabActive = effectiveTab === 'git'
  const multiRepo = useMultiRepoStatus(cwd, isGitTabActive)

  // Single-repo git status — used for branch badge in path row
  const isSingleRepo = isGitTabActive && multiRepo.result.mode === 'single'
  const singleRepoGit = useGitStatus(isSingleRepo ? cwd : null, isSingleRepo)

  // Single-repo sections, driven by the toolbar's ↓/↑/+ badge-buttons.
  // Per-repo state: a folder switch resets it (guarded adjust-during-render).
  const [showIncomingSingle, setShowIncomingSingle] = useState(false)
  const [showOutgoingSingle, setShowOutgoingSingle] = useState(false)
  // The local work is what the panel is for, so this one starts on.
  const [showChangesSingle, setShowChangesSingle] = useState(true)
  const [prevRangeCwd, setPrevRangeCwd] = useState(cwd)
  if (prevRangeCwd !== cwd) {
    setPrevRangeCwd(cwd)
    setShowIncomingSingle(false)
    setShowOutgoingSingle(false)
    setShowChangesSingle(true)
  }

  // The repo's dirt, driving the toolbar's + badge.
  const singleRepoChangeCount = singleRepoGit.status?.files.length ?? 0


  // Every repo the panel lists — what Magic sync acts on, since committing and
  // pushing is about each repo's own local work.
  const allRepoPaths = useMemo(() => {
    if (multiRepo.result.mode === 'multi') return multiRepo.result.repos.map((r) => r.path)
    if (isSingleRepo && cwd) return [cwd]
    return []
  }, [multiRepo.result, isSingleRepo, cwd])

  // Only the repos with incoming commits — what Pull all acts on. The badges in
  // this panel and the button's job are the same list on purpose: the button
  // pulls what you can see, and finding more is the refresh's job.
  const behindRepoPaths = useMemo(() => {
    if (multiRepo.result.mode === 'multi') {
      return multiRepo.result.repos.filter((r) => r.status.behind > 0).map((r) => r.path)
    }
    if (isSingleRepo && cwd && (singleRepoGit.status?.behind ?? 0) > 0) return [cwd]
    return []
  }, [multiRepo.result, isSingleRepo, cwd, singleRepoGit.status])

  const gitRefresh = useCallback(() => {
    if (multiRepo.result.mode === 'multi') multiRepo.refresh()
    if (isSingleRepo) singleRepoGit.refresh()
  }, [multiRepo, isSingleRepo, singleRepoGit])

  const displayPath = useMemo(() => {
    if (!cwd) return ''
    return shortenPath(cwd)
  }, [cwd])

  const handleChangeFolder = useCallback(async () => {
    const folderPath = await window.electronAPI?.openFolderDialog()
    if (folderPath) {
      setCustomCwd(folderPath)
    }
  }, [setCustomCwd])

  const handleResetFolder = useCallback(() => {
    setCustomCwd(null)
  }, [setCustomCwd])

  const handleNavigateToFolder = useCallback(
    (absolutePath: string) => {
      setCustomCwd(absolutePath)
    },
    [setCustomCwd]
  )

  // Are we navigated into a subfolder of the root?
  const isNavigatedSubfolder = !!(
    cwd && rootCwd && cwd !== rootCwd && cwd.startsWith(rootCwd + '/')
  )

  // Breadcrumb segments when navigated into a subfolder
  const breadcrumbSegments = useMemo(() => {
    if (!isNavigatedSubfolder || !rootCwd || !cwd) return []
    const rootFolderName = rootCwd.split('/').pop() ?? rootCwd
    const relativePath = cwd.slice(rootCwd.length + 1)
    const parts = relativePath.split('/')
    const segments: { label: string; path: string }[] = [
      { label: rootFolderName, path: rootCwd }
    ]
    for (let i = 0; i < parts.length; i++) {
      segments.push({
        label: parts[i],
        path: rootCwd + '/' + parts.slice(0, i + 1).join('/')
      })
    }
    return segments
  }, [isNavigatedSubfolder, rootCwd, cwd])

  const parentPaths = useMemo(() => {
    if (!cwd) return []
    return getParentPaths(cwd)
  }, [cwd])

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* Header — the panel's chrome, and the window's drag region; every
          interactive child opts out. No rule under it: the bars ARE the chrome,
          exactly as the sidebar's launcher and switcher panels are, and a line
          under them only says again what the panel edge already said.

          The gap between the two rows is the content column's gap-2, not the
          sidebar's 4px between launcher and switcher: the tab bar sits level
          with the toolbar, so the box under it is this edge's launcher and has
          to land on the terminal card's top edge (--content-top-offset), the
          way the sidebar's launcher does across the other divide. At 4px it
          started four pixels above the card and read as misaligned. */}
      <div
        className="flex flex-col gap-2 px-2 pt-2 pb-1 flex-shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Row 1 — which tab, and nothing else. The controls that used to sit
            out here (the folder picker, collapse-all, help) have gone: the first
            two belong to WHERE the panel is pointed, which is the row below, and
            help was a button in the panel's corner for a panel that is not
            about help — ⌘? still opens it. What is left is the one choice this
            row was ever for, so the bar is the width of that choice and sits
            centred, rather than a full-width box with two buttons adrift in
            it. */}
        <div
          className="panel-bar panel-bar--hug"
          data-panel-bar="tabs"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={() => setSidePanelTab('files')}
            className="panel-tab"
            data-selected={effectiveTab === 'files' ? 'true' : undefined}
          >
            <DocumentTextIcon className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Files</span>
          </button>
          {!isRemoteSession && (
            <button
              onClick={() => setSidePanelTab('git')}
              className="panel-tab"
              data-selected={effectiveTab === 'git' ? 'true' : undefined}
            >
              {/* Heroicons has no branch glyph — the one hand-rolled icon the
                  convention leaves room for. */}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="flex-shrink-0">
                <circle cx="6" cy="1.5" r="1.25" stroke="currentColor" strokeWidth="1.1" />
                <circle cx="3" cy="10.5" r="1.25" stroke="currentColor" strokeWidth="1.1" />
                <circle cx="9" cy="10.5" r="1.25" stroke="currentColor" strokeWidth="1.1" />
                <path d="M6 2.75v3.5" stroke="currentColor" strokeWidth="1.1" />
                <path d="M6 6.25L3 9.25" stroke="currentColor" strokeWidth="1.1" />
                <path d="M6 6.25l3 3" stroke="currentColor" strokeWidth="1.1" />
              </svg>
              <span>Git</span>
            </button>
          )}
        </div>

        {/* Row 2 — where you are, as one control. The root chip says which
            folder the panel hangs from and opens the choice (workspace, group,
            session, or any folder), the path names where you are under it and
            drops the parents, the back arrow and the way home flank it, and
            collapse-all closes what it opened: every one of them is about the
            folder this panel is pointed at, so they are one bar rather than a
            naked line of text with its own controls stranded a row above. It
            does not wrap — a long path truncates, which is what a path is for;
            wrapping would drop collapse-all onto a second line at every width. */}
        {effectiveTab !== 'help' && (
          <div
            className="panel-bar panel-bar--nowrap relative"
            data-panel-bar="path"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {canGoBack && (
              <IconButton
                onClick={goBack}
                className="panel-icon-btn"
                aria-label="Go back"
                tooltip="Go back"
              >
                <ChevronLeftIcon className="w-3.5 h-3.5" />
              </IconButton>
            )}
            {/* The root chip: one letter for which root, a chevron for "this
                opens". A letter rather than an icon because no glyph reads as
                "workspace" against "group" at 12px, and three letters do. The
                old folder-picker icon folded into its menu, so the row lost a
                control here rather than gaining one. */}
            {!isRemoteSession && (
              <IconButton
                ref={scopeButtonRef}
                onClick={() => setScopeMenuOpen((v) => !v)}
                className="panel-icon-btn panel-scope-btn"
                aria-label="Choose the panel's root"
                aria-expanded={scopeMenuOpen}
                data-panel-scope={scope}
                data-active={scopeMenuOpen ? 'true' : undefined}
                tooltip={`Rooted at ${SCOPE_HOME[scope]} — click to change`}
              >
                <span className="panel-scope-glyph">{SCOPE_GLYPH[scope]}</span>
                <ChevronDownIcon className="w-2.5 h-2.5" aria-hidden="true" />
              </IconButton>
            )}
            {/* The slack beside a truncated path is the window's drag band —
                it was one before the row became a box, and it is the only one
                left at this corner of the window now that both bars opt out.
                Everything readable inside it opts back in, the way every other
                control in the panel's chrome does. */}
            <div
              className="flex-1 min-w-0 px-0.5"
              style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
            >
              {isRemoteSession && locationName ? (
                <div
                  className="flex items-center gap-1.5 text-xs font-medium text-text-secondary truncate"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="truncate">{locationName}</span>
                  {effectiveCwd && (
                    <>
                      <span className="text-text-tertiary">:</span>
                      <span className="text-text-tertiary truncate">{effectiveCwd}</span>
                    </>
                  )}
                </div>
              ) : isNavigatedSubfolder ? (
                <div
                  className="flex items-center gap-0.5 text-xs font-medium min-w-0 overflow-hidden"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onDoubleClick={() => setCustomCwd(null)}
                  title={`Double-click to go back to ${SCOPE_HOME[scope]}`}
                >
                  {breadcrumbSegments.map((seg, i) => (
                    <span key={seg.path} className="flex items-center min-w-0">
                      {i > 0 && (
                        <span className="text-text-tertiary mx-0.5 flex-shrink-0">/</span>
                      )}
                      <button
                        onClick={() => {
                          if (seg.path === rootCwd) {
                            setCustomCwd(null)
                          } else {
                            setCustomCwd(seg.path)
                          }
                        }}
                        className={`truncate hover:text-text-primary transition-colors ${
                          i === breadcrumbSegments.length - 1
                            ? 'text-text-primary'
                            : 'text-text-tertiary hover:underline'
                        }`}
                      >
                        {seg.label}
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <button
                  ref={pathButtonRef}
                  onClick={() => cwd && setPathMenuOpen((v) => !v)}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  className="max-w-full text-left text-xs text-text-secondary font-medium truncate hover:text-text-primary cursor-pointer transition-colors"
                  title={cwd ?? ''}
                >
                  {displayPath}
                </button>
              )}
            </div>

            {isCustom && (
              <IconButton
                onClick={handleResetFolder}
                className="panel-icon-btn"
                aria-label={`Back to ${SCOPE_HOME[scope]}`}
                tooltip={`Back to ${SCOPE_HOME[scope]}`}
              >
                <ArrowUturnLeftIcon className="w-3.5 h-3.5" />
              </IconButton>
            )}
            <span className="panel-sep" aria-hidden="true" />
            <CollapseAllButton />

            {/* The root menu. Three rungs, each greyed when there is nothing on
                it — a tab outside any group has no group folder, an empty
                window has no session — and the folder picker under a rule,
                since any folder is a root too. Anchored to the chip's left edge:
                the chip heads the bar and the panel sits at the window's right
                edge, so a menu hung to the right would run off it. */}
            {scopeMenuOpen && (
              <div
                ref={scopeMenuRef}
                className="menu-surface menu-pop-mount fixed z-50 w-[220px] p-1"
                data-panel-scope-menu
                style={{
                  top: (scopeButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  left: Math.max(
                    8,
                    Math.min(
                      scopeButtonRef.current?.getBoundingClientRect().left ?? 0,
                      document.documentElement.clientWidth - 228
                    )
                  )
                }}
              >
                {SCOPES.map((s) => {
                  const root = scopeRoots[s]
                  const hint = root
                    ? root.split('/').pop() || root
                    : s === 'group'
                      ? focusedSessionId
                        ? focusedGroup
                          ? 'no folder'
                          : 'not in a group'
                        : 'no session'
                      : s === 'session'
                        ? 'no session'
                        : 'no workspace'
                  return (
                    <button
                      key={s}
                      className="menu-item"
                      data-scope-option={s}
                      data-selected={s === scope}
                      disabled={!root}
                      onClick={() => {
                        setScope(s)
                        setScopeMenuOpen(false)
                      }}
                    >
                      <span className="panel-scope-glyph menu-glyph">{SCOPE_GLYPH[s]}</span>
                      <span className="flex-1 truncate">{SCOPE_LABEL[s]}</span>
                      <span className="menu-hint truncate" title={root ?? undefined}>
                        {hint}
                      </span>
                    </button>
                  )
                })}
                <div className="menu-sep" />
                <button
                  className="menu-item menu-item--muted"
                  data-scope-option="folder"
                  onClick={() => {
                    setScopeMenuOpen(false)
                    void handleChangeFolder()
                  }}
                >
                  <span className="menu-glyph">
                    <FolderOpenIcon className="w-3.5 h-3.5" />
                  </span>
                  <span>Another folder…</span>
                </button>
              </div>
            )}

            {pathMenuOpen && parentPaths.length > 0 && (
              <div
                ref={pathMenuRef}
                className="menu-surface menu-pop-mount fixed z-50 min-w-[180px] max-w-[320px] p-1"
                style={{
                  top: (pathButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                  right:
                    document.documentElement.clientWidth -
                    (pathButtonRef.current?.getBoundingClientRect().right ?? 0)
                }}
              >
                {/* The scroll lives one level in: the surface clips its own
                    corners, so it cannot also be the thing that scrolls. */}
                <div className="max-h-[60vh] overflow-y-auto">
                {parentPaths.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => {
                      setCustomCwd(item.path)
                      setPathMenuOpen(false)
                    }}
                    className="menu-item"
                    data-selected={item.path === cwd}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      className="flex-shrink-0"
                    >
                      <path
                        d="M1.5 2.5a1 1 0 0 1 1-1h2.172a1 1 0 0 1 .707.293L6.5 2.914a1 1 0 0 0 .707.293H9.5a1 1 0 0 1 1 1v5.293a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.5Z"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="truncate">{item.name}</span>
                  </button>
                ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The git tab's own bar. Same panel as the tab bar above it, so the two
          stack as one block of chrome. It wraps rather than clips: a branch
          name, three badges and six controls do not fit the 240px default
          width, and a second line inside the panel reads as intended where the
          old loose row running toward the edge did not. */}
      {isGitTabActive && !isRemoteSession && multiRepo.result.mode !== 'none' && multiRepo.result.mode !== 'loading' && (
        <div className="px-2 pb-1.5 flex-shrink-0">
          <div className="panel-bar" data-panel-bar="git">
            {/* Everything that NAMES the repo is one flex item, and the controls
                are the other. That is what makes the bar wrap into two readable
                lines instead of three ragged ones: the label group takes the
                slack on its line and truncates inside it, so a long branch name
                never claims a line of its own and never pushes the badges off
                the one it is on. */}
            <span className="panel-bar-label">
            {/* Branch name (single-repo only). The badges sit outside the
                truncating name so a long branch never clips them away — they are
                the toolbar's controls, the name is only a label. */}
            {isSingleRepo && singleRepoGit.status?.branch && (
              <span className="flex items-center gap-1 pl-1.5 text-xs text-text-secondary min-w-0">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="flex-shrink-0 text-text-tertiary">
                  <circle cx="6" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <circle cx="6" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M6 4v4" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                <span className="truncate min-w-0">{singleRepoGit.status.branch}</span>
              </span>
            )}
            {/* A folder of repos has no one branch, so the bar's left half says
                what it does have. The per-repo change counts are on the rows
                themselves — a total here only cost the label its own word. */}
            {multiRepo.result.mode === 'multi' && (
              <span className="pl-1.5 text-xs text-text-secondary truncate min-w-0">
                {multiRepo.result.repos.length} repo{multiRepo.result.repos.length === 1 ? '' : 's'}
              </span>
            )}
            {isSingleRepo && singleRepoGit.status && (
              <span className="flex items-center gap-1 flex-shrink-0">
                {singleRepoGit.status.ahead > 0 && (
                  <GitSyncBadge
                    tone="outgoing"
                    count={singleRepoGit.status.ahead}
                    active={showOutgoingSingle}
                    onToggle={() => setShowOutgoingSingle((v) => !v)}
                    title="Show what a push will send"
                  />
                )}
                {singleRepoGit.status.behind > 0 && (
                  <GitSyncBadge
                    tone="incoming"
                    count={singleRepoGit.status.behind}
                    active={showIncomingSingle}
                    onToggle={() => setShowIncomingSingle((v) => !v)}
                    title="Show what a pull will bring"
                  />
                )}
                {singleRepoChangeCount > 0 && (
                  <GitSyncBadge
                    tone="changes"
                    count={singleRepoChangeCount}
                    active={showChangesSingle}
                    onToggle={() => setShowChangesSingle((v) => !v)}
                    title={showChangesSingle ? 'Hide local changes' : 'Show local changes'}
                  />
                )}
              </span>
            )}
            {/* Parent-repo notice — opened folder isn't a repo, changes come from above */}
            {isSingleRepo &&
              !isNavigatedSubfolder &&
              singleRepoGit.status?.repoRoot &&
              cwd &&
              singleRepoGit.status.repoRoot !== cwd && (
                <span className="flex items-center gap-1 text-[10px] text-text-tertiary truncate min-w-0">
                  <InformationCircleIcon className="w-3 h-3 flex-shrink-0" />
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <span className="truncate cursor-default">
                        Part of {singleRepoGit.status.repoRoot.split(/[\\/]/).pop() || singleRepoGit.status.repoRoot}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono max-w-[300px]">
                      This folder isn’t a git repository. The changes shown belong to the parent repository {shortenPath(singleRepoGit.status.repoRoot)}, which contains it.
                    </TooltipContent>
                  </Tooltip>
                </span>
              )}
            </span>
            {/* Three segments, hairlined apart: what reaches the remote, what
                opens a panel over the repo, what changes how the list is drawn.
                Collapse-all is gone from here — it is in the tab bar above,
                where the file tree can reach it too. */}
            {/* One cluster that never breaks apart: it wraps to the next line
                whole, or not at all. The hairline that used to lead it is gone
                with the spacer — on one line the label group's slack separates
                them, and on two the line break already has. */}
            <span className="panel-bar-controls">
              <MagicPullButton repoPaths={behindRepoPaths} onDone={gitRefresh} />
              <MagicSyncButton repoPaths={allRepoPaths} onDone={gitRefresh} />
              <span className="panel-sep" aria-hidden="true" />
              <CommitBarToggle />
              {isSingleRepo && cwd && (
                <JourneyButton cwd={cwd} repoName={cwd.split('/').pop() ?? cwd} />
              )}
              <span className="panel-sep" aria-hidden="true" />
              <PanelModeToggle />
              <ViewModeToggle />
  </span>
            {/* The batch progress row. A sibling of the controls, not a child
                of either button: the bar wraps, so a full-width item lands on
                its own line underneath without moving anything above it. It
                renders nothing at all when no batch is running. */}
            <GitBatchProgressBar />
          </div>
        </div>
      )}

      {/* Active tab content */}
      {effectiveTab === 'help' ? (
        <HelpPanel />
      ) : isRemoteSession && remoteLocationId && effectiveCwd && effectiveCwd !== '' && effectiveCwd !== '~' && effectiveCwd.startsWith('/') ? (
        <RemoteFileTree locationId={remoteLocationId} cwd={effectiveCwd} />
      ) : isRemoteSession ? (
        <div className="flex-1 flex items-center justify-center px-3">
          <span className="text-xs text-text-tertiary text-center">No working directory</span>
        </div>
      ) : (
        <>
          {/* Keep FileTree mounted across tab switches so folder expansion state is preserved */}
          <div className={sidePanelTab === 'files' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}>
            <FileTree cwd={cwd} onNavigateToFolder={handleNavigateToFolder} />
          </div>
          {sidePanelTab === 'git' && (
            multiRepo.result.mode === 'multi' ? (
              <MultiRepoGitPanel
                repos={multiRepo.result.repos}
                rootPath={multiRepo.hasNestedRepos ? cwd : null}
                basePath={cwd}
                refresh={multiRepo.refresh}
                truncated={multiRepo.result.truncated}
                live={multiRepo.result.live}
                refreshing={multiRepo.refreshing}
                lastUpdated={multiRepo.lastUpdated}
              />
            ) : multiRepo.result.mode === 'none' ? (
              <div className="flex-1 flex items-center justify-center px-3">
                <span className="text-xs text-text-tertiary text-center">Not a git repository</span>
              </div>
            ) : (
              <GitStatusPanel
                cwd={cwd}
                isActive={isGitTabActive}
                filterPrefix={isNavigatedSubfolder ? cwd : null}
                externalStatus={singleRepoGit.status}
                externalRefresh={singleRepoGit.refresh}
                showIncoming={showIncomingSingle}
                showOutgoing={showOutgoingSingle}
                showChanges={showChangesSingle}
              />
            )
          )}
        </>
      )}
    </div>
  )
}
