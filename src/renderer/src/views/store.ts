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
    const refresh = async (): Promise<void> => {
      const [records, plugins] = await Promise.all([
        window.electronAPI.sessionsList(),
        window.electronAPI.pluginsList()
      ])
      if (active) useRegistry.setState({ sessions: records, plugins })
    }
    void refresh().catch(console.error)
    const stop = window.electronAPI.onPluginsChanged(() => void refresh().catch(console.error))
    return () => {
      active = false
      stop()
    }
  }, [recordsKey])
}
