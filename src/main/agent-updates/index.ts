/**
 * The agent updater as the app runs it: the manager wired to Electron (the
 * login environment, the preference, the windows, native notifications).
 * `agent-update-manager.ts` holds the behaviour and is tested without any of it.
 */
import { app, Notification } from 'electron'
import { broadcastToAllWindows } from '../window-routing'
import { preferencesManager } from '../preferences-manager'
import { loginShellEnvAsync } from '../sessions/adapters/pty-backend'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { AgentUpdateManager, fetchDistTag, realDeps } from './agent-update-manager'

/**
 * The timers run in the shipped app only. A dev build (`npm run dev`) shares
 * the machine's CLIs with the installed Clave, and two apps upgrading the
 * same prefix on their own clocks is a race nobody asked for; the buttons
 * still work there. `CLAVE_AGENT_UPDATES_AUTO=1` runs them anyway, to try the
 * schedule from a dev build. Never under `--test-no-activate`.
 */
const scheduled =
  !TEST_NO_ACTIVATE && (app.isPackaged || process.env.CLAVE_AGENT_UPDATES_AUTO === '1')

/**
 * E2E seams, honoured under `--test-no-activate` only, like `--test-version`:
 * the PATH the updater searches and the registry it asks, so a spec drives
 * fixture CLIs against a local registry and never the machine's own agents.
 */
const TEST_AGENT_PATH = TEST_NO_ACTIVATE ? process.env.CLAVE_TEST_AGENT_PATH : undefined
const TEST_REGISTRY = TEST_NO_ACTIVATE ? process.env.CLAVE_TEST_NPM_REGISTRY : undefined

export const agentUpdateManager = new AgentUpdateManager({
  ...realDeps,
  loginEnv: TEST_AGENT_PATH
    ? async () => ({ ...(await loginShellEnvAsync()), PATH: TEST_AGENT_PATH })
    : loginShellEnvAsync,
  fetchDistTag: TEST_REGISTRY ? (pkg, tag) => fetchDistTag(pkg, tag, TEST_REGISTRY) : fetchDistTag,
  getAutoUpdate: () => preferencesManager.get('agentAutoUpdate') !== false,
  setAutoUpdate: (value) => preferencesManager.set('agentAutoUpdate', value),
  scheduled,
  broadcast: (state) => broadcastToAllWindows('agent-updates:state', state),
  notify: (title, body) => {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: true }).show()
  }
})
