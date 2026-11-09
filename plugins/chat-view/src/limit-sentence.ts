import type { UsageWindow } from '../../../src/preload/index.d'
import { capName, formatResetIn } from '../../../src/renderer/src/store/usage-store'

/** The ended notice's first sentence, pure (PRDCT-4254): "Work is out on
 *  Fable, back in 2d 5h." when the cap that stopped the conversation is
 *  known from the poll's read, "Work is out, as its agent reported." when
 *  only the CLI's report says so (it reaches the window as a bare flag). */
export function limitSentence(
  account: string,
  stopping: UsageWindow | null,
  now: number = Date.now()
): string {
  if (!stopping) return `${account} is out, as its agent reported.`
  const back = formatResetIn(stopping.resetsAt, now)
  return `${account} is out on ${capName(stopping)}${back ? `, back ${back}` : ''}.`
}
