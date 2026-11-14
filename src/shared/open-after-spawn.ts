/**
 * An open whose tab exists never answers an error (PRDCT-4507). Once the
 * spawn has answered, every step that follows it (the records read again,
 * the name, the place in the sidebar, the first size) is best effort: a
 * failure is one plain sentence in the answer's `warnings`, beside the tab's
 * id, never a thrown call. A thrown call after the spawn left the caller with
 * no id while the tab ran, and the model retried: ten stray tabs from one
 * prompt. Every road speaks these sentences: the Mac's window, a server's
 * served open and a Clave server's own.
 */

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What could not be done after the tab started, said in its own words. */
export const AFTER_SPAWN = {
  records: 'its record was not read again',
  name: 'was not renamed',
  place: 'was not placed in the sidebar',
  group: 'was not placed in its group',
  size: 'its terminal could not be sized to start'
} as const

export type AfterSpawnStep = keyof typeof AFTER_SPAWN

/** The sentence for a step that failed after the tab started. */
export const afterSpawnWarning = (step: AfterSpawnStep, err: unknown): string =>
  `The tab started but ${AFTER_SPAWN[step]}: ${messageOf(err)}`

/** Run one step after the spawn: true when it ran, false (and its sentence
 *  pushed) when it failed. */
export async function afterSpawn(
  warnings: string[],
  step: AfterSpawnStep,
  run: () => unknown
): Promise<boolean> {
  try {
    await run()
    return true
  } catch (err) {
    warnings.push(afterSpawnWarning(step, err))
    return false
  }
}

/** The answer with its sentences, when there are any. */
export function withWarnings<T extends object>(
  answer: T,
  warnings: readonly string[]
): T & { warnings?: string[] } {
  return warnings.length > 0 ? { ...answer, warnings: [...warnings] } : answer
}
