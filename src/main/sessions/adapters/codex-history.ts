/**
 * A resumed Codex chat's past, read from its rollout. The reader is the
 * session bridge's (`@clave/session-bridge/readers/codex`, PRDCT-4301): one
 * implementation of the rollout format, the same one the bridge's writer lays
 * a converted conversation down in, so the two can never drift. The rules the
 * reader keeps are documented there: within a turn the completed items the
 * person saw win over the model's rows; older turns have only the model's
 * rows, whose injected instructions stay out; a call the rollout never
 * answered is closed at the next message; a form's outcome keeps its marker
 * (PRDCT-4157) so a reloaded tab folds it into the form's record.
 */
import { replayCodexHistory as replayRollout } from '@clave/session-bridge/readers/codex'
import type { HistoryItem } from '../../../shared/session-model'
import { toHistoryItems } from './bridge-history'

export function replayCodexHistory(lines: Iterable<string>): HistoryItem[] {
  return toHistoryItems(replayRollout(lines))
}
