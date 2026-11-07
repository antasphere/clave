import type { Terminal } from '@xterm/xterm'
import { getRegisteredTerminal } from './terminal-registry'

/**
 * The message trail's click-to-scroll, xterm half. tmux-backed tabs never get
 * here (tmux owns their scrollback and main drives it); for plain sessions
 * the conversation lives in xterm's own buffer, so we scan it for the
 * message's text and scroll the viewport there.
 *
 * The buffer holds the text as the terminal WRAPPED it, so matching is done
 * over logical lines (wrapped rows re-joined) with whitespace collapsed on
 * both sides — the one normalization that survives any wrap point. Repeated
 * identical prompts ("continue") are told apart by `fromBottom`: the k-th
 * occurrence counting from the newest, the same contract the tmux path uses.
 */

/** The searchable head of a message: its first non-empty line, whitespace
 *  collapsed, leading dashes dropped (the tmux path cannot pass them), capped.
 *  Null when the message has no searchable text. */
export function messageNeedle(userText: string): string | null {
  const first = userText.split('\n').find((l) => l.trim() !== '')
  if (!first) return null
  const collapsed = first
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-\s]+/, '')
    .slice(0, 80)
    .trim()
  return collapsed.length >= 3 ? collapsed : null
}

/** Scroll a plain session's xterm to the needle's `fromBottom`-th occurrence
 *  (1 = newest). False when the terminal is gone or the text is not in the
 *  scrollback any more. */
export function scrollXtermToText(sessionId: string, needle: string, fromBottom: number): boolean {
  const term = getRegisteredTerminal(sessionId)
  if (!term) return false
  const buf = term.buffer.active
  const q = needle.replace(/\s+/g, ' ').trim().toLowerCase()
  if (q.length < 3) return false

  const matches: number[] = []
  let startRow = 0
  let text = ''
  const flush = (): void => {
    if (text !== '' && text.replace(/\s+/g, ' ').toLowerCase().includes(q)) {
      matches.push(startRow)
    }
  }
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    // Wrapped rows are one logical line; keep the padding and collapse it at
    // match time, so a space that fell on the wrap boundary still separates
    // the words it separated on screen.
    if (i > 0 && line.isWrapped) {
      text += line.translateToString(false)
    } else {
      flush()
      startRow = i
      text = line.translateToString(false)
    }
  }
  flush()

  if (matches.length === 0) return false
  const k = Math.max(1, Math.min(matches.length, Math.floor(fromBottom)))
  const row = matches[matches.length - k]
  animateScrollToLine(term, Math.max(0, row - 1))
  return true
}

/** Ease the viewport to the line instead of jumping: the reader keeps their
 *  bearings when the jump is thousands of rows. Duration scales gently with
 *  distance, capped — a long hop should feel long, not take long. A user
 *  scroll mid-flight is simply overridden for these few frames. */
function animateScrollToLine(term: Terminal, targetLine: number): void {
  const start = term.buffer.active.viewportY
  const delta = targetLine - start
  if (delta === 0) return
  const duration = Math.min(400, 150 + Math.abs(delta) * 0.2)
  const t0 = performance.now()
  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
  const step = (now: number): void => {
    const p = Math.min(1, (now - t0) / duration)
    term.scrollToLine(Math.round(start + delta * easeOutCubic(p)))
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
