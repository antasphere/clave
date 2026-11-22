/**
 * Which mode an Antigravity tab runs in, one rule for every road. It fails
 * closed: a mode somebody named is never silently loosened, and a word it
 * does not know reads as Ask. Only where nothing was said does the CLI's own
 * default apply (Auto, agy 1.5.7 on).
 *
 * Measured on agy 1.5.14, 22 November 2026: `--mode` takes accept-edits, auto
 * and plan ONLY. `--mode default` prints a warning and runs on the saved
 * `agentMode`, which is Auto when none is saved: Ask reaches a terminal as
 * `--settings '{"agentMode":""}'`. Flags take one dash or two; the last wins.
 */

/** The rungs, the strictest first. */
export const ANTIGRAVITY_MODES = ['plan', 'default', 'accept-edits', 'auto'] as const
export type AntigravityMode = (typeof ANTIGRAVITY_MODES)[number]

export const isAntigravityMode = (value: unknown): value is AntigravityMode =>
  (ANTIGRAVITY_MODES as readonly unknown[]).includes(value)

/** The strictest of those given; one this does not know counts as Ask. */
export function stricterMode(
  ...modes: readonly (string | null | undefined)[]
): AntigravityMode | undefined {
  let found: AntigravityMode | undefined
  for (const said of modes) {
    if (said === undefined || said === null) continue
    const mode = isAntigravityMode(said) ? said : 'default'
    if (!found || ANTIGRAVITY_MODES.indexOf(mode) < ANTIGRAVITY_MODES.indexOf(found)) found = mode
  }
  return found
}

export interface AntigravityProfileFlags {
  /** What `--mode` names, as written; empty when it names nothing. */
  mode?: string
  /** What `--settings` carries: inline JSON or a path. */
  settings?: string
  /** Every other token, in order. */
  rest: string[]
}

export function antigravityProfileFlags(tokens: readonly string[]): AntigravityProfileFlags {
  const out: AntigravityProfileFlags = { rest: [] }
  for (let i = 0; i < tokens.length; i++) {
    const flag = /^--?(mode|settings)(?:=([\s\S]*))?$/.exec(tokens[i])
    if (!flag) {
      out.rest.push(tokens[i])
      continue
    }
    const value = flag[2] ?? tokens[++i] ?? ''
    if (flag[1] === 'mode') out.mode = value
    else out.settings = value
  }
  return out
}

/** The mode a spawn runs in; undefined when nothing was said, the CLI's own. */
export function resolveAntigravityMode(input: {
  /** What the spawn names: the person's or an agent's pick, a record's. */
  named?: string | undefined
  /** Settings → Harnesses. */
  setting?: string | undefined
  profile: AntigravityProfileFlags
  /** What the profile's `--settings` says about permissions, when it does. */
  settingsMode?: string | undefined
  /** A routine's run: nobody is at the keyboard (ADR 0004). */
  routine?: boolean
}): AntigravityMode | undefined {
  const { named, setting, profile, settingsMode, routine } = input
  let mode: AntigravityMode | undefined
  if (named !== undefined)
    mode = isAntigravityMode(named) ? named : stricterMode(setting, profile.mode, 'default')
  else if (profile.mode !== undefined)
    mode = isAntigravityMode(profile.mode) ? profile.mode : stricterMode(setting, 'default')
  else mode = stricterMode(setting)
  if (settingsMode !== undefined) mode = stricterMode(mode, settingsMode)
  return mode ?? (routine ? 'default' : undefined)
}

/** A profile's own arguments with the mode a terminal runs in: the stricter
 *  of the tab's and the profile's, in the words the CLI takes. */
export function antigravityModeArgv(tokens: readonly string[], mode?: string): string[] {
  const { mode: own, settings, rest } = antigravityProfileFlags(tokens)
  const runs = stricterMode(mode, own)
  if (!runs) return [...tokens]
  if (runs !== 'default')
    return [...rest, ...(settings !== undefined ? ['--settings', settings] : []), '--mode', runs]
  let base: Record<string, unknown> = {}
  if (settings !== undefined) {
    // A second `--settings` replaces the first, so Ask goes inside the
    // profile's own; a file cannot be merged here and is never dropped, its
    // deny rules with it.
    try {
      const parsed: unknown = JSON.parse(settings)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      base = parsed as Record<string, unknown>
    } catch {
      throw new Error(
        'This Antigravity profile passes a settings file, so Ask cannot be added to it: put "agentMode": "" in that file, or choose a profile without one.'
      )
    }
  }
  return [...rest, '--settings', JSON.stringify({ ...base, agentMode: '' })]
}
