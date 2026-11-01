import { useEffect } from 'react'
import { create } from 'zustand'
import type { Session } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'
import { useViewSessionStore } from './session-store'
interface Registry {
  sessions: Session[]
  plugins: PluginRecord[]
  terminal: Set<string>
}
export const useRegistry = create<Registry>(() => ({
  sessions: [],
  plugins: [],
  terminal: new Set()
}))
export function useViewRegistry(): void {
  // Activity updates replace the sidebar's sessions array. They must not
  // cancel an in-flight registry read: a busy session could otherwise keep
  // every chat on the blank terminal fallback indefinitely. Read again when
  // tabs arrive or leave, a restore finishes, or a process is restarted.
  const recordsKey = useViewSessionStore((s) =>
    s.sessions
      .map((session) => `${session.id}:${session.restoring === true}:${session.restartEpoch ?? 0}`)
      .join('\n')
  )
  useEffect(() => {
    let active = true
    let reading = false
    let queued = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let retryMs = 250
    const refresh = (): void => {
      if (!active) return
      if (retry !== null) clearTimeout(retry)
      retry = null
      if (reading) {
        queued = true
        return
      }
      reading = true
      void Promise.resolve()
        .then(() =>
          Promise.all([window.electronAPI.sessionsList(), window.electronAPI.pluginsList()])
        )
        .then(([records, plugins]) => {
          if (!active) return
          retryMs = 250
          useRegistry.setState({ sessions: records, plugins })
        })
        .catch((error) => {
          if (!active) return
          console.error(error)
          // A transient failure must not strand a tab until another user
          // action. One read at a time, with capped backoff while unavailable.
          retry = setTimeout(refresh, retryMs)
          retryMs = Math.min(retryMs * 2, 8000)
        })
        .finally(() => {
          reading = false
          if (active && queued) {
            queued = false
            refresh()
          }
        })
    }
    refresh()
    const stop = window.electronAPI.onPluginsChanged(refresh)
    const stopFleet = window.electronAPI.onFleetSnapshot?.(refresh)
    const stopConnected = window.electronAPI.onServerConnected(refresh)
    return () => {
      active = false
      if (retry !== null) clearTimeout(retry)
      stop()
      stopConnected()
      stopFleet?.()
    }
  }, [recordsKey])
}
