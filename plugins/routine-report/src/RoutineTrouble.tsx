import { TroubleDrawing } from './RoutineDrawing'
import { RunGlyph } from './RunGlyph'
import type { Trouble } from './trouble'

/**
 * How a routine says something went wrong (6 November 2026, Romain: "the red
 * strings are awful, always have something nice"). Never a raw error in red:
 * the chat's empty-state shape with a drawing, one plain sentence of what
 * happened and what to do, and the exact words the app or the agent gave,
 * kept but folded under « Details » in quiet monospace for whoever wants
 * them. The tone lives in the glyph, the same one the sidebar would draw.
 */
/** The full state view: drawing, glyph, words, folded details. */
export function TroubleCard({
  trouble,
  meta,
  testId
}: {
  trouble: Trouble
  meta?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div className="routine-state routine-trouble" data-tone={trouble.tone} data-testid={testId}>
      <TroubleDrawing />
      <span className="routine-trouble-title">
        <RunGlyph tone={trouble.tone} />
        <strong>{trouble.title}</strong>
      </span>
      <span>{trouble.text}</span>
      {meta && <span className="routine-meta">{meta}</span>}
      {trouble.detail && <Details text={trouble.detail} />}
    </div>
  )
}

/** The compact line above the panel's body: glyph, sentence, folded details. */
export function TroubleNote({
  trouble,
  testId
}: {
  trouble: Trouble
  testId?: string
}): React.JSX.Element {
  return (
    <div className="routine-note" data-tone={trouble.tone} data-testid={testId}>
      <RunGlyph tone={trouble.tone} />
      <div className="routine-note-text">
        <strong>{trouble.title}</strong>
        <span>{trouble.text}</span>
        {trouble.detail && <Details text={trouble.detail} />}
      </div>
    </div>
  )
}

function Details({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="routine-details">
      <summary>Details</summary>
      <pre>{text}</pre>
    </details>
  )
}
