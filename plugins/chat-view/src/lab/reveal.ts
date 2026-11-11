/* A title rewritten in place (PRDCT-4412): the stand-in's characters give way
   to the written title's, left to right, through a short run of unsettled
   characters, the way a pen goes back over a line. Pure, so a test can read
   every frame; `PageTitle` plays them on animation frames. */

/** How many characters are unsettled at once, between the old and the new. */
export const REVEAL_RUN = 4
/** How many frames a reveal takes by default: about 0.4 s at 60 frames a second. */
export const REVEAL_STEPS = 24
/** How long a reveal plays, inside the 300 to 500 ms the motion allows. */
export const REVEAL_MS = 420

/** The marks an unsettled character shows: quiet, lowercase, never a word. */
const UNSETTLED = 'aeosnrtlcdumxzvkq'

/** The character an unsettled position shows at a frame: stable for a test,
 *  different from one frame to the next so the run reads as moving. */
function unsettled(at: number, frame: number): string {
  return UNSETTLED[(at * 7 + frame * 3) % UNSETTLED.length]
}

/**
 * The strings between `from` and `to`, in order, ending on `to` itself. At
 * each frame a cursor has moved further right: before it, minus the run,
 * the new text stands; in the run, unsettled characters; after it, the old
 * text is still there. A space stays a space in the run, so the words keep
 * their shape while they change. The same text is no reveal: one frame.
 */
export function revealFrames(from: string, to: string, steps = REVEAL_STEPS): string[] {
  if (from === to || steps <= 1) return [to]
  const length = Math.max(from.length, to.length)
  const span = length + REVEAL_RUN
  const frames: string[] = []
  for (let frame = 1; frame < steps; frame++) {
    const cursor = Math.round((frame / steps) * span)
    let text = ''
    for (let at = 0; at < length; at++) {
      if (at < cursor - REVEAL_RUN) text += to[at] ?? ''
      else if (at < cursor) {
        const settled = to[at] ?? from[at]
        text += settled === undefined ? '' : settled === ' ' ? ' ' : unsettled(at, frame)
      } else text += from[at] ?? ''
    }
    if (frames.at(-1) !== text) frames.push(text)
  }
  if (frames.at(-1) !== to) frames.push(to)
  return frames
}

/** The frame shown `elapsed` ms into a reveal of `frames` lasting `ms`. */
export function frameAt(frames: readonly string[], elapsed: number, ms = REVEAL_MS): string {
  if (!frames.length) return ''
  const index = Math.min(frames.length - 1, Math.floor((elapsed / ms) * frames.length))
  return frames[Math.max(0, index)]
}
