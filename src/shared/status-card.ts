/**
 * The status card (PRDCT-5166): what an agent's answer ends on when its
 * writing style asks for one, and how Clave reads it back. ONE module holds
 * the rule the agent is given (`STATUS_CARD_RULE`) and the reader of what it
 * wrote (`readStatusCard`), so the two cannot drift: a field added to the
 * rule is a field the reader knows, in the same change.
 *
 * The agent ends the message that hands the turn back with one fenced block
 * tagged `clave-status`. Clave takes that block out of the answer wherever
 * the answer is shown or reused (the conversation views, a copy, an export,
 * a reading aloud, what another tab reads) and draws it as a card under the
 * answer. A terminal tab shows the block as the agent wrote it.
 *
 * The reader takes the agent's word and nothing else: a block that is not
 * the last thing of the message, that sits inside another fence (an answer
 * quoting the format) or that names no field is not a card, and the text is
 * then left exactly as written. Nothing here guesses a status from prose.
 */

/** The info string of the block's fence. */
export const STATUS_FENCE = 'clave-status'

/** The paragraph a writing style with the card adds to the agent's
 *  instructions (`composeStyleText` in `writing-styles.ts`). Its example IS
 *  the format: `readStatusCard` reads these four keys and no other. */
export const STATUS_CARD_RULE = [
  'Clave shows the person a status card under your answer. End the message that hands the turn back to the person with exactly one fenced block tagged clave-status, and write nothing after it:',
  '',
  '```clave-status',
  'doing: what we are working on, in a few words',
  'where: one or two sentences: what is done, what is left, what this turn changed',
  'decide: a question only the person can answer, with your recommendation and why',
  'next: the one thing the person must do now, or "nothing"',
  '```',
  '',
  'Write `decide` once per decision, at most three times, and leave it out when nothing waits on the person. Write each line as plain prose for someone who just walked in. Put the block only in the message that ends your turn, never in a note between tool calls. Do not end your answer with its own summary or next step: the card is the ending.'
].join('\n')

/** A status as the agent wrote it. */
export interface StatusCard {
  /** What the work is, in a few words; null when the agent left it out. */
  doing: string | null
  /** Where it stands; null when left out. */
  where: string | null
  /** The decisions waiting on the person, in the agent's order. */
  decide: string[]
  /** The one thing the person must do now; null when nothing is owed
   *  (the agent wrote "nothing", or left the line out). */
  next: string | null
}

/** A field is one line of prose: longer is clipped, never refused. */
export const STATUS_FIELD_MAX = 600
/** More decisions than a card can hold are dropped past this many. */
export const STATUS_DECIDE_MAX = 5

/** Whether the status asks something of the person: a decision, or a next
 *  step that is theirs. A card that asks nothing is a finished turn. */
export function statusNeedsYou(card: StatusCard): boolean {
  return card.decide.length > 0 || card.next !== null
}

type Key = 'doing' | 'where' | 'decide' | 'next'

/** `key: value`, behind an optional list bullet and optional bold marks,
 *  which a model adds from habit. */
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*)?(doing|where|decide|next)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i

/** What "nothing is owed" reads as in a `next` line: the rule's own word,
 *  with or without what a model adds after it ("nothing for now"), or a dash. */
const NOTHING = /^["'“”‘’]?\s*(?:(?:nothing|none|n\/a|no action)\b.*|-+|—)$/i

const clip = (value: string): string =>
  value.length > STATUS_FIELD_MAX ? `${value.slice(0, STATUS_FIELD_MAX - 1).trimEnd()}…` : value

/** The fields of a block's inner lines, or null when it names none. A line
 *  that opens with no key continues the field before it (a model wraps). */
function readFields(lines: readonly string[]): StatusCard | null {
  const card: StatusCard = { doing: null, where: null, decide: [], next: null }
  let last: { key: Key; at: number } | null = null
  let named = false
  const put = (key: Key, value: string, at: number | null): number | null => {
    if (key === 'decide') {
      if (at !== null) {
        card.decide[at] = clip(`${card.decide[at]} ${value}`.trim())
        return at
      }
      if (!value) return null
      if (card.decide.length >= STATUS_DECIDE_MAX) return null
      card.decide.push(clip(value))
      return card.decide.length - 1
    }
    const joined = at !== null && card[key] ? `${card[key]} ${value}`.trim() : value
    card[key] = joined ? clip(joined) : null
    return 0
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const match = FIELD.exec(line)
    if (match) {
      const key = match[1].toLowerCase() as Key
      named = true
      const at = put(key, match[2].trim(), null)
      last = at === null ? null : { key, at }
    } else if (last) {
      put(last.key, line, last.at)
    }
  }
  if (!named) return null
  if (card.next !== null && NOTHING.test(card.next)) card.next = null
  if (card.doing === null && card.where === null && card.next === null && !card.decide.length)
    return null
  return card
}

interface Fence {
  char: '`' | '~'
  length: number
  info: string
}

/** A line that opens or closes a fence: up to three spaces, then three or
 *  more backticks or tildes, then the info string (CommonMark). */
function fenceOf(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const info = match[2].trim()
  // A backtick fence's info string holds no backtick: that is inline code.
  if (match[1][0] === '`' && info.includes('`')) return null
  return { char: match[1][0] as '`' | '~', length: match[1].length, info }
}

interface Scan {
  /** Where the last top-level `clave-status` block starts, in characters. */
  start: number
  /** Its inner lines. */
  inner: string[]
  /** Whether its closing fence was written. */
  closed: boolean
  /** Whether anything but white space follows its closing fence. */
  trailed: boolean
}

/** The last `clave-status` block written at the top level of a message: one
 *  walk over its lines, tracking the fence each line is inside, so a block
 *  quoted in another fence is never taken for the message's own. */
function scan(text: string): Scan | null {
  let found: Scan | null = null
  let open: (Fence & { status: boolean }) | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    const fence = fenceOf(line.replace(/\r$/, ''))
    if (open) {
      const closes =
        fence !== null && fence.char === open.char && fence.length >= open.length && !fence.info
      if (closes) {
        if (open.status && found) found.closed = true
        open = null
      } else if (open.status && found) {
        found.inner.push(line)
      }
    } else if (fence) {
      const status = fence.info.toLowerCase() === STATUS_FENCE
      open = { ...fence, status }
      if (status) found = { start: offset, inner: [], closed: false, trailed: false }
    } else if (found?.closed && line.trim()) {
      found.trailed = true
    }
    // A fence opened after the block is something written after it too.
    if (found?.closed && open && !open.status) found.trailed = true
    offset += line.length + 1
  }
  return found
}

/** A finished message: its words and its card. `card` is null, and `body`
 *  the text untouched, unless the message ENDS with one closed, top-level
 *  `clave-status` block that names a field. */
export function readStatusCard(text: string): { body: string; card: StatusCard | null } {
  if (!text.includes(STATUS_FENCE)) return { body: text, card: null }
  const found = scan(text)
  if (!found || !found.closed || found.trailed) return { body: text, card: null }
  const card = readFields(found.inner)
  if (!card) return { body: text, card: null }
  return { body: text.slice(0, found.start).trimEnd(), card }
}

/** The start of a fence line that may still become the block's opening:
 *  ``` alone, or any prefix of the tagged fence, as the stream delivers it. */
function mayOpenStatus(line: string): boolean {
  const match = /^ {0,3}(`{3,})(.*)$/.exec(line)
  if (!match) return false
  if (match[1].length !== 3) return false
  return STATUS_FENCE.startsWith(match[2].toLowerCase())
}

/**
 * A message still being written: what to show of it now (`body`) and what
 * to hold back (`held`), so the block never flashes as code on its way in.
 * Held: a top-level `clave-status` block from its opening fence on, while
 * nothing follows it; and a last, unfinished line that may yet be that
 * fence. `body + held` is always the text as given.
 */
export function holdStatusTail(text: string): { body: string; held: string } {
  const lastBreak = text.lastIndexOf('\n')
  const lastLine = text.slice(lastBreak + 1)
  const tagged = text.includes(STATUS_FENCE)
  const opening = !tagged && mayOpenStatus(lastLine)
  // The common frame: no block in sight, and the line being written is not a
  // fence. Nothing to walk.
  if (!tagged && !opening) return { body: text, held: '' }
  if (tagged) {
    const found = scan(text)
    if (found && !found.trailed)
      return { body: text.slice(0, found.start), held: text.slice(found.start) }
    if (!mayOpenStatus(lastLine)) return { body: text, held: '' }
  }
  // The last line may be the block's fence: held only when it would open a
  // fence, which a line inside another fence never does.
  const before = text.slice(0, lastBreak + 1)
  if (insideFence(before)) return { body: text, held: '' }
  return { body: before, held: lastLine }
}

/** Whether the text ends inside a fence it has not closed. */
function insideFence(text: string): boolean {
  let open: Fence | null = null
  for (const line of text.split('\n')) {
    const fence = fenceOf(line.replace(/\r$/, ''))
    if (open) {
      if (fence && fence.char === open.char && fence.length >= open.length && !fence.info)
        open = null
    } else if (fence) {
      open = fence
    }
  }
  return open !== null
}

/** The card as plain lines, for where a card cannot be drawn: an exported
 *  transcript, what another agent reads of a tab. */
export function statusCardLines(card: StatusCard): string[] {
  const lines: string[] = []
  if (card.doing) lines.push(`Doing: ${card.doing}`)
  if (card.where) lines.push(`Where: ${card.where}`)
  for (const decision of card.decide) lines.push(`To decide: ${decision}`)
  lines.push(`Next: ${card.next ?? 'nothing'}`)
  return lines
}
