import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOTES, type ViewerCommand } from './viewer'

/**
 * The viewer's command, from what the plugin host tells the plugin process (PRDCT-4499): the
 * server's OWN copy of Slideless, run by the server's Node under its preview host, never a
 * `slideless` found on a path. Read again at every start of the viewer, so a copy installed
 * after the plugin started is the one its next start runs.
 */

/** The variables the host sets (`src/main/plugins/plugin-host.ts`), named again here: the
 *  plugin imports nothing of the app. */
export const SLIDELESS_ENV = {
  /** The Node that runs the copy. */
  node: 'CLAVE_SLIDELESS_NODE',
  /** The preview host the copy runs under. */
  host: 'CLAVE_SLIDELESS_HOST',
  /** The folder the copy is installed in. */
  cliDir: 'CLAVE_SLIDELESS_CLI_DIR',
  /** A `bin.js` to run instead (a teammate's checkout, the tests), when the host's own
   *  environment names one. */
  override: 'CLAVE_SLIDELESS_CLI'
} as const

/**
 * The installed copy's `bin.js` under `cliDir`: `current.json` names the version, and the
 * version's folder holds the file; null when either is not there. The same rule as
 * `installedVersion` in `src/main/artefacts/slideless-cli.ts`, written again here since the
 * plugin does not import the app.
 */
export function installedBin(cliDir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(cliDir, 'current.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) return null
    const bin = join(cliDir, version, 'bin.js')
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

/**
 * What the viewer runs: the Node with `[<host>, <bin.js>]` and `ELECTRON_RUN_AS_NODE`, in the
 * plugin's own environment. The script is the override when it is set and its file exists,
 * else the installed copy; the Node, the host or the script missing, there is nothing to
 * run, and the note says so.
 */
export function slidelessCommand(
  env: NodeJS.ProcessEnv = process.env
): ViewerCommand | { missing: string } {
  const named = (key: string): string | null => env[key]?.trim() || null
  const node = named(SLIDELESS_ENV.node)
  const host = named(SLIDELESS_ENV.host)
  const override = named(SLIDELESS_ENV.override)
  const cliDir = named(SLIDELESS_ENV.cliDir)
  const bin =
    override !== null && existsSync(override)
      ? override
      : cliDir !== null
        ? installedBin(cliDir)
        : null
  if (node === null || host === null || bin === null || !existsSync(node) || !existsSync(host))
    return { missing: NOTES.missing }
  const own: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') own[key] = value
  return { file: node, args: [host, bin], env: { ...own, ELECTRON_RUN_AS_NODE: '1' } }
}
