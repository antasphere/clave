import { claudeContextWindow } from '../../../shared/claude-models'

/** The characters a handoff may take: half the target model's window when
 *  its id names one (Clave's table), else a 200k window, at four characters
 *  a token. The full tape goes to the file regardless. One rule for the
 *  popover's road and the limit card's (PRDCT-4300). */
export function handoffBudgetChars(modelId: string): number {
  const window = claudeContextWindow(modelId) ?? 200_000
  return Math.round(window * 0.5 * 4)
}
