/* A title rewritten in place (PRDCT-4412), the way a pen goes back over a
   line: the written title is inked in left to right over the stand-in. Each
   frame has three parts: the new text already settled, a short run of new
   characters still wet behind the pen (`PageTitle` draws them fading towards
   the nib, the pen's own line under them), and what is left of the old text
   ahead of the pen, fading as the pen comes (a stand-in longer than the
   title is gone when the pen lifts). The pen runs the length of the new
   title; it eases in, writes, and eases out, as a hand does.
   No random characters: a title never passes through a word it is not. Pure,
   so a test can read every frame; `PageTitle` plays them on animation frames. */

/** How many characters are wet behind the pen at once. */
export const REVEAL_RUN = 6
/** How many frames a reveal takes by default: about 0.4 s at 60 frames a second. */
export const REVEAL_STEPS = 24
/** How long a reveal plays, inside the 300 to 500 ms the motion allows. */
export const REVEAL_MS = 420
/** How long the head must have shown the stand-in with its loader before a
 *  title is revealed in place: a title that comes sooner was filed on the
 *  host already, and is just shown. */
export const REVEAL_MIN_WAIT_MS = 400

/** One frame of a reveal: the new text settled, the new text still wet
 *  behind the pen, the old text ahead of it, and how much ink that old text
 *  keeps (1 as the pen sets down, 0 once it lifts). */
export interface RevealFrame {
  settled: string
  wet: string
  old: string
  fade: number
}

/** How much ink the old text keeps just before the pen lifts. */
const OLD_LAST_INK = 0.2

/** A frame as plain text, the way it reads. */
export function frameText(frame: RevealFrame): string {
  return frame.settled + frame.wet + frame.old
}

/** The pen's pace: slow off the mark, steady through the middle, slow onto
 *  the last character, the curve a hand writing a line draws. */
function pace(t: number): number {
  return (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, t)))) / 2
}

/**
 * Whether a title that just arrived is revealed in place: only a title
 * written now (`fresh`), after the head showed the stand-in with its loader
 * since `pendingSince` for at least REVEAL_MIN_WAIT_MS, and never for a
 * reader who asked for no motion. Pure.
 */
export function shouldReveal(
  pendingSince: number | null,
  now: number,
  fresh: boolean,
  reducedMotion: boolean
): boolean {
  return (
    fresh && !reducedMotion && pendingSince !== null && now - pendingSince >= REVEAL_MIN_WAIT_MS
  )
}

/**
 * The frames between `from` and `to`, in order, ending on `to` itself (all
 * settled). At each frame the pen has moved further right along the new
 * title, on the pace of a hand: behind it, the last REVEAL_RUN characters of
 * the new text are wet, and before those the new text stands settled; ahead
 * of it, the old text is still there, its ink fading as the pen goes. The
 * same text is no reveal: one frame.
 */
export function revealFrames(from: string, to: string, steps = REVEAL_STEPS): RevealFrame[] {
  const last: RevealFrame = { settled: to, wet: '', old: '', fade: 0 }
  if (from === to || steps <= 1) return [last]
  const span = to.length + REVEAL_RUN
  const frames: RevealFrame[] = []
  for (let frame = 1; frame < steps; frame++) {
    const t = pace(frame / steps)
    const pen = Math.round(t * span)
    // The pen not yet on the line: the stand-in as it was, no frame.
    if (pen === 0) continue
    const dry = Math.max(0, pen - REVEAL_RUN)
    const next = {
      settled: to.slice(0, dry),
      wet: to.slice(dry, pen),
      old: from.slice(pen),
      fade: Math.round((1 - t * (1 - OLD_LAST_INK)) * 100) / 100
    }
    const prev = frames.at(-1)
    if (!prev || prev.settled !== next.settled || prev.wet !== next.wet || prev.old !== next.old)
      frames.push(next)
  }
  frames.push(last)
  return frames
}

/** The frame shown `elapsed` ms into a reveal of `frames` lasting `ms`. */
export function frameAt(
  frames: readonly RevealFrame[],
  elapsed: number,
  ms = REVEAL_MS
): RevealFrame | null {
  if (!frames.length) return null
  const index = Math.min(frames.length - 1, Math.floor((elapsed / ms) * frames.length))
  return frames[Math.max(0, index)]
}
