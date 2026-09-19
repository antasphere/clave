import { emitTabClosed } from '../../lib/exchange-capture'
import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  useSessionStore,
  isFileTabId,
  getVisibleFlatOrder,
  inActiveWorkspace,
  enableSidebarPersistence
} from '../../store/session-store'
import type { SessionGroup, SettingsSection } from '../../store/session-store'
import { treeRuleMultiplier } from '../../store/session-types'
import { useAgentStore } from '../../store/agent-store'
import { Sidebar } from './Sidebar'
import { useTrafficLights } from '../../hooks/use-traffic-lights'
import { launchSession } from '../../lib/launch-session'
import { loadLaunchPrefs } from '../../store/launch-prefs'
import { loadLaunchProfiles } from '../../store/launch-profile-store'
import { TerminalGrid } from './TerminalGrid'
import { SettingsPanel } from '../settings/SettingsPanel'
import { SettingsSidebar } from '../settings/SettingsSidebar'
import { ExtensionsPanel } from '../extensions/ExtensionsPanel'
import { ExtensionsSidebar } from '../extensions/ExtensionsSidebar'
import { UpdateOverlay } from '../ui/UpdateOverlay'
import { connectUpdaterStore } from '../../store/updater-store'
import { MissionControlOverlay } from '../ui/MissionControlOverlay'
import { SessionHistoryDialog } from '../session/SessionHistoryDialog'
import { useHistoryStore } from '../../store/history-store'
import { startSessionHistoryStamping } from '../../lib/session-history'
import { AgentChatPanel } from '../agents/AgentChatPanel'
import { useWorkTracker } from '../../store/work-tracker-store'
import { FilePalette } from '../files/FilePalette'
import { SidePanel } from '../git/SidePanel'
import { FilePreview } from '../files/FilePreview'
import { GitDiffPreview } from '../git/GitDiffPreview'
import { GitJourneyPanel } from '../git/GitJourneyPanel'
import { Bars3BottomLeftIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import { usePinnedStore, initClaveFileWatchers } from '../../store/pinned-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import {
  bootWorkspaces,
  refreshActiveWorkspacePins,
  cycleWorkspace
} from '../../lib/workspace-actions'
import { promptRestore } from '../../store/restore-prompt-store'
import { RestorePromptDialog } from '../ui/RestorePromptDialog'
import { initMcpDispatcher } from '../../lib/mcp-dispatcher'
import { adoptRecord, adoptRehomed, adoptHiddenRecord } from '../../lib/adopt-record'
import { requestGroupDissolve, useDissolveStore } from '../../lib/group-dissolve'
import { planBootAdoption, survivingIds } from '../../lib/boot-adoption'
import { parkToolbarSurvivor } from '../../lib/toolbar-terminal-registry'
import { initSecretStore } from '../../store/secret-store'
import { initCopyOfferStore } from '../../store/copy-offer-store'
import { ToolbarSecretPopover } from './ToolbarSecretPopover'
import { ToolbarWorkspacePopover } from './ToolbarWorkspacePopover'
import { resolveColorHex } from '../../store/session-types'
import { getTerminalIconComponent } from '../ui/GroupCommandDialog'
import { ToolbarTerminalPopover } from './ToolbarTerminalPopover'
import { ConfirmDialog } from '@clave/ui/components'
import { useKeymapManager, type KeymapActionHandlers } from '../../hooks/use-keymap-manager'
import { KeymapCommandHud } from '../ui/KeymapCommandHud'
import { connectKeymapStore, useShortcutLabel } from '../../store/keymap-store'

const sidebarTransition = {
  duration: 0.2,
  ease: [0.2, 0, 0, 1] as const
}

/** Process-wide latch so tmux-session adoption runs exactly once per launch,
 *  even across React StrictMode's mount→unmount→mount in development. */
let tmuxAdoptionStarted = false

/** Same latch pattern for the MCP command dispatcher: exactly one subscriber
 *  per process, or concurrent tool calls would get duplicate responses. */
let mcpDispatcherStarted = false

export function AppShell() {
  const sidebarOpen = useSessionStore((s) => s.sidebarOpen)
  // No traffic lights in fullscreen, so no clearance to hold for them.
  const trafficLights = useTrafficLights()
  const sidebarWidth = useSessionStore((s) => s.sidebarWidth)
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)
  const setSidebarWidth = useSessionStore((s) => s.setSidebarWidth)
  const theme = useSessionStore((s) => s.theme)
  const treeRuleIntensity = useSessionStore((s) => s.treeRuleIntensity)
  const toggleFilePalette = useSessionStore((s) => s.toggleFilePalette)
  const fileTreeOpen = useSessionStore((s) => s.fileTreeOpen)
  const fileTreeWidth = useSessionStore((s) => s.fileTreeWidth)
  const fileTreeWidthOverride = useSessionStore((s) => s.fileTreeWidthOverride)
  const toggleFileTree = useSessionStore((s) => s.toggleFileTree)
  const setFileTreeWidth = useSessionStore((s) => s.setFileTreeWidth)
  const activeView = useSessionStore((s) => s.activeView)
  const previewFile = useSessionStore((s) => s.previewFile)
  const previewSource = useSessionStore((s) => s.previewSource)
  const filePaletteShortcut = useShortcutLabel('openFilePalette')
  const sidePanelShortcut = useShortcutLabel('toggleSidePanel')

  const addSession = useSessionStore((s) => s.addSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const removeFileTab = useSessionStore((s) => s.removeFileTab)
  const resetSessions = useSessionStore((s) => s.resetSessions)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)

  useWorkTracker()

  // The window's title names its workspace — what tells windows apart in
  // Mission Control and the Window menu (the title bar itself is hidden).
  const activeWorkspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? null
  )
  useEffect(() => {
    document.title = activeWorkspaceName ? `${activeWorkspaceName} — Clave` : 'Clave'
  }, [activeWorkspaceName])

  // Wire the in-app MCP command dispatcher and the secret-request store to
  // their main-process push channels. The module-level latch makes this run
  // exactly once per process even under React StrictMode's mount/remount, so
  // neither channel is double-subscribed. Both live for the process lifetime.
  useEffect(() => {
    if (mcpDispatcherStarted) return
    mcpDispatcherStarted = true
    initMcpDispatcher()
    initSecretStore()
    initCopyOfferStore()
    // Re-homing: take in what another window hands over — a closing window's
    // sessions with its groups, a tab or a group moved here — and drop a tab
    // whose session moved AWAY (moved, not died — never kill the pty). The
    // groups land first so the adopted members find their group.
    window.electronAPI?.onSessionRehome?.(({ sessionIds, layout, focus }) => {
      if (layout) {
        useSessionStore
          .getState()
          .absorbLayout(layout as { groups: SessionGroup[]; displayOrder: string[] })
      }
      void adoptRehomed(sessionIds, useWorkspaceStore.getState().activeWorkspaceId, focus === true)
    })
    window.electronAPI?.onSessionRemovedForRehome?.((id) => {
      useSessionStore.getState().removeSessionForRehome(id)
    })
    window.electronAPI?.onGroupRemovedForMove?.((groupId) => {
      useSessionStore.getState().removeGroupForMove(groupId)
    })
    // What the agent button relaunches, per workspace. Deliberately NOT in the
    // session-adoption effect below: that one awaits the "restore sessions?"
    // prompt, so anything after it waits on the user answering a dialog — and
    // the launcher would show the wrong remembered agent until they did. The
    // map is keyed by workspace id and read at render time, so it does not care
    // whether it lands before or after the workspace registry.
    void loadLaunchPrefs()
    void loadLaunchProfiles()
  }, [])

  useEffect(() => {
    if (tmuxAdoptionStarted) return
    tmuxAdoptionStarted = true
    void (async () => {
      try {
        // Workspace registry + pins hydrate FIRST: adoption stamps each
        // surviving session against it, and unstamped survivors fall back to
        // the active workspace. (This is the single sequential boot owner —
        // the old lazy loadWorkspaces() in Sidebar raced this effect.)
        await bootWorkspaces()
        const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId

        // Read this window's saved groups BEFORE any session is adopted
        // (re-adoption mutates the layout). Then rebuild groups around the
        // survivors and only then turn persistence on, so the file is never
        // overwritten before we've loaded it. One file per window; the
        // primary's load also brings in the orphans of windows that no
        // longer exist.
        const savedLayout = await window.electronAPI?.sidebarLayoutLoad?.().catch(() => null)
        const persisted = {
          groups: (savedLayout?.groups ?? []) as SessionGroup[],
          displayOrder: savedLayout?.displayOrder ?? []
        }

        // This window's own records (plus the orphans, for the primary):
        // live tmux survivors re-attach silently, whatever their workspace
        // (hidden where not the shown one, so cross-workspace messaging and
        // clave_list never regress); dead records are offered once, all
        // together, as they always were.
        //
        // Not every record is a TAB, though — a group's quick-launch
        // terminal, a session view's server and a toolbar button's dev
        // server all leave one behind. planBootAdoption sorts them by what
        // the record says the session IS, so the hidden halves come back
        // where they belong instead of as rows beside the groups.
        const survivors = (await window.electronAPI?.listSessionRecords?.()) ?? []
        const plan = planBootAdoption(survivors)

        const adoptedIds: string[] = []
        for (const s of plan.liveTabs) {
          const id = await adoptRecord(s, activeWorkspaceId)
          if (id) adoptedIds.push(id)
        }
        if (plan.deadTabs.length > 0) {
          if (await promptRestore(plan.deadTabs)) {
            for (const s of plan.deadTabs) {
              const id = await adoptRecord(s, activeWorkspaceId)
              if (id) adoptedIds.push(id)
            }
          } else {
            for (const s of plan.deadTabs) {
              void window.electronAPI?.discardSessionRecord?.(s.tmuxName ?? s.id)
            }
          }
        }
        // A dead hidden half has nothing worth restoring: relaunching it
        // gives a bare shell in the same cwd, not the dev server that died,
        // and its owner's start action is the way back. Drop the record so
        // it can never surface as a tab.
        for (const s of plan.discard) {
          void window.electronAPI?.discardSessionRecord?.(s.tmuxName ?? s.id)
        }
        // Toolbar terminals are not sidebar citizens at all: park each live
        // one for its button, which reattaches when next opened instead of
        // starting a second server on the same port.
        for (const s of plan.toolbar) {
          if (s.link?.kind === 'toolbar') parkToolbarSurvivor(s.link.key, s)
        }

        // Rebuild the layout around what survives: a group is kept if a
        // member — or a running quick-launch terminal — came back. The
        // hidden halves count as surviving here even though they are adopted
        // just below: leaving them out is what detached a group terminal
        // from its row and then pruned the group for looking empty. Every
        // workspace's groups live in this one file, so every key is merged
        // (null = the unscoped ones).
        const keys: (string | null)[] = [
          null,
          ...useWorkspaceStore.getState().workspaces.map((w) => w.id)
        ]
        useSessionStore
          .getState()
          .mergeLayoutForKeys(keys, persisted, survivingIds(plan, adoptedIds))

        // Owners are in place now (groups from the merge, owning tabs from
        // the adoption above), so the hidden halves can hang themselves back
        // off them.
        for (const s of plan.hidden) {
          await adoptHiddenRecord(s, activeWorkspaceId)
        }
      } catch (err) {
        console.error('Failed to restore sessions/groups on launch:', err)
      } finally {
        // Turn persistence on only now — after the saved layout was loaded
        // and groups restored — so adoption writes can't clobber the file.
        enableSidebarPersistence()
        // And the history ledger's diff: the restored tabs are stamped where
        // they actually sit, not mid-restore (PRDCT-1738).
        startSessionHistoryStamping()
      }

      // Boot tail: land the initial selection in the active workspace, start
      // watching every file-backed pin (all workspaces — hidden ones stay
      // fresh), and refresh the active workspace's pins from its files.
      useSessionStore
        .getState()
        .applyWorkspaceSwitch(null, useWorkspaceStore.getState().activeWorkspaceId)
      initClaveFileWatchers()
      void refreshActiveWorkspacePins()
    })()
  }, [addSession])

  const sidebarRef = useRef<HTMLDivElement>(null)
  const fileTreeRef = useRef<HTMLDivElement>(null)
  const skipTransition = useRef(false)
  const [draggingLeft, setDraggingLeft] = useState(false)
  const [draggingRight, setDraggingRight] = useState(false)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setDraggingLeft(true)
      skipTransition.current = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMouseMove = (ev: MouseEvent) => {
        const w = Math.max(180, Math.min(480, ev.clientX))
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${w}px`
        }
      }

      const onMouseUp = (ev: MouseEvent) => {
        const w = Math.max(180, Math.min(480, ev.clientX))
        setSidebarWidth(w)
        // Keep skipTransition true briefly so Framer doesn't animate to the committed value
        requestAnimationFrame(() => {
          skipTransition.current = false
        })
        setDraggingLeft(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [setSidebarWidth]
  )

  const handleTreeResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setDraggingRight(true)
      skipTransition.current = true
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMouseMove = (ev: MouseEvent) => {
        const w = Math.max(180, Math.min(400, window.innerWidth - ev.clientX))
        if (fileTreeRef.current) {
          fileTreeRef.current.style.width = `${w}px`
        }
      }

      const onMouseUp = (ev: MouseEvent) => {
        const w = Math.max(180, Math.min(400, window.innerWidth - ev.clientX))
        setFileTreeWidth(w)
        requestAnimationFrame(() => {
          skipTransition.current = false
        })
        setDraggingRight(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [setFileTreeWidth]
  )

  const keymapActions = useMemo<KeymapActionHandlers>(() => {
    const launch = (
      setup: Parameters<typeof launchSession>[0]['setup'],
      cwd: 'workspace-root' | 'ask',
      remember = setup !== null
    ): void => {
      void launchSession({ setup, cwd: { kind: cwd }, remember })
    }
    const selectByIndex = (index: number): void => {
      const state = useSessionStore.getState()
      const ids = getVisibleFlatOrder(state, useWorkspaceStore.getState().activeWorkspaceId)
      if (index < ids.length) state.selectSession(ids[index], false)
    }
    const cycleSession = (direction: 1 | -1): void => {
      const state = useSessionStore.getState()
      const ids = getVisibleFlatOrder(state, useWorkspaceStore.getState().activeWorkspaceId)
      if (ids.length === 0) return
      const current = ids.indexOf(state.focusedSessionId ?? '')
      const next =
        current < 0
          ? direction === 1
            ? 0
            : ids.length - 1
          : (current + direction + ids.length) % ids.length
      state.selectSession(ids[next], false)
    }
    const togglePanel = (tab: 'git' | 'help'): void => {
      const state = useSessionStore.getState()
      if (state.fileTreeOpen && state.sidePanelTab === tab) state.toggleFileTree()
      else {
        if (!state.fileTreeOpen) state.toggleFileTree()
        useSessionStore.getState().setSidePanelTab(tab)
      }
    }
    const actions = {
      newTerminal: () => launch(null, 'workspace-root', false),
      newTerminalAtFolder: () => launch(null, 'ask', false),
      newClaude: () => launch({ kind: 'claude', dangerousMode: false }, 'workspace-root'),
      newClaudeAtFolder: () => launch({ kind: 'claude', dangerousMode: false }, 'ask'),
      newDangerousClaude: () => launch({ kind: 'claude', dangerousMode: true }, 'workspace-root'),
      newDangerousClaudeAtFolder: () => launch({ kind: 'claude', dangerousMode: true }, 'ask'),
      newClaudeAgents: () =>
        launch({ kind: 'claude-agents', dangerousMode: false }, 'workspace-root'),
      newClaudeAgentsAtFolder: () => launch({ kind: 'claude-agents', dangerousMode: false }, 'ask'),
      newAntigravity: () => launch({ kind: 'antigravity', dangerousMode: false }, 'workspace-root'),
      newAntigravityAtFolder: () => launch({ kind: 'antigravity', dangerousMode: false }, 'ask'),
      newCodex: () => launch({ kind: 'codex', dangerousMode: false }, 'workspace-root'),
      newCodexAtFolder: () => launch({ kind: 'codex', dangerousMode: false }, 'ask'),
      newYoloCodex: () => launch({ kind: 'codex', dangerousMode: true }, 'workspace-root'),
      newYoloCodexAtFolder: () => launch({ kind: 'codex', dangerousMode: true }, 'ask'),
      newPi: () => launch({ kind: 'pi', dangerousMode: false }, 'workspace-root'),
      newPiAtFolder: () => launch({ kind: 'pi', dangerousMode: false }, 'ask'),
      toggleSidebar: () => toggleSidebar(),
      toggleSidePanel: () => toggleFileTree(),
      openFilePalette: () => toggleFilePalette(),
      openGitPanel: () => togglePanel('git'),
      openHistory: () => {
        const history = useHistoryStore.getState()
        if (history.open) history.closeHistory()
        else history.openHistory(null)
      },
      openHelp: () => togglePanel('help'),
      openSettings: () => useSessionStore.getState().setActiveView('settings'),
      focusSidebarSearch: () => {
        const state = useSessionStore.getState()
        if (!state.sidebarOpen) state.toggleSidebar()
        setTimeout(
          () => document.querySelector<HTMLInputElement>('[data-sidebar-search]')?.focus(),
          50
        )
      },
      closeFocused: () => {
        const sid = useSessionStore.getState().focusedSessionId
        if (sid && isFileTabId(sid)) removeFileTab(sid)
        else window.close()
      },
      killFocusedSession: () => {
        const sid = useSessionStore.getState().focusedSessionId
        if (!sid) return
        if (isFileTabId(sid)) removeFileTab(sid)
        else {
          const current = useSessionStore.getState()
          const closing = current.sessions.find((session) => session.id === sid)
          if (closing) emitTabClosed(closing, current.groups, 'user', null)
          void window.electronAPI.killSession(sid).catch(() => {})
          removeSession(sid)
        }
      },
      previousWorkspace: () => cycleWorkspace(-1),
      nextWorkspace: () => cycleWorkspace(1),
      previousSession: () => cycleSession(-1),
      nextSession: () => cycleSession(1),
      selectSession1: () => selectByIndex(0),
      selectSession2: () => selectByIndex(1),
      selectSession3: () => selectByIndex(2),
      selectSession4: () => selectByIndex(3),
      selectSession5: () => selectByIndex(4),
      selectSession6: () => selectByIndex(5),
      selectSession7: () => selectByIndex(6),
      selectSession8: () => selectByIndex(7),
      selectSession9: () => selectByIndex(8),
      groupSelectedSessions: () => {
        const state = useSessionStore.getState()
        if (state.selectedSessionIds.length > 0) state.createGroup(state.selectedSessionIds)
      },
      ungroupSelectedSessions: () => {
        const state = useSessionStore.getState()
        const group = state.groups.find(
          (candidate) =>
            state.selectedSessionIds.length > 0 &&
            state.selectedSessionIds.every((id) => candidate.sessionIds.includes(id))
        )
        if (group) void requestGroupDissolve(group.id, 'ungroup')
      },
      resetSessions: () => {
        if (useSessionStore.getState().sessions.length > 0) setResetConfirmOpen(true)
      },
      undoSidebar: () => {
        const state = useSessionStore.getState()
        if (state.sidebarUndoStack.length > 0) state.undoSidebar()
      },
      newWindow: () => void window.electronAPI.windowOpen()
    } satisfies KeymapActionHandlers
    return actions
  }, [removeFileTab, removeSession, toggleFilePalette, toggleFileTree, toggleSidebar])
  const commandHud = useKeymapManager(keymapActions)

  // Sync data-theme attribute to root element
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // The weight of every tree's row rules, as a multiplier on the theme's own
  // --rule-alpha. One property on the root element is the whole mechanism: the
  // Files tab, the git repo tree and the changed files inside a repo all draw
  // .tree-rule, so they move together and nothing has to be told about it.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--rule-intensity',
      String(treeRuleMultiplier(treeRuleIntensity))
    )
  }, [treeRuleIntensity])

  // Updater: subscribe to main's state and pull the current truth on mount.
  // The pull is the point — a push-only updater loses the "an update exists"
  // fact for 30 minutes if the renderer was not listening when it fired.
  useEffect(() => connectUpdaterStore(), [])
  useEffect(() => connectKeymapStore(), [])

  // Open Settings → Updates when asked from the native menu.
  useEffect(() => {
    if (!window.electronAPI?.onOpenSettingsSection) return
    return window.electronAPI.onOpenSettingsSection((section) => {
      useSessionStore.getState().openSettings(section as SettingsSection)
    })
  }, [])

  // Handle notification click → switch to session
  useEffect(() => {
    if (!window.electronAPI?.onNotificationClicked) return
    return window.electronAPI.onNotificationClicked((sessionId) => {
      useSessionStore.getState().selectSession(sessionId, false)
    })
  }, [])

  // Handle SSH connection closed → mark remote sessions as ended
  useEffect(() => {
    if (!window.electronAPI?.onSshConnectionClosed) return
    return window.electronAPI.onSshConnectionClosed((locationId) => {
      useSessionStore.setState((state) => {
        const remoteSessions = state.sessions.filter(
          (s) =>
            s.locationId === locationId &&
            (s.sessionType === 'remote-terminal' || s.sessionType === 'remote-claude')
        )
        if (remoteSessions.length === 0) return {}
        return {
          sessions: state.sessions.map((s) =>
            s.locationId === locationId &&
            (s.sessionType === 'remote-terminal' || s.sessionType === 'remote-claude')
              ? { ...s, alive: false, activityStatus: 'ended' as const }
              : s
          )
        }
      })
    })
  }, [])

  // Sync agent STATUS updates to existing agent sessions in the sidebar.
  // Does NOT auto-add agents — only the picker adds agents to the sidebar.
  // Only updates sessions array when status actually changed to avoid unnecessary re-renders.
  const syncAgentStatus = useCallback(
    (locationId: string, typedAgents: import('../../../../shared/remote-types').Agent[]) => {
      useSessionStore.setState((state) => {
        const currentAgentSessions = state.sessions.filter(
          (s) => s.sessionType === 'agent' && s.locationId === locationId
        )
        if (currentAgentSessions.length === 0) return {}

        const incomingMap = new Map(typedAgents.map((a) => [a.id, a]))
        const updates: Array<{
          sessionId: string
          alive: boolean
          activityStatus: import('../../store/session-types').ActivityStatus
          cwd?: string
        }> = []

        for (const session of currentAgentSessions) {
          if (!session.agentId) continue
          const agent = incomingMap.get(session.agentId)
          if (agent) {
            const alive = agent.status !== 'offline'
            const activityStatus: import('../../store/session-types').ActivityStatus =
              agent.status === 'busy' ? 'active' : agent.status === 'offline' ? 'ended' : 'idle'
            const cwd = agent.cwd
            if (
              session.alive !== alive ||
              session.activityStatus !== activityStatus ||
              (cwd && session.cwd !== cwd)
            ) {
              updates.push({ sessionId: session.id, alive, activityStatus, cwd })
            }
          } else {
            // Agent disappeared — mark offline if not already
            if (session.alive || session.activityStatus !== 'ended') {
              updates.push({ sessionId: session.id, alive: false, activityStatus: 'ended' })
            }
          }
        }

        if (updates.length === 0) return {}

        const updateMap = new Map(updates.map((u) => [u.sessionId, u]))
        return {
          sessions: state.sessions.map((s) => {
            const update = updateMap.get(s.id)
            return update
              ? {
                  ...s,
                  alive: update.alive,
                  activityStatus: update.activityStatus,
                  ...(update.cwd ? { cwd: update.cwd } : {})
                }
              : s
          })
        }
      })
    },
    []
  )

  // Subscribe to agent updates from OpenClaw connections
  useEffect(() => {
    if (!window.electronAPI?.onAgentsUpdated) return
    return window.electronAPI.onAgentsUpdated((locationId, agents) => {
      const typedAgents = agents as import('../../../../shared/remote-types').Agent[]
      useAgentStore.getState().setAgents(locationId, typedAgents)
      // Load conversation history for newly discovered agents
      const agentIds = typedAgents.map((a) => a.id)
      if (agentIds.length > 0) {
        useAgentStore.getState().loadHistory(locationId, agentIds)
      }
      syncAgentStatus(locationId, typedAgents)
    })
  }, [syncAgentStatus])

  // One-time status sync: if agent sessions already exist and agents are loaded,
  // update their status (e.g., after HMR or window reload)
  useEffect(() => {
    const agentState = useAgentStore.getState()
    if (agentState.agents.length > 0) {
      const byLocation = new Map<string, import('../../../../shared/remote-types').Agent[]>()
      for (const agent of agentState.agents) {
        const list = byLocation.get(agent.locationId) || []
        list.push(agent)
        byLocation.set(agent.locationId, list)
      }
      for (const [locationId, agents] of byLocation) {
        syncAgentStatus(locationId, agents)
      }
    }
  }, [syncAgentStatus])

  const effectiveFileTreeWidth = fileTreeWidthOverride ?? fileTreeWidth

  return (
    <div className="flex h-screen w-screen bg-surface-50 overflow-hidden transition-colors duration-200">
      {/* Title bar drag region — covers the full background area */}
      <div
        className="absolute inset-x-0 top-0 h-12 z-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      {/* Left sidebar */}
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.div
            ref={sidebarRef}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: sidebarWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={skipTransition.current ? { duration: 0 } : sidebarTransition}
            // Named so a popover anchored inside the sidebar can measure the
            // edge it has to clear (the group terminals panel).
            data-sidebar-shell
            className="flex-shrink-0 overflow-hidden relative z-10"
          >
            {/* Settings mode swaps in its own navigation sidebar */}
            {activeView === 'settings' ? (
              <SettingsSidebar />
            ) : activeView === 'extensions' ? (
              <ExtensionsSidebar />
            ) : (
              <Sidebar />
            )}
            {/* Resize handle — wide invisible hit area, thin visible line */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute top-0 right-0 w-2.5 h-full cursor-col-resize z-10 group/resize"
            >
              <div
                className={cn(
                  'absolute top-0 right-0 h-full transition-colors border-r border-border/20',
                  draggingLeft ? 'bg-accent' : 'group-hover/resize:bg-accent/50'
                )}
                style={{ width: '1.5px' }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inset main content — transparent flex container for floating boxes */}
      <div
        className={cn(
          'flex-1 flex flex-col min-w-0 my-2 gap-2 z-10 transition-[margin] duration-200',
          sidebarOpen ? 'ml-1' : 'ml-2',
          fileTreeOpen ? 'mr-1' : 'mr-2'
        )}
      >
        {/* Toolbar — its own floating card. Its row height is a token because
            the sidebar derives from it: --content-top-offset, and with it the
            launcher panel's top edge, is measured off this bar. */}
        <div className="floating-card flex-shrink-0 !bg-surface-0/70">
          <div
            data-toolbar-row
            className={cn(
              'h-[var(--toolbar-row-h)] flex items-center justify-between px-0.5 flex-shrink-0',
              // With the sidebar closed the toolbar is what runs under the
              // traffic lights, so it holds their width open. Whenever they are
              // not there — macOS fullscreen, or any Windows or Linux window,
              // which keeps a native frame and its controls above our content —
              // that padding is a hole with the sidebar button parked to the
              // right of it, so it goes and the button sits where every other
              // toolbar control does.
              !sidebarOpen && trafficLights && 'pl-[4.75rem]'
            )}
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {/* Left — sidebar toggle */}
            <div
              className="flex items-center gap-2"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <button
                onClick={toggleSidebar}
                className="btn-icon btn-icon-md"
                title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              >
                <Bars3BottomLeftIcon className="w-4 h-4" />
              </button>
            </div>

            {/* Center — active workspace, and the switcher behind it */}
            <ToolbarWorkspacePopover />

            {/* Right — quick actions + divider + search + file tree */}
            <div
              className="flex items-center gap-0.5 min-w-0"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <ToolbarQuickActions />
              <ToolbarSecretPopover />
              {/* File palette button */}
              <button
                onClick={toggleFilePalette}
                className="btn-icon btn-icon-md flex-shrink-0"
                title={`Search files${filePaletteShortcut ? ` (${filePaletteShortcut})` : ''}`}
              >
                <MagnifyingGlassIcon className="w-4 h-4" />
              </button>
              {/* File tree button */}
              <button
                onClick={toggleFileTree}
                className={cn('btn-icon btn-icon-md flex-shrink-0', fileTreeOpen && '!text-accent')}
                title={`File tree${sidePanelShortcut ? ` (${sidePanelShortcut})` : ''}`}
              >
                <Bars3BottomLeftIcon className="w-4 h-4 scale-x-[-1]" />
              </button>
            </div>
          </div>
        </div>

        {/* Non-terminal views — single floating card */}
        <div
          className={cn(
            'flex-1 min-h-0 floating-card',
            activeView === 'terminals' ? 'hidden' : 'flex'
          )}
        >
          {/* view-fade-in re-fires each time a hidden panel is shown (display:none
              kills the animation, re-display restarts it). Terminals stay instant. */}
          <div
            className={activeView === 'settings' ? 'flex-1 flex min-h-0 view-fade-in' : 'hidden'}
          >
            <SettingsPanel />
          </div>
          <div className={activeView === 'agents' ? 'flex-1 flex min-h-0 view-fade-in' : 'hidden'}>
            <AgentChatPanel />
          </div>
          <div
            className={activeView === 'extensions' ? 'flex-1 flex min-h-0 view-fade-in' : 'hidden'}
          >
            <ExtensionsPanel />
          </div>
        </div>

        {/* Terminal grid — each terminal is its own floating card */}
        <div className={activeView === 'terminals' ? 'flex-1 flex min-h-0' : 'hidden'}>
          <TerminalGrid />
        </div>
      </div>

      {/* Right sidebar (file tree / git panel) — outside the card, mirrors left sidebar */}
      <AnimatePresence initial={false}>
        {fileTreeOpen && (
          <motion.div
            ref={fileTreeRef}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: effectiveFileTreeWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={skipTransition.current ? { duration: 0 } : sidebarTransition}
            className="flex-shrink-0 overflow-hidden relative z-[45]"
          >
            {/* Resize handle */}
            {/* Resize handle — wide invisible hit area, thin visible line */}
            <div
              onMouseDown={handleTreeResizeStart}
              className="absolute top-0 left-0 w-2.5 h-full cursor-col-resize z-10 group/resize"
            >
              <div
                className={cn(
                  'absolute top-0 left-0 h-full transition-colors border-l border-border/20',
                  draggingRight ? 'bg-accent' : 'group-hover/resize:bg-accent/50'
                )}
                style={{ width: '1.5px' }}
              />
            </div>
            <SidePanel />
          </motion.div>
        )}
      </AnimatePresence>

      <FilePalette />
      {previewFile && previewSource === 'tree' && <FilePreview />}
      <GitDiffPreview />
      <GitJourneyPanel />
      <UpdateOverlay />
      <MissionControlOverlay />
      <SessionHistoryDialog />
      <RestorePromptDialog />
      <KeymapCommandHud hud={commandHud} />
      <ConfirmDialog
        isOpen={resetConfirmOpen}
        title="Reset sessions"
        message="Close all sessions and start fresh?"
        onConfirm={() => {
          setResetConfirmOpen(false)
          void resetSessions()
        }}
        onCancel={() => setResetConfirmOpen(false)}
      />
      {/* Delete / Ungroup a group whose quick-launch terminals are running.
          Rendered HERE, not in the Sidebar: the ungroup keybinding is global
          and fires with the sidebar closed or Settings open, when the
          Sidebar is unmounted — a dialog living there would never show and
          the pending answer would pop up as a ghost the next time the
          sidebar opened. */}
      <DissolveConfirmDialog />
    </div>
  )
}

function DissolveConfirmDialog(): React.JSX.Element {
  const pending = useDissolveStore((s) => s.pending)
  const confirm = useDissolveStore((s) => s.confirm)
  const cancel = useDissolveStore((s) => s.cancel)
  return (
    <ConfirmDialog
      isOpen={pending !== null}
      title={pending?.confirmation.title ?? ''}
      message={pending?.confirmation.message ?? ''}
      confirmLabel={pending?.confirmation.confirmLabel}
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  )
}

function ToolbarQuickActions() {
  const pinnedGroups = usePinnedStore((s) => s.pinnedGroups)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [openId, setOpenId] = useState<string | null>(null)

  // Toolbar buttons of the ACTIVE workspace only — hidden workspaces' dev
  // servers keep running (their sessions live in the registry), the buttons
  // just come back when switching back.
  const toolbarPins = pinnedGroups.filter(
    (pg) => pg.toolbar && inActiveWorkspace(pg, activeWorkspaceId)
  )
  if (toolbarPins.length === 0) return null

  // Darken color for better toolbar contrast
  const darken = (hex: string | undefined): string | undefined => {
    if (!hex) return undefined
    // Mix with black at 30% to darken
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const f = 0.7
    return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`
  }

  return (
    <>
      {toolbarPins.map((pg, pgIdx) => (
        <div key={pg.id} className="flex items-center gap-0.5 flex-shrink-0">
          {pgIdx > 0 && <div className="w-px h-3.5 bg-border-subtle mx-0.5" />}
          {pg.terminals.map((t, i) => {
            const key = `${pg.id}-${i}`
            const IconComp = getTerminalIconComponent(t.icon)
            const colorHex = darken(resolveColorHex(t.color))
            return (
              <ToolbarTerminalPopover
                key={key}
                cwd={t.cwd || pg.cwd || '.'}
                registryKey={`${pg.id}:${i}`}
                command={t.command}
                // A declared serverUrl implies persistent: closing the popover
                // must never kill the server the click just asked to exist.
                persistent={t.persistent || !!t.serverUrl}
                serverUrl={t.serverUrl}
                open={openId === key}
                onOpenChange={(open) => setOpenId(open ? key : null)}
                header={<IconComp className="w-3.5 h-3.5 shrink-0" style={{ color: colorHex }} />}
              >
                {t.serverUrl ? (
                  (api) => (
                    <button
                      onClick={(e) => {
                        if (e.altKey) api.openTerminalOnly()
                        else api.handleClick()
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        api.openTerminalOnly()
                      }}
                      className="btn-icon btn-icon-md relative"
                      style={{ color: colorHex }}
                      title={api.title}
                    >
                      <IconComp className="w-4 h-4" />
                      {api.state !== 'unknown' && (
                        <span
                          className={cn(
                            'absolute right-0.5 bottom-0.5 w-1.5 h-1.5 rounded-full',
                            api.state === 'up' && 'bg-emerald-500',
                            api.state === 'starting' && 'bg-amber-400 animate-pulse',
                            api.state === 'down' && 'bg-text-tertiary'
                          )}
                        />
                      )}
                    </button>
                  )
                ) : (
                  <button
                    className="btn-icon btn-icon-md"
                    style={{ color: colorHex }}
                    title={t.command || 'Shell'}
                  >
                    <IconComp className="w-4 h-4" />
                  </button>
                )}
              </ToolbarTerminalPopover>
            )
          })}
        </div>
      ))}
      <div className="w-px h-3.5 bg-border-subtle mx-0.5 flex-shrink-0" />
    </>
  )
}
