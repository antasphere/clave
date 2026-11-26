/**
 * The routine publisher's road to the server's own copy of Slideless (PRDCT-4266): one run of
 * the copy its artefact service installs under the server's data folder (`slideless/cli`, or
 * the `CLAVE_SLIDELESS_CLI` override), by the Node the server was told, in the server's own
 * environment (`runSlideless`); the machine's « New links go to » (`slideless-settings.json`
 * in the same folder, where the accounts write it); and the origins of the machine's saved
 * profiles, from the plain listing (`slideless-accounts.ts`). Both entries build their
 * publisher on it, over the folder and the Node their artefact service gets.
 */
import { join } from 'node:path'
import { fileLinksStorage } from '../artefacts/links'
import { ArtefactRefusal } from '../artefacts/refusal'
import { createSlidelessAccounts } from '../artefacts/slideless-accounts'
import { resolveCli, type ResolvedCli } from '../artefacts/slideless-cli'
import { runSlideless, type SlidelessRunDeps } from '../artefacts/slideless-run'
import { SETTINGS_FILE, SlidelessSettings, normalOrigin } from '../artefacts/slideless-settings'
import type { PublisherOptions } from './publisher'

export interface OwnSlidelessDeps {
  /** The server's data folder, the one its artefact service installs Slideless in. */
  readonly dataDir: string
  /** The Node that runs the copy (the app's binary as Node, or the one the entry was told). */
  readonly execPath: string
  /** The server's own environment. */
  readonly env: NodeJS.ProcessEnv
  readonly spawn?: SlidelessRunDeps['spawn']
  /** Where an unreadable settings document is said. */
  readonly log?: (message: string) => void
}

export function ownSlideless(
  deps: OwnSlidelessDeps
): Pick<PublisherOptions, 'run' | 'newLinksSite' | 'sites'> {
  const cliDir = join(deps.dataDir, 'slideless', 'cli')
  /** The copy when it is ready to run, else the refusal that says why not. */
  const cli = (): ResolvedCli => {
    const resolved = resolveCli(cliDir, deps.env)
    if (!resolved.cli) throw new ArtefactRefusal(resolved.reason)
    return resolved.cli
  }
  const command: SlidelessRunDeps = {
    execPath: deps.execPath,
    env: deps.env,
    cli,
    ...(deps.spawn !== undefined && { spawn: deps.spawn })
  }
  const settings = new SlidelessSettings(
    fileLinksStorage(join(deps.dataDir, SETTINGS_FILE)),
    deps.log
  )
  const accounts = createSlidelessAccounts({
    cli,
    run: (args, options) => runSlideless(command, args, options),
    settings
  })
  return {
    run: (args, options) => runSlideless(command, args, options),
    newLinksSite: async () => settings.newLinksSite(),
    // A listing that cannot be made rejects: a deck is never taken for gone on a failed listing.
    sites: async () =>
      (await accounts.listed()).profiles
        .filter((profile) => profile.saved)
        .map((profile) => normalOrigin(profile.site.origin))
  }
}
