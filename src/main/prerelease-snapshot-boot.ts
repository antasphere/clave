// MUST be imported right after './user-data-override' in index.ts, BEFORE any
// manager: several of them read and migrate their files at module-import
// time, and the snapshot has to see the directory as the stable build left it.
import { app } from 'electron'
import { TEST_VERSION } from './test-mode'
import { runPrereleaseSnapshot, type SnapshotResult } from './prerelease-snapshot'

export interface PrereleaseSnapshotOutcome {
  result: SnapshotResult | null
  /** Why the snapshot could not be taken, when it could not. */
  failure: string | null
}

let outcome: PrereleaseSnapshotOutcome = { result: null, failure: null }

try {
  const result = runPrereleaseSnapshot(app.getPath('userData'), TEST_VERSION ?? app.getVersion())
  outcome = { result, failure: null }
  if (result) {
    console.log(
      `[updater] Pre-release first run on data last written by ${result.fromVersion}: ` +
        `${result.copied.length} entries copied to ${result.dir}`
    )
  }
} catch (err) {
  // The app must still start; the updater logs it once its logger is up.
  outcome = { result: null, failure: err instanceof Error ? err.message : String(err) }
  console.error('[updater] Pre-release data snapshot failed:', outcome.failure)
}

/** What happened at boot, for the updater's log and the Software Update pane. */
export function prereleaseSnapshotOutcome(): PrereleaseSnapshotOutcome {
  return outcome
}
