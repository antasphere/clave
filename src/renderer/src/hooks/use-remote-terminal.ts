import { useSkinStore } from '../lib/skin'
import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessionStore } from '../store/session-store'
// The one xterm palette table. This hook used to carry its own copy, and it
// had already drifted: its LIGHT_THEME was still the pre-warm #ffffff set, so
// a remote terminal in the light theme sat on pure white inside a #fbfbf9
// card. A fourth theme would have been a fourth chance to drift.
import { getXtermTheme } from '../lib/terminal-theme'
import { safePort } from '../lib/utils'
import { stripAnsi, detectLocalhostUrl } from '../lib/localhost-url'
import '@xterm/xterm/css/xterm.css'

function detectPrompt(buffer: string): string | null {
  const tail = buffer.slice(-500)
  if (/Esc.*cancel/i.test(tail)) return 'is asking for permission'
  if (/Allow/i.test(tail) && /Deny/i.test(tail)) return 'is asking for permission'
  if (/\(Y\/n\)|\[Y\/n\]|\(y\/N\)|\[y\/N\]/i.test(tail)) return 'is asking a question'
  return null
}

export function useRemoteTerminal(shellId: string) {
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
      convertEol: true,
      linkHandler: {
        activate: (_event, text) => {
          window.electronAPI.openExternal(text)
        }
      }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.open(container)

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Custom key bindings — bypass xterm.js local processing, send directly to SSH shell
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Shift+Enter → newline
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        window.electronAPI.sshShellWrite(shellId, '\n')
        return false
      }
      // Option+Backspace → word delete backward
      if (e.key === 'Backspace' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        window.electronAPI.sshShellWrite(shellId, '\x1b\x7f')
        return false
      }
      // Option+Delete → forward word delete
      if (e.key === 'Delete' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        window.electronAPI.sshShellWrite(shellId, '\x1bd')
        return false
      }
      // Option+Left → word backward
      if (e.key === 'ArrowLeft' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        window.electronAPI.sshShellWrite(shellId, '\x1bb')
        return false
      }
      // Option+Right → word forward
      if (e.key === 'ArrowRight' && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        window.electronAPI.sshShellWrite(shellId, '\x1bf')
        return false
      }
      return true
    })

    // Wire terminal input -> SSH shell
    const inputDisposable = terminal.onData((data) => {
      window.electronAPI.sshShellWrite(shellId, data)
    })

    // Wire terminal resize -> SSH shell.
    // Debounced for the same reason as the local PTY path: collapse the
    // SIGWINCH burst Framer Motion would otherwise produce during a panel
    // animation into a single resize at the settled size. See use-terminal.ts
    // for the full rationale.
    let pendingResize: { cols: number; rows: number } | null = null
    let resizeIpcTimer: ReturnType<typeof setTimeout> | null = null
    let lastSentCols = terminal.cols
    let lastSentRows = terminal.rows
    const flushResize = () => {
      resizeIpcTimer = null
      if (!pendingResize) return
      const { cols, rows } = pendingResize
      pendingResize = null
      if (cols === lastSentCols && rows === lastSentRows) return
      lastSentCols = cols
      lastSentRows = rows
      window.electronAPI.sshShellResize(shellId, cols, rows)
    }
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      pendingResize = { cols, rows }
      if (resizeIpcTimer) clearTimeout(resizeIpcTimer)
      resizeIpcTimer = setTimeout(flushResize, 220)
    })

    const { setSessionActivity, setSessionPromptWaiting, setSessionDetectedUrl, setSessionServerStatus, setSessionUnseenActivity, updateSessionAlive } =
      useSessionStore.getState()

    // Activity tracking: debounce from active → idle after silence
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    let activeStartTimer: ReturnType<typeof setTimeout> | null = null
    let notificationTimer: ReturnType<typeof setTimeout> | null = null
    let outputBuffer = ''
    let isMarkedActive = false
    let portCheckFailures = 0

    // Wire SSH shell output -> terminal
    const cleanupData = window.electronAPI.onSshShellData(shellId, (data) => {
      terminal.write(data)

      // Only mark active after sustained output (50ms) to avoid flicker
      if (!isMarkedActive) {
        if (!activeStartTimer) {
          activeStartTimer = setTimeout(() => {
            isMarkedActive = true
            setSessionActivity(shellId, 'active')
            setSessionPromptWaiting(shellId, null)
            activeStartTimer = null
          }, 50)
        }
      } else {
        setSessionPromptWaiting(shellId, null)
      }

      // Append stripped data to rolling buffer (max 500 chars)
      const stripped = stripAnsi(data)
      outputBuffer = (outputBuffer + stripped).slice(-500)

      // Detect localhost URLs in output (skip for hidden terminals — detected on next visible chunk)
      if (isVisibleRef.current) {
        const detectedUrl = detectLocalhostUrl(outputBuffer)
        if (detectedUrl) {
          setSessionDetectedUrl(shellId, detectedUrl)
          portCheckFailures = 0
        }
      }

      // If a URL is set and we see signals the server was killed, verify immediately
      const currentUrl = useSessionStore.getState().sessions.find((s) => s.id === shellId)?.detectedUrl
      if (currentUrl && /(\^C|SIGINT|SIGTERM|EADDRINUSE)/.test(stripped)) {
        const port = safePort(currentUrl)
        if (port) {
          setTimeout(() => {
            window.electronAPI.checkPort(port).then((alive) => {
              if (!alive) {
                setSessionServerStatus(shellId, 'stopped')
                portCheckFailures = 0
              }
            })
          }, 500)
        }
      }

      // Mark unseen activity if this session is not currently selected
      const { selectedSessionIds } = useSessionStore.getState()
      if (!selectedSessionIds.includes(shellId)) {
        setSessionUnseenActivity(shellId, true)
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
        setSessionActivity(shellId, 'idle')

        // Check for prompt patterns after idle detection
        const promptType = detectPrompt(outputBuffer)
        setSessionPromptWaiting(shellId, promptType)
        if (promptType) {
          notificationTimer = setTimeout(() => {
            const session = useSessionStore
              .getState()
              .sessions.find((s) => s.id === shellId)
            const title = session?.name ?? session?.folderName ?? 'Clave'
            window.electronAPI.showNotification?.({
              title,
              body: `Claude ${promptType}`,
              sessionId: shellId
            })
          }, 3000)
        }
      }, 2000)
    })

    // Handle SSH shell exit
    const cleanupExit = window.electronAPI.onSshShellExit(shellId, () => {
      terminal.write('\r\n\x1b[90m[Remote session ended]\x1b[0m\r\n')
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = null
      if (notificationTimer) {
        clearTimeout(notificationTimer)
        notificationTimer = null
      }
      updateSessionAlive(shellId, false)
      const exitingSession = useSessionStore.getState().sessions.find((s) => s.id === shellId)
      if (exitingSession?.detectedUrl) {
        setSessionServerStatus(shellId, 'stopped')
      }

      const session = useSessionStore.getState().sessions.find((s) => s.id === shellId)
      const title = session?.name ?? session?.folderName ?? 'Clave'
      window.electronAPI.showNotification?.({
        title,
        body: 'Remote session has ended',
        sessionId: shellId
      })
    })

    // ResizeObserver for auto-fitting. The debounced fallback fires after
    // Framer Motion's 200ms panel animation settles so the final fit captures
    // the settled width, then refreshes the viewport to clear any residual
    // glyphs left mid-animation.
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

    // Initial resize sync
    window.electronAPI.sshShellResize(shellId, terminal.cols, terminal.rows)

    // Periodically verify detected localhost URL is still reachable (fallback for missed signals)
    const portCheckInterval = setInterval(() => {
      if (!document.hasFocus() || !isVisibleRef.current) return
      const session = useSessionStore.getState().sessions.find((s) => s.id === shellId)
      if (!session?.detectedUrl || session.serverStatus !== 'running') { portCheckFailures = 0; return }
      const port = safePort(session.detectedUrl)
      if (port) {
        window.electronAPI.checkPort(port).then((alive) => {
          if (alive) {
            portCheckFailures = 0
          } else {
            portCheckFailures++
            if (portCheckFailures >= 2) {
              setSessionServerStatus(shellId, 'stopped')
              portCheckFailures = 0
            }
          }
        })
      }
    }, 3000)

    return () => {
      clearInterval(portCheckInterval)
      if (resizeTimer) clearTimeout(resizeTimer)
      if (resizeIpcTimer) clearTimeout(resizeIpcTimer)
      if (activityTimer) clearTimeout(activityTimer)
      if (activeStartTimer) clearTimeout(activeStartTimer)
      if (notificationTimer) clearTimeout(notificationTimer)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      cleanupData()
      cleanupExit()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [shellId])

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme, skinRevision])

  // Track visibility and toggle cursor blink for hidden terminals.
  // Also re-fit when anything that alters the terminal grid's available width
  // changes: selection, file tree / git panel state, and the left sidebar.
  // ResizeObserver alone is unreliable during Framer Motion's animations.
  useEffect(() => {
    const initialState = useSessionStore.getState()
    isVisibleRef.current = initialState.selectedSessionIds.includes(shellId)
    if (terminalRef.current) {
      terminalRef.current.options.cursorBlink = isVisibleRef.current
    }
    let pendingFitTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleFit = () => {
      if (pendingFitTimer) clearTimeout(pendingFitTimer)
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
        const visible = state.selectedSessionIds.includes(shellId)
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
  }, [shellId])

  const focus = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  return { containerRef, fit, focus }
}
