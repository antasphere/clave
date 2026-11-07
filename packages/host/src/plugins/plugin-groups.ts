/**
 * The shell tells the plugin service which sidebar groups each window holds,
 * so a plugin reading a session learns its group. The shell's layouts are the
 * truth of the windows' groups whether the server runs in this process or
 * apart, so this runs in both modes: once at the start, then after every
 * layout change, debounced. A report that fails is dropped; the next change
 * sends the whole picture again. The layouts are imported lazily: they are
 * Electron-bound, and the IPC module that starts this is loaded by tests that
 * have no Electron app.
 */
import { pluginsFacade } from '../ipc-handlers/plugin-ipc'
import { pluginGroupsOf } from './plugin-groups-map'

export function reportPluginGroups(): () => void {
  let stopped = false
  let stop = (): void => {}
  void import('../sidebar-layouts')
    .then(({ sidebarLayouts }) => {
      if (stopped) return
      const layouts = sidebarLayouts()
      let timer: NodeJS.Timeout | undefined
      const report = (): void => {
        const snapshots = layouts.list()
        void pluginsFacade()
          .then((plugins) =>
            Promise.all(
              snapshots.map((snapshot) =>
                plugins.groups(snapshot.windowKey, pluginGroupsOf(snapshot)).catch(() => undefined)
              )
            )
          )
          .catch(() => undefined)
      }
      const schedule = (): void => {
        clearTimeout(timer)
        timer = setTimeout(report, 200)
      }
      const off = layouts.onChange(schedule)
      schedule()
      stop = () => {
        clearTimeout(timer)
        off()
      }
    })
    .catch((error) => console.error('[plugins] sidebar groups are not reported:', error))
  return () => {
    stopped = true
    stop()
  }
}
