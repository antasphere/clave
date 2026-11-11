import type { AgentState } from '../../../../src/shared/session-model'
import { parseDelivery, type ProvenanceSender } from '../../../../src/shared/exchange-provenance'
import type { Entry } from '../reducer'
import { visibleEntries, type ToolEntry } from '../tools'
import type { PermissionEntry } from '../approvals'
import { clipText } from '../../../../src/shared/helper-prompt'
import { PAGE_TITLE_MESSAGE_CHARS, pageTitleKey } from '../../../../src/shared/page-title'

/* Folio reads the conversation as a book of pages, one per question: the
   reader's message is the page's title, the agent's answer is its text, and
   what the agent did on the way (calls, approvals) is noted in the margin
   beside the paragraph it led to. Decided here without a DOM, so a test can
   pin where a page begins and which note sits beside which paragraph. */

export type UserEntry = Extract<Entry, { kind: 'user' }>
export type AssistantEntry = Extract<Entry, { kind: 'assistant' }>
export type ErrorEntry = Extract<Entry, { kind: 'error' }>
/** What the margin holds: a call, or an approval the agent needed for one. */
export type Note = ToolEntry | PermissionEntry

/** One line of a page: the notes on what was done, then what was written
 *  after it. Either half may be empty: notes alone are work still going on
 *  (or work that ended the turn); prose alone is an answer written straight. */
export interface PageRow {
  key: string
  notes: Note[]
  prose: AssistantEntry | null
  error: ErrorEntry | null
}
export type PageStatus = 'writing' | 'working' | 'waiting' | 'interrupted' | 'done'
export interface Page {
  /** The ordinal of the page's first entry: a page of the past arriving in
   *  front shifts no key, so the page the reader is on stays the one shown. */
  key: string
  /** The key every entry on the page would have had as a page's first: when
   *  the past arrives in front, a page that had no question is merged into
   *  the question before it and its key changes, so the page a reader holds
   *  is found again by any of these (`currentPage`). */
  holds: string[]
  /** 1-based, by position: the number a reader says ("page 3"). */
  number: number
  /** The messages that asked: one, or several sent before any answer. Empty
   *  for what came before the first message of the loaded past. */
  question: UserEntry[]
  /** Another tab, when the message came from one (`clave_send_to_session`). */
  from: ProvenanceSender | null | undefined
  /** The stand-in title: the question's first sentence (`headline`), shown
   *  at once and kept when no written title comes (`PageTitle`). */
  title: string
  /** The key of the title a helper writes for the page (PRDCT-4412), null
   *  for a page with no question to title. */
  titleKey: string | null
  /** The question sent for its title: the reader's words (`fullMessage`)
   *  clipped as the host clips them, so what is sent is what is keyed and
   *  the wire never refuses a long question. Empty with no question. */
  message: string
  /** The question as the reader wrote it: its messages' bodies, delivery
   *  headers taken out, joined with a blank line. Empty with no question. */
  fullMessage: string
  /** The question as the reader wrote it, without a delivery header; empty
   *  when the stand-in title already says all of it (`briefFor` says what
   *  shows under a written title). */
  brief: string
  rows: PageRow[]
  status: PageStatus
  at: number
  /** The answer's text, joined, for copying and for reading aloud. */
  answer: string
  tools: number
  failed: number
}

const MARKER = /\[(?:Image|File|Folder|Session|Video|Audio|PDF|Document) #\d+\]/g
const TITLE_MAX = 84

/** The words of a message, the way its title shows them: the first line that
 *  says something, its markdown and attachment markers taken out, cut at the
 *  first sentence when that ends early enough, or at a word with an ellipsis. */
export function headline(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(MARKER, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
  const line = lines.find((l) => l !== '') ?? ''
  if (!line) return ''
  const sentence = /^(.{12,}?[.?!])(?:\s|$)/.exec(line)
  if (sentence && sentence[1].length <= TITLE_MAX) return sentence[1]
  if (line.length <= TITLE_MAX) return line
  const cut = line.slice(0, TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

const flat = (s: string): string => s.replace(MARKER, '').replace(/\s+/g, ' ').trim()

/** Whether the message says more than its title: the brief is shown under it. */
function briefOf(body: string, title: string): string {
  const full = flat(body)
  return full === '' || full === title || full === title.replace(/…$/, '') ? '' : body.trim()
}

/** What shows under the title on screen: under the stand-in, the page's own
 *  brief (empty when the first sentence was the whole message); under a
 *  title a helper wrote, the whole message, since the written title is not
 *  the reader's words — unless it happens to say exactly them. */
export function briefFor(
  page: Pick<Page, 'title' | 'brief' | 'fullMessage'>,
  shown: string
): string {
  if (shown === page.title) return page.brief
  const full = flat(page.fullMessage)
  return full === '' || full === flat(shown) ? '' : page.fullMessage.trim()
}

/** The key of a page's written title: the message clipped as the host clips
 *  it before keying, so both sides name the same text. */
export function titleKeyOf(message: string): string {
  return pageTitleKey(clipText(message, PAGE_TITLE_MESSAGE_CHARS))
}

function bodyOf(entry: UserEntry): { body: string; from: ProvenanceSender | null | undefined } {
  const delivery = parseDelivery(entry.text)
  return delivery
    ? { body: delivery.body, from: delivery.sender }
    : { body: entry.text, from: undefined }
}

/** Whether a page has anything of the agent's on it yet. */
const answered = (rows: PageRow[]): boolean =>
  rows.some((row) => row.notes.length > 0 || row.prose !== null || row.error !== null)

/**
 * The conversation as pages. `ordinal(entry)` is the entry's own key in the
 * conversation (`Conversation.first + index`); `state` is the kernel's word,
 * which says whether the last page is still being written.
 */
export function buildPages(
  all: Entry[],
  ordinal: (entry: Entry) => number | undefined,
  state: AgentState
): Page[] {
  const entries = visibleEntries(all)
  interface Draft {
    key: string
    holds: string[]
    question: UserEntry[]
    rows: PageRow[]
    at: number
  }
  const drafts: Draft[] = []
  let page: Draft | undefined
  const keyOf = (entry: Entry, fallback: number): string => `${ordinal(entry) ?? `i${fallback}`}`
  entries.forEach((entry, index) => {
    if (entry.kind === 'user') {
      // A message sent before the agent said or did anything joins the
      // question it follows: the reader was still asking.
      if (page && page.question.length > 0 && !answered(page.rows)) page.question.push(entry)
      else {
        page = {
          key: `p${keyOf(entry, index)}`,
          holds: [],
          question: [entry],
          rows: [],
          at: entry.at
        }
        drafts.push(page)
      }
      page.holds.push(`p${keyOf(entry, index)}`)
      return
    }
    if (!page) {
      page = { key: `p${keyOf(entry, index)}`, holds: [], question: [], rows: [], at: entry.at }
      drafts.push(page)
    }
    page.holds.push(`p${keyOf(entry, index)}`)
    const last = page.rows.at(-1)
    const row = (): PageRow => {
      const fresh: PageRow = { key: `r${keyOf(entry, index)}`, notes: [], prose: null, error: null }
      page!.rows.push(fresh)
      return fresh
    }
    if (entry.kind === 'assistant') {
      // Prose goes beside the notes that led to it; after prose, a new line.
      const target = last && last.prose === null && last.error === null ? last : row()
      target.prose = entry
    } else if (entry.kind === 'tool' || entry.kind === 'permission') {
      const target = last && last.prose === null && last.error === null ? last : row()
      target.notes.push(entry)
    } else if (entry.kind === 'error') {
      const target = last && last.prose === null && last.error === null ? last : row()
      target.error = entry
    }
  })
  return drafts.map((draft, i) => {
    const first = draft.question[0]
    const parsed = draft.question.map(bodyOf)
    const body = parsed.map((p) => p.body).join('\n\n')
    const title =
      headline(body) ||
      (draft.question.some((q) => q.attachments?.length)
        ? 'Attachments'
        : first
          ? 'Untitled message'
          : 'Before the first question')
    const notes = draft.rows.flatMap((row) => row.notes)
    const tools = notes.filter((note): note is ToolEntry => note.kind === 'tool')
    const lastPage = i === drafts.length - 1
    const answer = draft.rows
      .flatMap((row) => (row.prose ? [row.prose.text.trim()] : []))
      .join('\n\n')
    return {
      key: draft.key,
      holds: draft.holds,
      number: i + 1,
      question: draft.question,
      from: parsed[0]?.from,
      title,
      titleKey: first && flat(body) ? titleKeyOf(body) : null,
      message: first ? clipText(body, PAGE_TITLE_MESSAGE_CHARS) : '',
      fullMessage: first ? body : '',
      brief: briefOf(body, title),
      rows: draft.rows,
      status: statusOf(draft.question, draft.rows, lastPage ? state : 'done'),
      at: draft.at,
      answer,
      tools: tools.length,
      failed: tools.filter((tool) => tool.failed === true).length
    }
  })
}

function statusOf(question: UserEntry[], rows: PageRow[], state: AgentState): PageStatus {
  if (question.some((q) => q.interrupted)) return 'interrupted'
  const waiting = rows.some((row) =>
    row.notes.some((n) => n.kind === 'permission' && !n.answer && !n.answeredElsewhere)
  )
  if (state === 'blocked' && waiting) return 'waiting'
  if (state === 'working' || state === 'blocked') {
    const last = rows.at(-1)
    return last?.prose && !last.prose.final ? 'writing' : 'working'
  }
  return 'done'
}

/** The page shown: the one the reader holds, while it exists, else the last
 *  (the page being written). Null on an empty book. */
export function currentPage(pages: Page[], held: string | null): Page | null {
  const at = indexOfHeld(pages, held)
  return at >= 0 ? pages[at] : (pages.at(-1) ?? null)
}

/** Where the held page is: by its key, else by the page that took it in. */
function indexOfHeld(pages: Page[], held: string | null): number {
  if (!held) return -1
  const exact = pages.findIndex((p) => p.key === held)
  return exact >= 0 ? exact : pages.findIndex((p) => p.holds.includes(held))
}

/** The page `step` pages away from `key`, clamped to the book. */
export function turnPage(pages: Page[], key: string | null, step: number): Page | null {
  if (!pages.length) return null
  const at = key ? indexOfHeld(pages, key) : pages.length - 1
  const from = at < 0 ? pages.length - 1 : at
  return pages[Math.max(0, Math.min(pages.length - 1, from + step))]
}

/** The words a page's status reads in its eyebrow. */
export const STATUS_WORDS: Record<PageStatus, string> = {
  writing: 'Writing',
  working: 'Working',
  waiting: 'Waiting on you',
  interrupted: 'Interrupted',
  done: ''
}
