/**
 * The command a Slideless viewer runs (PRDCT-4499): a server's OWN copy of the command line,
 * the one its artefact service installs under its data folder (`slideless/cli`, or the
 * `CLAVE_SLIDELESS_CLI` override), run by the Node it was told under the preview host, so the
 * viewer ends when the process that started it ends, whatever ended it. Never a `slideless`
 * found on a path, never the login shell's environment. One builder for every caller in the
 * app (the routines' viewer, in-process and standalone); the Analytics plugin builds the same
 * command from what its host tells it (`plugins/analytics/src/slideless-command.ts`).
 */
import { join } from 'node:path'
import { NOTES, type ViewerCommand } from '../../../plugins/analytics/src/viewer'
import { writePreviewHost } from './preview-host'
import { resolveCli } from './slideless-cli'

export interface ViewerCommandDeps {
  /** The server's data folder: its copy under `slideless/cli`, its preview host under `slideless/`. */
  readonly dataDir: string
  /** The Node that runs the copy (the app's binary as Node, or the one the entry was told). */
  readonly execPath: string
  /** The server's own environment, read for the override and handed to the child. */
  readonly env: NodeJS.ProcessEnv
}

/** The viewer's command, asked at each of its starts: `{ missing }` while the server has no
 *  copy to run, the sentence the viewer's note is; else the preview host written, the Node
 *  with `[<host>, <bin.js>]`, in the server's environment and `ELECTRON_RUN_AS_NODE`. */
export async function viewerCommand(
  deps: ViewerCommandDeps
): Promise<ViewerCommand | { missing: string }> {
  const resolved = resolveCli(join(deps.dataDir, 'slideless', 'cli'), deps.env)
  if (!resolved.cli) return { missing: NOTES.missing }
  const host = writePreviewHost(deps.dataDir)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(deps.env))
    if (typeof value === 'string') env[key] = value
  return {
    file: deps.execPath,
    args: [host, resolved.cli.cliPath],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
  }
}
