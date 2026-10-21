/**
 * The core of "Debug Clave…" over explicit dependencies (issue #227): the
 * snapshot, and for a prepare, the bundle and what the renderer needs. No
 * Electron here (`index.ts` wires it), so it is tested on fakes and a
 * temporary directory.
 */
import type { TriagePrepareResult, TriageSnapshot } from '../../shared/triage'
import { collectSnapshot, type TriageLimitsInput, type TriageSources } from './collect'
import {
  agentLaunchOf,
  externalCommandsFor,
  launchPrompt,
  problemCount,
  renderContext,
  seedPrompt
} from './context'
import { writeBundle } from './bundle'
import { createRedactor, errorText } from './redact'

export interface TriageDeps {
  sources: TriageSources
  userData: string
  home: string
  limits?: TriageLimitsInput
}

export function snapshotWith(
  deps: Pick<TriageDeps, 'sources' | 'limits'>
): Promise<TriageSnapshot> {
  return collectSnapshot(deps.sources, deps.limits)
}

/** Prepare over explicit dependencies: the testable core of `triagePrepare`. */
export async function prepareWith(deps: TriageDeps): Promise<TriagePrepareResult> {
  const snapshot = await snapshotWith(deps)
  const redact = createRedactor({ home: deps.home })
  const warnings = [...snapshot.warnings]
  let bundle: TriagePrepareResult['bundle'] = null
  let contextMarkdown: string
  try {
    const written = writeBundle(deps.userData, new Date(snapshot.generatedAt), {
      snapshot: `${JSON.stringify(snapshot, null, 2)}\n`,
      context: (snapshotPath) => renderContext(snapshot, redact.path(snapshotPath)),
      prompt: seedPrompt
    })
    bundle = written.bundle
    contextMarkdown = written.context
  } catch (error) {
    warnings.push(`The triage bundle could not be written: ${errorText(redact, error)}`)
    contextMarkdown = renderContext(snapshot, null)
  }
  const prompt = bundle ? launchPrompt(bundle.promptPath) : null
  const live = snapshot.server.health.live
  return {
    generatedAt: snapshot.generatedAt,
    origin: snapshot.origin,
    snapshot,
    contextMarkdown,
    bundle,
    launchPrompt: prompt,
    externalCommands: bundle && prompt ? externalCommandsFor(bundle.dir, prompt) : null,
    agentLaunch: agentLaunchOf(snapshot),
    summary: {
      mode: snapshot.server.mode,
      serverOk:
        snapshot.server.discoveryOk !== false &&
        snapshot.server.serverAlive !== false &&
        live !== null &&
        live >= 200 &&
        live < 300,
      windows: snapshot.windows.length,
      sessions: snapshot.sessions.status === 'ok' ? snapshot.sessions.value.length : null,
      problems: problemCount(snapshot)
    },
    warnings
  }
}
