/**
 * The account a restarted session runs on. A restart names the account it
 * moves to (the account switch) or names none (the restart onto a newly
 * upgraded agent, PRDCT-2927); a key it leaves out, or passes as undefined,
 * keeps the account the process already had. Spreading the raw overrides put
 * `claudeProfileId: undefined` over the stored one and sent the tab to the
 * machine login without a word.
 */
export function accountOverrides<T extends Record<string, string | undefined>>(
  overrides: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}
