import { useSkinStore } from '../lib/skin'
import { emitAgentStateWord, emitSessionExited } from '../lib/exchange-capture'
import { codexStateFromTitle } from '../../../shared/codex-state'
import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessionStore } from '../store/session-store'
import { shellEscape } from '../lib/shell'
import { getXtermTheme } from '../lib/terminal-theme'
import { safePort } from '../lib/utils'
import { stripAnsi, detectLocalhostUrl } from '../lib/localhost-url'
import { registerTerminal, unregisterTerminal } from '../lib/terminal-registry'
import { writeUserInput } from '../lib/user-input'
import '@xterm/xterm/css/xterm.css'

function detectPrompt(buffer: string): string | null {
  // Collapse whitespace for matching (ANSI stripping removes cursor positioning,
  // leaving words glued together or with inconsistent spacing)
  const tail = buffer.slice(-500)
  // Claude Code permission/action prompt: keyboard hints at the bottom
  // After ANSI strip these appear as "Esctocancel", "Tabtoamend", etc.
  if (/Esc.*cancel/i.test(tail)) return 'is asking for permission'
  // Legacy/alternative: "Allow" and "Deny" buttons
  if (/Allow/i.test(tail) && /Deny/i.test(tail)) return 'is asking for permission'
  // Explicit yes/no confirmation
  if (/\(Y\/n\)|\[Y\/n\]|\(y\/N\)|\[y\/N\]/i.test(tail)) return 'is asking a question'
  return null
}

export function useTerminal(sessionId: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isVisibleRef = useRef(false)
  const theme = useSessionStore((s) => s.theme)
  const skinRevision = useSkinStore((s) => s.revision)

  const fit = useCallback(() => {
    fitAddonRef.current?.fit()
  }, [])

  // Create terminal on mount
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      theme: getXtermTheme(useSessionStore.getState().theme),
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: false,
      scrollback: 10000,
      linkHandler: {
        activate: (_event, text) => {
          window.electronAPI.openExternal(text)
        }
      }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.open(container)

    let hasFit = false
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
      hasFit = true
    }
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    registerTerminal(sessionId, terminal)

    // Breathing room above the first line, written INTO the buffer rather than
    // set as CSS padding: padding on .xterm insets the viewport permanently,
    // while this scrolls away with the content the way it should — the gap
    // only exists at the top of the scrollback, where the emptiness looks odd.
    terminal.write('\r\n')

    // User input -> PTY through the shared helper, which mirrors it into the
    // session's draft shadow (PRDCT-1569: clave_send_to_session stashes,
    // clears, and restores a half-typed draft).
    const writeUser = (data: string): void => writeUserInput(sessionId, data)

    // Custom key bindings — bypass xterm.js local processing, send directly to PTY
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Shift+Enter → newline
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        writeUser('\n')
        return false
      }
      // Option+Backspace → word delete backward
      if (e.key === 'Backspace' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        writeUser('\x1b\x7f')
        return false
      }
      // Option+Delete → forward word delete
      if (e.key === 'Delete' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        writeUser('\x1bd')
        return false
      }
      // Option+Left → word backward
      if (e.key === 'ArrowLeft' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        writeUser('\x1bb')
        return false
      }
      // Option+Right → word forward
      if (e.key === 'ArrowRight' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        writeUser('\x1bf')
        return false
      }
      return true
    })

    // Wire terminal input -> PTY
    const inputDisposable = terminal.onData((data) => {
      writeUser(data)
    })

    // Wire terminal resize -> PTY.
    // We rely on the *fit* being debounced (ResizeObserver below + scheduleFit
    // in the layout effect both wait for the animation to settle). xterm only
    // fires onResize when fit actually changes the grid, so by the time we
    // get here the size has already settled — forward to the PTY immediately
    // so xterm grid and PTY winsize stay in lockstep. A stale debounce here
    // is what produced the "PTY says N cols, xterm grid says M cols" drift
    // that corrupts the screen during resize.
    let lastSentCols = terminal.cols
    let lastSentRows = terminal.rows
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (cols === lastSentCols && rows === lastSentRows) return
      lastSentCols = cols
      lastSentRows = rows
      window.electronAPI.resizeSession(sessionId, cols, rows)
    })

    const { setSessionActivity, setAgentState, setSessionPromptWaiting, setSessionDetectedUrl, setSessionServerStatus, setSessionServerCommand, setSessionUnseenActivity, updateSessionAlive, autoRenameSession, resetSessionName, setSessionPlanFile } = useSessionStore.getState()

    // Listen for auto-generated titles from the main process
    const cleanupAutoTitle = window.electronAPI.onSessionAutoTitle(sessionId, (title) => {
      autoRenameSession(sessionId, title)
    })

    // Listen for plan file detection
    const cleanupPlanDetected = window.electronAPI.onPlanDetected(sessionId, (planPath) => {
      setSessionPlanFile(sessionId, planPath)
    })

    // Listen for /clear command — reset session name to folder name
    const cleanupClearDetected = window.electronAPI.onClearDetected(sessionId, (newClaudeSessionId) => {
      resetSessionName(sessionId)
      // The tab follows its rotated transcript: store (Resume, the history
      // ledger's diff) and record (a restart's re-adoption) alike.
      // Same alphabet main enforces before touching the record: the store
      // and the record must never disagree on which conversation this is.
      if (newClaudeSessionId && /^[A-Za-z0-9_-]{1,128}$/.test(newClaudeSessionId)) {
        useSessionStore.getState().setClaudeSessionId(sessionId, newClaudeSessionId)
        void window.electronAPI.setSessionClaudeSessionId?.(sessionId, newClaudeSessionId)
      }
    })

    // Codex's TUI publishes its runtime state through OSC titles. xterm handles
    // fragmented escape sequences and both BEL/ST terminators for us. This
    // stays subscribed for background tabs, like the Claude/Pi hook listener.
    const titleDisposable = terminal.onTitleChange((title) => {
      const current = useSessionStore.getState()
      const session = current.sessions.find((s) => s.id === sessionId)
      if (!session?.codexMode || session.sessionType !== 'local' || !session.alive) return
      setAgentState(sessionId, codexStateFromTitle(title))
    })

    // Deterministic lifecycle state from Claude hooks or Clave's bundled Pi extension.
    const cleanupAgentState = window.electronAPI.onAgentState(sessionId, (state) => {
      if (state === 'idle' || state === 'working' || state === 'blocked' || state === 'done') {
        // Capture the transition BEFORE the store applies the word: the
        // session's current agentState is the event's `previous` (mapped,
        // so done→idle is a no-op and emits nothing).
        const current = useSessionStore.getState()
        const session = current.sessions.find((s) => s.id === sessionId)
        if (session) emitAgentStateWord(session, current.groups, state)
        setAgentState(sessionId, state)
      }
      // 'ended' is derived from the PTY exit / alive flag, so it's ignored here.
    })

    // Activity tracking: debounce from active → idle after silence
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    let activeStartTimer: ReturnType<typeof setTimeout> | null = null
    let notificationTimer: ReturnType<typeof setTimeout> | null = null
    let outputBuffer = ''
    let isMarkedActive = false
    let portCheckFailures = 0

    // Wire PTY output -> terminal
    const cleanupData = window.electronAPI.onSessionData(sessionId, (data) => {
      terminal.write(data)

      // Only mark active after sustained output (50ms) to avoid flicker from cursor blinks etc.
      if (!isMarkedActive) {
        if (!activeStartTimer) {
          activeStartTimer = setTimeout(() => {
            isMarkedActive = true
            setSessionActivity(sessionId, 'active')
            setSessionPromptWaiting(sessionId, null)
            activeStartTimer = null
          }, 50)
        }
      } else {
        setSessionPromptWaiting(sessionId, null)
      }

      // Append stripped data to rolling buffer (max 500 chars)
      const stripped = stripAnsi(data)
      outputBuffer = (outputBuffer + stripped).slice(-500)

      // Detect localhost URLs in output (skip for hidden terminals — detected on next visible chunk)
      if (isVisibleRef.current) {
        const detectedUrl = detectLocalhostUrl(outputBuffer)
        if (detectedUrl) {
          setSessionDetectedUrl(sessionId, detectedUrl)
          portCheckFailures = 0

          // Capture the server command from the group terminal config (if available)
          const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
          if (!currentSession?.serverCommand) {
            const group = useSessionStore.getState().groups.find((g) =>
              g.terminals.some((t) => t.sessionId === sessionId)
            )
            const terminalConfig = group?.terminals.find((t) => t.sessionId === sessionId)
            if (terminalConfig?.command) {
              setSessionServerCommand(sessionId, terminalConfig.command)
            }
          }
        }
      }

      // If a URL is set and we see signals the server was killed, verify immediately
      const currentUrl = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.detectedUrl
      if (currentUrl && /(\^C|SIGINT|SIGTERM|EADDRINUSE)/.test(stripped)) {
        const port = safePort(currentUrl)
        if (port) {
          // Small delay — let the process actually die
          setTimeout(() => {
            window.electronAPI.checkPort(port).then((alive) => {
              if (!alive) {
                setSessionServerStatus(sessionId, 'stopped')
                portCheckFailures = 0
              }
            })
          }, 500)
        }
      }

      // Mark unseen activity if this session is not currently selected
      const { selectedSessionIds } = useSessionStore.getState()
      if (!selectedSessionIds.includes(sessionId)) {
        setSessionUnseenActivity(sessionId, true)
      }

      if (activityTimer) clearTimeout(activityTimer)
      if (notificationTimer) {
        clearTimeout(notificationTimer)
        notificationTimer = null
      }

      activityTimer = setTimeout(() => {
        isMarkedActive = false
        if (activeStartTimer) {
          clearTimeout(activeStartTimer)
          activeStartTimer = null
        }
        setSessionActivity(sessionId, 'idle')

        // Check for prompt patterns after idle detection
        const promptType = detectPrompt(outputBuffer)
        setSessionPromptWaiting(sessionId, promptType)
        console.log('[notification] Idle detected, prompt check:', promptType, '| buffer tail:', outputBuffer.slice(-100))
        if (promptType) {
          notificationTimer = setTimeout(() => {
            const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
            const title = session?.name ?? session?.folderName ?? 'Clave'
            window.electronAPI.showNotification?.({
              title,
              body: `Claude ${promptType}`,
              sessionId
            })
          }, 3000)
        }
      }, 2000)
    })

    // Handle PTY exit
    const cleanupExit = window.electronAPI.onSessionExit(sessionId, () => {
      terminal.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n')
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = null
      if (notificationTimer) {
        clearTimeout(notificationTimer)
        notificationTimer = null
      }
      // The pty is gone for good: `session_state: exited` (source pty), stamped
      // while the identity is still in the store.
      {
        const current = useSessionStore.getState()
        const session = current.sessions.find((s) => s.id === sessionId)
        if (session) emitSessionExited(session, current.groups)
      }
      updateSessionAlive(sessionId, false)
      // Keep the URL so the button remains visible; mark as stopped
      const exitingSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (exitingSession?.detectedUrl) {
        setSessionServerStatus(sessionId, 'stopped')
      }

      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      const title = session?.name ?? session?.folderName ?? 'Clave'
      window.electronAPI.showNotification?.({
        title,
        body: 'Session has ended',
        sessionId
      })
    })

    // ResizeObserver for auto-fitting.
    // Trailing-only debounce: during a Framer Motion animation the observer
    // fires dozens of times. Fitting on every entry would resize xterm's grid
    // to many intermediate widths in succession; combined with the PTY
    // resize debounce above, an immediate fit would also let xterm rewrap
    // the buffer while Claude Code is still producing output for the old
    // width. We wait until width has settled, then fit once and refresh to
    // clear any glyphs left over from the interpolated widths.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width === 0 || height === 0) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit()
          terminal.refresh(0, terminal.rows - 1)
        } catch {
          // ignore
        }
      }, 250)
    })
    resizeObserver.observe(container)

    // Start the PTY at the real, post-fit cols/rows. We deliberately defer
    // pty.spawn() in main until this point so claude/agy are born at the
    // correct size — otherwise their welcome banner is laid out for 80×24
    // and then garbled when xterm reflows to the real width. If fit hasn't
    // run yet (container size 0), the ResizeObserver path will trigger
    // startSession via promote-on-first-resize in the main process once the
    // container has settled. We only call startSession once.
    let hasStarted = false
    const startIfPossible = (): void => {
      if (hasStarted) return
      if (terminal.cols < 2 || terminal.rows < 2) return
      hasStarted = true
      lastSentCols = terminal.cols
      lastSentRows = terminal.rows
      window.electronAPI.startSession(sessionId, terminal.cols, terminal.rows)
    }
    if (hasFit) startIfPossible()

    // Drag-and-drop file path insertion
    // Use capture phase so we intercept before xterm's internal elements
    const handleDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    const handleDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()

      if (!e.dataTransfer) return

      let paths: string[] = []

      // 1. Files from native file manager (Finder, etc.)
      if (e.dataTransfer.files.length > 0) {
        paths = Array.from(e.dataTransfer.files)
          .map((f) => window.electronAPI.getPathForFile(f))
          .filter(Boolean)
      }

      // 2. text/uri-list (VS Code, other apps)
      if (paths.length === 0) {
        const uriList = e.dataTransfer.getData('text/uri-list')
        if (uriList) {
          paths = uriList
            .split(/\r?\n/)
            .filter((line) => line.trim() && !line.startsWith('#'))
            .map((uri) => {
              try {
                const url = new URL(uri.trim())
                if (url.protocol === 'file:') {
                  return decodeURIComponent(url.pathname)
                }
              } catch {
                // not a valid URL
              }
              return ''
            })
            .filter(Boolean)
        }
      }

      // 3. text/plain fallback (file paths as plain text)
      if (paths.length === 0) {
        const text = e.dataTransfer.getData('text/plain')
        if (text) {
          paths = text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith('/') || l.startsWith('~'))
        }
      }

      // Persist any transient sources (e.g. macOS screenshot previews that live
      // in a temp dir and get deleted before the agent reads them) into stable
      // storage, then shell-escape and write the resulting paths to the PTY.
      const stablePaths = (
        await Promise.all(
          paths.filter(Boolean).map((p) => window.electronAPI.persistDroppedFile(p))
        )
      ).filter((p): p is string => Boolean(p))

      const escaped = stablePaths.map((p) => shellEscape(p))

      if (escaped.length > 0) {
        writeUser(escaped.join(' '))
        terminal.focus()
      }
    }

    container.addEventListener('dragover', handleDragOver, true)
    container.addEventListener('drop', handleDrop, true)

    // Periodically verify detected localhost URL is still reachable (fallback for missed signals)
    const portCheckInterval = setInterval(() => {
      if (!document.hasFocus() || !isVisibleRef.current) return
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (!session?.detectedUrl || session.serverStatus !== 'running') { portCheckFailures = 0; return }
      const port = safePort(session.detectedUrl)
      if (port) {
        window.electronAPI.checkPort(port).then((alive) => {
          if (alive) {
            portCheckFailures = 0
          } else {
            portCheckFailures++
            if (portCheckFailures >= 2) {
              setSessionServerStatus(sessionId, 'stopped')
              portCheckFailures = 0
            }
          }
        })
      }
    }, 3000)

    return () => {
      container.removeEventListener('dragover', handleDragOver, true)
      container.removeEventListener('drop', handleDrop, true)
      clearInterval(portCheckInterval)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (activityTimer) clearTimeout(activityTimer)
      if (activeStartTimer) clearTimeout(activeStartTimer)
      if (notificationTimer) clearTimeout(notificationTimer)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      cleanupAutoTitle()
      cleanupPlanDetected()
      cleanupClearDetected()
      cleanupAgentState()
      titleDisposable.dispose()
      cleanupData()
      cleanupExit()
      resizeObserver.disconnect()
      unregisterTerminal(sessionId, terminal)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme, skinRevision])

  // Track visibility and toggle cursor blink for hidden terminals.
  // Also re-fit when anything that alters the terminal grid's available width
  // changes: selection (split/4-view → single), the file tree / git panel
  // (open, width, drag-override), and the left sidebar. ResizeObserver alone
  // is unreliable here because Framer Motion's 200ms animation produces many
  // intermediate sizes, then stops firing — leaving the final fit missing.
  useEffect(() => {
    const initialState = useSessionStore.getState()
    isVisibleRef.current = initialState.selectedSessionIds.includes(sessionId)
    if (terminalRef.current) {
      terminalRef.current.options.cursorBlink = isVisibleRef.current
    }
    let pendingFitTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleFit = () => {
      if (pendingFitTimer) clearTimeout(pendingFitTimer)
      // 300ms outlasts Framer Motion's 200ms panel/sidebar animation so the
      // final fit observes the settled width. We deliberately do NOT fit
      // immediately: each intermediate fit during the animation would tell
      // the PTY (or at least xterm's grid) a new column count, and the TUI
      // would race to redraw at widths it never settles at — producing the
      // duplicated/short/long rows the user saw. Refresh clears stale glyphs.
      pendingFitTimer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
          terminalRef.current?.refresh(0, (terminalRef.current.rows ?? 1) - 1)
        } catch { /* ignore */ }
      }, 300)
    }
    const unsub = useSessionStore.subscribe((state, prevState) => {
      const selectionChanged = state.selectedSessionIds !== prevState.selectedSessionIds
      const layoutChanged =
        state.fileTreeOpen !== prevState.fileTreeOpen ||
        state.fileTreeWidth !== prevState.fileTreeWidth ||
        state.fileTreeWidthOverride !== prevState.fileTreeWidthOverride ||
        state.sidebarOpen !== prevState.sidebarOpen ||
        state.sidebarWidth !== prevState.sidebarWidth
      if (!selectionChanged && !layoutChanged) return
      if (selectionChanged) {
        const visible = state.selectedSessionIds.includes(sessionId)
        isVisibleRef.current = visible
        if (terminalRef.current) {
          terminalRef.current.options.cursorBlink = visible
        }
      }
      if (isVisibleRef.current) scheduleFit()
    })
    return () => {
      if (pendingFitTimer) clearTimeout(pendingFitTimer)
      unsub()
    }
  }, [sessionId])

  const focus = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  return { containerRef, fit, focus }
}
