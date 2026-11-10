/**
 * The explainer run for a session (PRDCT-4331): the helper on the session's
 * own launch and account, or, under the end-to-end harness, no model at all.
 * A spec that wants a reading hands the model's reply in
 * CLAVE_E2E_EXPLAINER_REPLY, read the way a real one is, after a beat
 * (CLAVE_E2E_EXPLAINER_DELAY_MS, 800 ms by default) so the reading state
 * shows. No Electron: the standalone server runs it too.
 */
import { cancelOwned, runHelper } from '../helpers/runner'
import type { HelperOutcome } from '../helpers/registry'
import { permissionExplainerHelper } from '../helpers/explainer'
import type { ExplainerInput, ExplainerReading } from '../../shared/permission-explainer'
import { ptyManager } from '../pty-manager'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { testReading } from './permission-explanations'

export function explainPermission(
  sessionId: string,
  input: ExplainerInput,
  owner: string
): Promise<HelperOutcome<ExplainerReading>> {
  if (TEST_NO_ACTIVATE) return testReading(process.env)
  return runHelper(permissionExplainerHelper, input, ptyManager.launchContextOf(sessionId), {
    owner
  })
}

/** End a reading by its owner (its request was answered or withdrawn). */
export function cancelExplanation(owner: string): void {
  cancelOwned(owner)
}

/** What the explaining host is given where the session runs: the run, its
 *  cancel, and every request leaving the pending-requests service. */
export function explainerPorts(requests: {
  onSettled: (
    listener: (request: { sessionId: string; providerRequestId?: string }) => void
  ) => () => void
}): {
  explain: typeof explainPermission
  cancel: typeof cancelExplanation
  onSettled: (listener: (sessionId: string, providerRequestId: string) => void) => () => void
} {
  return {
    explain: explainPermission,
    cancel: cancelExplanation,
    onSettled: (listener) =>
      requests.onSettled((request) => {
        if (request.providerRequestId) listener(request.sessionId, request.providerRequestId)
      })
  }
}
