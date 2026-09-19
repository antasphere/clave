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
  const sessions = useViewSessionStore((s) => s.sessions)
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
  }, [sessions])
}
