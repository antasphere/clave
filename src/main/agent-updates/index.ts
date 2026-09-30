/**
 * The agent updater as the app runs it: the manager wired to Electron (the
 * login environment, the preference, the windows, native notifications).
 * `agent-update-manager.ts` holds the behaviour and `schedule.ts` the rules of
 * when it runs; both are tested without any of this.
 */
import { app, Notification } from 'electron'
import { broadcastToAllWindows } from '../window-routing'
import { preferencesManager } from '../preferences-manager'
import { loginShellEnvAsync } from '../sessions/adapters/pty-backend'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { AgentUpdateManager, fetchDistTag, realDeps } from './agent-update-manager'
import { agentUpdateSchedule } from './schedule'

const schedule = agentUpdateSchedule({
  testMode: TEST_NO_ACTIVATE,
  packaged: app.isPackaged,
  platform: process.platform,
  env: process.env
})
const { agentPath, registry } = schedule

export const agentUpdateManager = new AgentUpdateManager({
  ...realDeps,
  loginEnv: agentPath
    ? async () => ({ ...(await loginShellEnvAsync()), PATH: agentPath })
    : loginShellEnvAsync,
  fetchDistTag: registry ? (pkg, tag) => fetchDistTag(pkg, tag, registry) : fetchDistTag,
  getAutoUpdate: () => preferencesManager.get('agentAutoUpdate') !== false,
  setAutoUpdate: (value) => preferencesManager.set('agentAutoUpdate', value),
  scheduled: schedule.scheduled,
  supported: schedule.supported,
  broadcast: (state) => broadcastToAllWindows('agent-updates:state', state),
  notify: (title, body) => {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: true }).show()
  }
})
