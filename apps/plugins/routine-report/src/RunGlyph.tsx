import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon
} from '@heroicons/react/24/outline'

/**
 * A routine run's status, drawn the way a sidebar row draws its own
 * (`SessionStatus`, `lib/tab-status.ts`): one glyph from the same set, in the
 * same slot shape, so a routine and a tab say a state with the same mark.
 * Motion means working (the eight-segment spinner), colour means "go look":
 *
 *   running   → the spinner, in the working blue
 *   waiting   → a question mark in a circle, amber: the agent asks you
 *   ok        → a check in a circle, green
 *   attention → a warning triangle, amber: something is left for you
 *   failed    → a cross in a circle, red: the run could not finish
 *   invalid   → the same cross: the declaration cannot run
 *   seen      → a grey check: a finished run you have looked at
 *
 * Every glyph carries its label for a reader of the screen.
 */
export type RunGlyphTone =
  | 'running'
  | 'waiting'
  | 'ok'
  | 'attention'
  | 'failed'
  | 'invalid'
  | 'seen'

const LABELS: Record<RunGlyphTone, string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  ok: 'OK',
  attention: 'Attention',
  failed: 'Failed',
  invalid: 'Cannot run',
  seen: 'Seen'
}

export function RunGlyph({
  tone,
  size = 'sm',
  label,
  testId
}: {
  tone: RunGlyphTone
  /** sm: a list row's slot; lg: the state view's centrepiece; badge: the
   *  toolbar icon's corner, on a disc of the bar's ground. */
  size?: 'sm' | 'lg' | 'badge'
  label?: string
  testId?: string
}): React.JSX.Element {
  const Glyph =
    tone === 'waiting'
      ? QuestionMarkCircleIcon
      : tone === 'attention'
        ? ExclamationTriangleIcon
        : tone === 'failed' || tone === 'invalid'
          ? XCircleIcon
          : tone === 'running'
            ? null
            : CheckCircleIcon
  const text = label ?? LABELS[tone]
  return (
    <span
      className="sidebar-tab-status routine-glyph"
      data-tone={tone}
      data-size={size}
      data-testid={testId}
      role="img"
      aria-label={text}
      title={text}
    >
      {Glyph ? <Glyph /> : <span className="sidebar-tab-spinner" />}
    </span>
  )
}
