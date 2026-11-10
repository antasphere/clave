/**
 * The explainer run for a session (PRDCT-4331): the helper on the session's
 * own launch and account, or, under the end-to-end harness, no model at all.
 * A spec that wants a reading hands the model's reply in
 * CLAVE_E2E_EXPLAINER_REPLY, read the way a real one is, after a beat
 * (CLAVE_E2E_EXPLAINER_DELAY_MS, 800 ms by default) so the reading state
 * shows. No Electron: the standalone server runs it too.
 */
import { runHelper } from '../helpers/runner'
import type { HelperOutcome } from '../helpers/registry'
import { permissionExplainerHelper } from '../helpers/explainer'
import type { ExplainerInput, ExplainerReading } from '../../shared/permission-explainer'
import { ptyManager } from '../pty-manager'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { testReading } from './permission-explanations'

export function explainPermission(
  sessionId: string,
  input: ExplainerInput
): Promise<HelperOutcome<ExplainerReading>> {
  if (TEST_NO_ACTIVATE) return testReading(process.env)
  return runHelper(permissionExplainerHelper, input, ptyManager.launchContextOf(sessionId), {
    owner: sessionId
  })
}
