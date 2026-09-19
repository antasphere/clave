import { useSkinStore } from '../lib/skin'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSessionStore } from '../store/session-store'
import { getXtermTheme } from '../lib/terminal-theme'
import { writeUserInput } from '../lib/user-input'
import '@xterm/xterm/css/xterm.css'

export type ToolbarTerminalStatus = 'running' | 'exited'

interface UseToolbarTerminalOptions {
  sessionId: string
  persistent?: boolean
}

export function useToolbarTerminal({ sessionId, persistent }: UseToolbarTerminalOptions): {
  containerRef: React.RefObject<HTMLDivElement | null>
  status: ToolbarTerminalStatus
  focus: () => void
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<ToolbarTerminalStatus>('running')
  const theme = useSessionStore((s) => s.theme)
  const skinRevision = useSkinStore((s) => s.revision)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !sessionId) return

    const terminal = new Terminal({
      theme: getXtermTheme(useSessionStore.getState().theme),
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: false,
      scrollback: 5000,
      convertEol: true
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit()
    }
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Wire terminal input -> PTY via the shared user-input helper (toolbar
    // terminals are never send targets, but every user-input writer feeds the
    // draft shadow so the rule has no exceptions).
    const inputDisposable = terminal.onData((data) => {
      writeUserInput(sessionId, data)
    })

    // Wire terminal resize -> PTY
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      window.electronAPI.resizeSession(sessionId, cols, rows)
    })

    // Wire PTY output -> terminal
    const cleanupData = window.electronAPI.onSessionData(sessionId, (data) => {
      terminal.write(data)
    })

    // Handle PTY exit
    const cleanupExit = window.electronAPI.onSessionExit(sessionId, () => {
      terminal.write('\r\n\x1b[90m[Session ended]\x1b[0m\r\n')
      setStatus('exited')
    })

    // ResizeObserver for auto-fitting
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width === 0 || height === 0) return
      requestAnimationFrame(() => {
        try {
          fitAddon.fit()
        } catch {
          // ignore fit errors during layout transitions
        }
      })
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit()
        } catch {
          // ignore
        }
      }, 100)
    })
    resizeObserver.observe(container)

    // Initial resize sync
    window.electronAPI.resizeSession(sessionId, terminal.cols, terminal.rows)

    // Focus on mount
    terminal.focus()

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      cleanupData()
      cleanupExit()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null

      // Kill PTY unless persistent
      if (!persistent) {
        window.electronAPI.killSession(sessionId)
      }
    }
  }, [sessionId, persistent])

  // Update terminal theme when app theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getXtermTheme(theme)
    }
  }, [theme, skinRevision])

  const focus = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  return { containerRef, status, focus }
}
