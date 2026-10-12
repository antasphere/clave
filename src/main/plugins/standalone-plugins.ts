/**
 * The plugin service of the server running on its own (PRDCT-3433): the same
 * store, host and leases as the shell's (`plugin-service.ts`), over a runner
 * forked under Node IPC (`fork-runner.ts`) instead of Electron's
 * utilityProcess, and with no notification of its own: a plugin's notice goes
 * out as `plugins.notified` to the clients, and the shell attached to this
 * server shows it. Nothing here imports Electron; the entry runs under Bun
 * from the sources, or under the app's own binary as Node from the bundle.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { forkRunner } from './fork-runner'
import { createPluginService, refusingPluginService, type PluginService } from './plugin-service'

export interface StandalonePluginsOptions {
  /** The server's data directory; under the test flag the plugins live there
   *  (`clave-plugins/`), as the app keeps its own under its user data. */
  readonly dataDir: string
  /** The folder of the plugins the app ships (`plugins/` of a checkout). */
  readonly bundled: string
  /** The host's version, the one a manifest's `engines.clave` is judged against. */
  readonly version: string
}

/** The runner beside this module: the built bundle when the server runs
 *  from `out/main`, the source when Bun runs the checkout. */
export function standaloneRunnerPath(dir = __dirname): string {
  const built = join(dir, 'plugin-runner.js')
  return existsSync(built) ? built : join(dir, 'plugin-runner.ts')
}

export function standalonePlugins(options: StandalonePluginsOptions): PluginService {
  const root = TEST_NO_ACTIVATE ? join(options.dataDir, 'clave-plugins') : join(homedir(), '.clave')
  try {
    return createPluginService({
      root,
      bundled: options.bundled,
      version: options.version,
      spawner: forkRunner({ runner: standaloneRunnerPath() })
    })
  } catch (error) {
    // The shell's own degradation (`shell-plugins.ts`): a registry that cannot
    // be read refuses every plugin call with the sentence, and the server
    // keeps its sessions. Without this the entry died at boot on one bad row
    // of installed.json, and an app attached to it had no sessions at all.
    const message = `Plugin registry could not be read: ${String(error)}`
    console.error(`clave-server: ${message}`)
    return refusingPluginService(message)
  }
}
