import type { RunGlyphTone } from './RunGlyph'

/**
 * How a routine says something went wrong, in words a person reads (6
 * November 2026, Romain: "the red strings are awful, always have something
 * nice"): a title, one plain sentence of what happened and what to do, the
 * raw message kept for « Details », and the glyph's tone. `RoutineTrouble.tsx`
 * draws it.
 */
export interface Trouble {
  title: string
  text: string
  /** The raw message, folded; omitted when it would only repeat the text. */
  detail?: string
  tone: RunGlyphTone
}

/** The panel-level message of the routines store, in words a person reads.
 *  null means "not trouble": the window simply has not reached its server
 *  yet, which the caller shows as a connecting state. */
export function storeTrouble(error: string): Trouble | null {
  if (/has not reached it yet/i.test(error)) return null
  if (/discussion session is not listed/i.test(error))
    return {
      title: 'The conversation is not here yet',
      text: 'It opened in the background. Open it again in a moment, or as a tab from More.',
      detail: error,
      tone: 'attention'
    }
  return {
    title: 'Clave could not reach the routines',
    text: 'It tries again on its own the next time anything changes. Run now also retries.',
    detail: error,
    tone: 'attention'
  }
}

export function invalidTrouble(reason: string): Trouble {
  return {
    title: 'This routine cannot run',
    text: 'Its declaration in the .clave file needs a fix. Nothing runs until it is valid.',
    detail: reason,
    tone: 'invalid'
  }
}

/** A run cut short from outside (the app quitting or restarting, a stop, the
 *  server going down), which is not the agent failing. */
const CUT_SHORT = /^interrupted before its report|the server stopped during the run/i

export function failedRunTrouble(
  reason: string | null | undefined,
  headline?: string | null
): Trouble {
  if (reason && CUT_SHORT.test(reason))
    return {
      title: 'The run was interrupted',
      text: 'Clave quit or restarted while it ran (an update does that). Run now runs it again.',
      detail: reason,
      tone: 'attention'
    }
  return {
    title: 'The run did not finish',
    text:
      headline ??
      'The agent stopped before writing its report. Run now tries again; Discussion shows where it stopped.',
    detail: reason ?? undefined,
    tone: 'failed'
  }
}
