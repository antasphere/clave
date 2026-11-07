/**
 * Draft shadow — a per-session, best-effort mirror of the text the USER has
 * typed into an agent CLI's input box since their last submit.
 *
 * Why it exists (PRDCT-1569): clave_send_to_session delivers a paste + CR into
 * the target's PTY. Both land in the target CLI's own input buffer — the same
 * buffer holding the user's half-typed draft — so without intervention the
 * submitted turn is `<user draft><injected message>`: the draft leaks into the
 * sibling's turn AND vanishes from the input. The dispatcher uses this shadow
 * to stash the draft, clear the input line, deliver the message alone, and
 * restore the draft unsubmitted.
 *
 * This module is deliberately PURE: no Electron, no DOM, no imports — so it
 * can be probed standalone with plain node. Callers feed it the exact byte
 * strings they write to the PTY on the user-input path.
 *
 * Tracking model. The shadow replays the user's keystrokes against a
 * `text` + `cursor` model of the CLI's input buffer, and carries a
 * `confident` flag:
 *
 * - Edits with near-universal TUI semantics keep confidence: printable
 *   inserts, bracketed/plain paste, backspace (grapheme-wise), forward
 *   delete, plain left/right arrows, line home/end, Shift+Enter newline.
 * - Anything whose effect on the real buffer we cannot know for sure applies
 *   a best guess AND drops confidence: word ops (boundary rules differ per
 *   CLI), up/down (history recall may REPLACE the input), Tab (completion
 *   inserts text we never see), lone ESC, Ctrl+C, unknown control bytes and
 *   escape sequences, and any input typed while the CLI is showing a
 *   permission prompt (fed via noteOpaqueInput — those keys drive a dialog,
 *   not the input line).
 * - Enter resyncs: it clears the shadow and restores confidence — EXCEPT when
 *   the token at the cursor starts with '@' (the CLI's file-completion menu is
 *   open, so Enter inserts the completion instead of submitting) or the char
 *   before the cursor is '\' (line continuation).
 *
 * Degraded-case stance (decided for PRDCT-1569): when confidence is lost we
 * still deliver — never hold the message hostage to screen-scraping the TUI —
 * and we clear with a generous overshoot instead of an exact count. The clear
 * sequence uses two keys only, backspace and forward-delete, measured on the
 * real CLI to be no-ops at the input-buffer boundary and inside the /model
 * and /mcp dialogs. That is exactly what was measured, not a property of
 * every dialog: with /config open in filter mode (empty filter after "Esc to
 * clear"), forward-deletes change nothing but the FIRST backspace flips the
 * dialog from filter mode to select mode, and the CR the dispatcher sends
 * next would act on that. This residual is an accepted, documented limit of
 * this fix; the structural answer (deferring delivery while a dialog is
 * open) is a follow-up filed by coordination. Right-arrow is deliberately
 * never used — inert in the input box, it adjusts the effort control in
 * /model, and a degraded shadow is exactly the state in which such a dialog
 * may be open. Undershoot would leave residue that gets co-submitted. The
 * degradation is reported only in the send tool's result (draftHandling:
 * best-effort); the app UI does not surface it.
 * Residual honesty: an untracked input larger than the cushion (e.g. a very
 * long history recall) can still leave residue; that is the documented limit
 * of a keystroke shadow with no read-back of the TUI screen.
 */

export interface DraftStash {
  /** The tracked draft text (may be '' when the input is believed empty). */
  text: string
  /** False once any keystroke with uncertain semantics was seen since the last resync. */
  confident: boolean
  /** Raw key sequence that clears the target's input line; '' when nothing to clear. */
  clear: string
}

/** Overshoot applied to the clear sequence when tracking confidence is lost.
 *  Covers completion-inserted paths and typical history recalls; excess
 *  presses are no-ops at the input boundary and in the /model and /mcp
 *  dialogs (measured), not in every dialog — see beginInjection. */
const UNCONFIDENT_CLEAR_CUSHION = 1024

const segmenter = new Intl.Segmenter()

function graphemeBefore(text: string, index: number): string {
  let last = ''
  for (const seg of segmenter.segment(text.slice(0, index))) last = seg.segment
  return last
}

function graphemeAfter(text: string, index: number): string {
  for (const seg of segmenter.segment(text.slice(index))) return seg.segment
  return ''
}

function codePointCount(s: string): number {
  let n = 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++
  return n
}

function lineStart(text: string, cursor: number): number {
  const nl = text.lastIndexOf('\n', cursor - 1)
  return nl === -1 ? 0 : nl + 1
}

function lineEnd(text: string, cursor: number): number {
  const nl = text.indexOf('\n', cursor)
  return nl === -1 ? text.length : nl
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n'

function wordLeft(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && isSpace(text[i - 1])) i--
  while (i > 0 && !isSpace(text[i - 1])) i--
  return i
}

function wordRight(text: string, cursor: number): number {
  let i = cursor
  while (i < text.length && isSpace(text[i])) i++
  while (i < text.length && !isSpace(text[i])) i++
  return i
}

/** Normalize pasted content the way TUI inputs ingest it: newlines become
 *  '\n', all other control bytes are dropped. */
function normalizePasted(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

export class DraftShadow {
  private text = ''
  private cursor = 0
  private confident = true
  private injectionActive = false
  private dirtiedDuringInjection = false

  /** Best guess + confidence drop, for input whose real effect is unknowable. */
  private degrade(): void {
    this.confident = false
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
  }

  private backspace(): void {
    const g = graphemeBefore(this.text, this.cursor)
    if (!g) return
    this.text = this.text.slice(0, this.cursor - g.length) + this.text.slice(this.cursor)
    this.cursor -= g.length
  }

  private deleteForward(): void {
    const g = graphemeAfter(this.text, this.cursor)
    if (!g) return
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + g.length)
  }

  private deleteRange(from: number, to: number): void {
    this.text = this.text.slice(0, from) + this.text.slice(to)
    this.cursor = from
  }

  private moveLeft(): void {
    this.cursor -= graphemeBefore(this.text, this.cursor).length
  }

  private moveRight(): void {
    this.cursor += graphemeAfter(this.text, this.cursor).length
  }

  /** Enter: submit in the overwhelmingly common case. Two exceptions where the
   *  CLI does something else with the keypress: '\' before the cursor is line
   *  continuation, and an '@'-prefixed token at the cursor means the file
   *  completion menu is open (Enter inserts the completion — length unknown). */
  private enter(): void {
    if (this.text[this.cursor - 1] === '\\') {
      this.text = this.text.slice(0, this.cursor - 1) + '\n' + this.text.slice(this.cursor)
      return
    }
    const tokenStart =
      Math.max(
        this.text.lastIndexOf(' ', this.cursor - 1),
        this.text.lastIndexOf('\n', this.cursor - 1),
        this.text.lastIndexOf('\t', this.cursor - 1)
      ) + 1
    if (this.text[tokenStart] === '@' && tokenStart < this.cursor) {
      this.degrade()
      return
    }
    this.text = ''
    this.cursor = 0
    this.confident = true
  }

  /** CSI sequence body (between '\x1b[' and including the final byte). */
  private handleCsi(body: string): void {
    switch (body) {
      case 'C':
      case '1C':
        this.moveRight()
        return
      case 'D':
      case '1D':
        this.moveLeft()
        return
      case 'H':
      case '1~':
      case '7~':
        this.cursor = lineStart(this.text, this.cursor)
        return
      case 'F':
      case '4~':
      case '8~':
        this.cursor = lineEnd(this.text, this.cursor)
        return
      case '3~':
        this.deleteForward()
        return
      case 'Z': // Shift+Tab: mode toggle in the CLIs, no input-text effect
      case 'I': // focus in
      case 'O': // focus out
      case '5~': // page up
      case '6~': // page down
        return
      case 'A':
      case 'B':
        // Up/down: history recall can REPLACE the input with unknown text, and
        // in multi-line drafts the visual line moves depend on wrapping.
        this.degrade()
        return
      default:
        // SGR mouse reporting ('<...M/m') is a display-side no-op; anything
        // else is unknown. (X10 mouse '\x1b[M…' is skipped in feed() — its
        // three payload bytes would otherwise read as typed text.)
        if (body.startsWith('<')) return
        // Terminal protocol REPLIES that xterm emits on the data channel in
        // response to CLI queries — device attributes ('?1;2c' / '>…c'),
        // cursor-position and status reports ('…R' / '…n'), mode reports
        // ('…$y'). Protocol traffic, not keystrokes: no input-text effect.
        // (Observed live: claude queries DA on boot and xterm auto-replies
        // \x1b[?1;2c before the user ever types.)
        if (body.startsWith('?') || body.startsWith('>') || body.startsWith('=')) return
        if (/^[0-9;]*[Rn]$/.test(body) || /^[0-9;]*\$y$/.test(body)) return
        this.degrade()
    }
  }

  /**
   * Feed a chunk written to the PTY on the USER input path (xterm onData,
   * custom key bindings, drag-drop insertion). Never feed the dispatcher's
   * own injected writes — those are accounted for via begin/endInjection.
   */
  feed(data: string): void {
    if (this.injectionActive) {
      // A keystroke racing a stash→deliver→restore sequence has an unknowable
      // fate (joins the injected turn or lands after the restore).
      this.dirtiedDuringInjection = true
      return
    }
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch === '\x1b') {
        // Bracketed paste from xterm (user clipboard paste while the CLI has
        // paste mode on): insert the envelope's content wholesale.
        if (data.startsWith('\x1b[200~', i)) {
          const end = data.indexOf('\x1b[201~', i + 6)
          if (end === -1) {
            this.insert(normalizePasted(data.slice(i + 6)))
            this.degrade() // unterminated envelope — resync on next submit
            return
          }
          this.insert(normalizePasted(data.slice(i + 6, end)))
          i = end + 6
          continue
        }
        if (data.startsWith('\x1b[M', i)) {
          // X10 mouse report: 'M' + 3 payload bytes, no input-text effect.
          i += Math.min(6, data.length - i)
          continue
        }
        {
          // OSC / DCS / APC / PM / SOS string sequences: terminal replies to
          // CLI queries (e.g. an OSC 11 background-color report), terminated
          // by BEL or ST. Protocol traffic, not keystrokes — skipping them
          // whole also keeps their payload from being read as typed text.
          const kind = data[i + 1]
          if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
            const bel = kind === ']' ? data.indexOf('\x07', i + 2) : -1
            const st = data.indexOf('\x1b\\', i + 2)
            const end = bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st !== -1 ? st + 2 : -1
            if (end === -1) {
              this.degrade() // truncated string sequence
              return
            }
            i = end
            continue
          }
        }
        if (data.startsWith('\x1b[', i)) {
          // CSI: params/intermediates then a final byte in 0x40–0x7e.
          let j = i + 2
          while (j < data.length && !(data[j] >= '@' && data[j] <= '~')) j++
          if (j >= data.length) {
            this.degrade() // truncated sequence
            return
          }
          this.handleCsi(data.slice(i + 2, j + 1))
          i = j + 1
          continue
        }
        if (data.startsWith('\x1bO', i) && i + 2 < data.length) {
          // SS3 form (application cursor keys): map to the CSI equivalents.
          this.handleCsi(data[i + 2])
          i += 3
          continue
        }
        const next = data[i + 1]
        if (next === '\x7f') {
          // Option+Backspace: word delete backward. Word-boundary rules differ
          // per CLI, so apply the guess and drop confidence.
          this.deleteRange(wordLeft(this.text, this.cursor), this.cursor)
          this.degrade()
          i += 2
          continue
        }
        if (next === 'd') {
          const to = wordRight(this.text, this.cursor)
          this.text = this.text.slice(0, this.cursor) + this.text.slice(to)
          this.degrade()
          i += 2
          continue
        }
        if (next === 'b') {
          this.cursor = wordLeft(this.text, this.cursor)
          this.degrade()
          i += 2
          continue
        }
        if (next === 'f') {
          this.cursor = wordRight(this.text, this.cursor)
          this.degrade()
          i += 2
          continue
        }
        // Lone ESC (menu close / interrupt / double-ESC history) or an
        // unrecognized Alt+key: effect unknown.
        this.degrade()
        i += next === undefined ? 1 : 2
        continue
      }
      if (ch === '\r') {
        this.enter()
        i++
        continue
      }
      if (ch === '\n') {
        this.insert('\n') // Shift+Enter newline
        i++
        continue
      }
      if (ch === '\x7f' || ch === '\x08') {
        this.backspace()
        i++
        continue
      }
      if (ch === '\x01') {
        this.cursor = lineStart(this.text, this.cursor)
        i++
        continue
      }
      if (ch === '\x05') {
        this.cursor = lineEnd(this.text, this.cursor)
        i++
        continue
      }
      if (ch === '\x15') {
        // Ctrl+U: kill to line start (readline-ish; exact scope differs per CLI)
        this.deleteRange(lineStart(this.text, this.cursor), this.cursor)
        this.degrade()
        i++
        continue
      }
      if (ch === '\x0b') {
        // Ctrl+K: kill to line end
        this.text =
          this.text.slice(0, this.cursor) + this.text.slice(lineEnd(this.text, this.cursor))
        this.degrade()
        i++
        continue
      }
      if (ch === '\x17') {
        // Ctrl+W: word delete backward
        this.deleteRange(wordLeft(this.text, this.cursor), this.cursor)
        this.degrade()
        i++
        continue
      }
      if (ch === '\x0c') {
        i++ // Ctrl+L: clear screen, input untouched
        continue
      }
      if (ch < ' ') {
        // Ctrl+C (clears input in some CLIs, interrupts the turn in others),
        // Tab (completion inserts unseen text), and every other control byte:
        // keep the text — resurrecting a discarded draft is annoying but safe,
        // while assuming empty when text remains would co-submit it.
        this.degrade()
        i++
        continue
      }
      // Printable run
      let j = i
      while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f' && data[j] !== '\x1b') j++
      this.insert(data.slice(i, j))
      i = j
    }
  }

  /** Input typed while the CLI shows a permission prompt / dialog: the keys
   *  drive the dialog, not the input line. Keep the draft, drop confidence
   *  (the Enter that answers the dialog must NOT read as a submit). */
  noteOpaqueInput(): void {
    this.degrade()
  }

  /**
   * Start an injection (stash → clear → deliver → submit → restore). Returns
   * the stash plus the precomputed clear sequence: forward-deletes over
   * everything after the cursor, then backspaces over the buffer's full
   * length (code points: an upper bound on keypresses). When confidence is
   * lost both counts get a cushion; undershoot would leave residue to be
   * co-submitted.
   *
   * Only these two keys are used, and nothing that moves the cursor. Measured
   * on the real CLI: both are no-ops at the input boundary and inside the
   * /model and /mcp dialogs (64 presses each in /model; a full degraded burst
   * leaves /model and /mcp byte-identical), whereas right-arrow — inert in
   * the input box — adjusts the effort control in /model, and the
   * dispatcher's very next write is the submitting CR. A degraded shadow is
   * precisely the state in which such a dialog may be open (the user pressed
   * Down to browse), so the clear sequence itself has to be dialog-safe.
   *
   * Measured NOT to hold everywhere: in /config's filter mode (empty filter
   * after "Esc to clear") forward-deletes change nothing, but the first
   * backspace flips the dialog into select mode, which the following CR
   * would then act on. Accepted here as a documented limitation; the general
   * dialog class (defer delivery while a dialog is open) is a follow-up
   * filed by coordination.
   */
  beginInjection(): DraftStash {
    this.injectionActive = true
    this.dirtiedDuringInjection = false
    const cpAll = codePointCount(this.text)
    const cpAfterCursor = codePointCount(this.text.slice(this.cursor))
    let clear = ''
    if (this.confident) {
      if (cpAll > 0) clear = '\x1b[3~'.repeat(cpAfterCursor) + '\x7f'.repeat(cpAll)
    } else {
      const n = cpAll + UNCONFIDENT_CLEAR_CUSHION
      clear = '\x1b[3~'.repeat(n) + '\x7f'.repeat(n)
    }
    return { text: this.text, confident: this.confident, clear }
  }

  /** End an injection: the input now holds exactly the restored text (when the
   *  clear was complete). Confidence carries over, and drops if a user
   *  keystroke raced the sequence. */
  endInjection(restoredText: string): void {
    this.text = restoredText
    this.cursor = restoredText.length
    if (this.dirtiedDuringInjection) this.confident = false
    this.injectionActive = false
    this.dirtiedDuringInjection = false
  }

  /** Read-only view for diagnostics/probing. */
  snapshot(): { text: string; cursor: number; confident: boolean } {
    return { text: this.text, cursor: this.cursor, confident: this.confident }
  }
}

// Session-keyed registry. Deliberately never pruned: a session's draft
// outlives its xterm mount (hidden tabs unmount their terminal while the CLI
// keeps running), and the residual footprint of a dead session's entry is one
// small object per app run.
const shadows = new Map<string, DraftShadow>()

export function getDraftShadow(sessionId: string): DraftShadow {
  let s = shadows.get(sessionId)
  if (!s) {
    s = new DraftShadow()
    shadows.set(sessionId, s)
  }
  return s
}

/** Forget a session's shadow: main prunes it when the session's process
 *  ends, since a server may run for weeks. The renderer never calls it. */
export function dropDraftShadow(sessionId: string): void {
  shadows.delete(sessionId)
}
