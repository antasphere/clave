import { requestGone } from '../../../src/shared/request-refusals'
import type { Action } from './reducer'

/** What the reader is told when the host no longer holds the request: the
 *  card has left the dock, and this one sentence says why the click did
 *  nothing. The words a server session's dock uses for a record the server
 *  no longer lists. */
export const REQUEST_RETIRED = 'This request is no longer waiting.'

/** A refused answer, as the dock takes it. A refusal that says the request is
 *  gone (the store never held it or settled it already, the adapter no longer
 *  holds it) retires the card without recording an answer: nothing ran, and
 *  a click the host would refuse again is not offered again. Any other
 *  failure, a server down or an option the provider refused, is handed back
 *  as it came and the card stays for another try. Returns what to report. */
export function refusedAnswer(
  error: unknown,
  id: string,
  dispatch: (action: Action) => void
): unknown {
  if (!requestGone(error)) return error
  dispatch({ retire: id })
  return REQUEST_RETIRED
}
