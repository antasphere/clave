import type { Entry } from './reducer'
import { describeToolHead, visibleEntries } from './tools'

/** What the transcript's head says about the conversation it holds. */
export interface TranscriptMeta {
  /** The tab's name. */
  title: string
  /** Who answers, in the reader's words: Claude, Codex, Pi. */
  agent: string
  cwd?: string
  model?: string | null
  /** When the copy was taken. */
  exportedAt: Date
}

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (at: number): string => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** A target in inline code, with the fence widened past any backtick it holds. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/**
 * The conversation as Markdown, as a reader would paste it into a document or
 * another agent: each message under who said it and when, the agent's tool
 * runs as one line each (what it did and to what, never the output), an
 * approval as the question and the answer. Messages taken back before any
 * answer are left out, as the transcript leaves them out on screen.
 */
export interface TranscriptOptions {
  /** Write what the tools of the LAST stretch returned (the runs since the
   *  reader's last message), each output cut to `outputChars`: what another
   *  agent taking the conversation over needs to see, where a reader's copy
   *  needs only what was done (PRDCT-4300). */
  lastStretchOutputs?: boolean
  outputChars?: number
}

/** A tool's output as text, cut to `limit` characters with the cut said. */
function outputText(output: unknown, limit: number): string {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output
            .map((block) =>
              block &&
              typeof block === 'object' &&
              typeof (block as { text?: unknown }).text === 'string'
                ? (block as { text: string }).text
                : JSON.stringify(block)
            )
            .join('\n')
        : output === undefined || output === null
          ? ''
          : JSON.stringify(output)
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
    : text
}

export function transcriptMarkdown(
  entries: Entry[],
  meta: TranscriptMeta,
  options: TranscriptOptions = {}
): string {
  const out: string[] = []
  const lastUser = entries.findLastIndex((e) => e.kind === 'user' && !e.withdrawn)
  const outputChars = options.outputChars ?? 4000
  out.push(`# ${meta.title.trim() || 'Session'}`)
  const facts = [
    meta.agent,
    meta.model ?? null,
    meta.cwd ? code(meta.cwd) : null,
    `exported ${day(meta.exportedAt)} ${clock(meta.exportedAt.getTime())}`
  ].filter(Boolean)
  out.push('', facts.join(' · '))

  // Who holds the floor: a heading is written only when the speaker changes,
  // so an answer split by tool runs reads as one answer.
  let speaker: 'user' | 'agent' | null = null
  const turn = (who: 'user' | 'agent', at: number): void => {
    if (speaker === who) return
    speaker = who
    out.push('', `## ${who === 'user' ? 'You' : meta.agent} · ${clock(at)}`)
  }
  // Tool lines sit together as one list; anything else closes it.
  let inList = false
  const block = (text: string): void => {
    inList = false
    out.push('', text)
  }
  const item = (text: string): void => {
    if (!inList) out.push('')
    inList = true
    out.push(`- ${text}`)
  }

  const shown = visibleEntries(entries)
  for (const entry of shown) {
    switch (entry.kind) {
      case 'user': {
        turn('user', entry.at)
        if (entry.text.trim()) block(entry.text.trim())
        const files = (entry.attachments ?? []).map((file) =>
          file.delivery === 'session' ? `the session “${file.name}”` : code(file.name)
        )
        if (files.length) block(`_Attached: ${files.join(', ')}_`)
        if (entry.interrupted) block('_Interrupted_')
        break
      }
      case 'assistant': {
        if (!entry.text.trim()) break
        turn('agent', entry.at)
        block(entry.text.trim())
        break
      }
      case 'tool': {
        turn('agent', entry.at)
        const { label, target } = describeToolHead(entry)
        const what = target ? `${label} ${code(target)}` : label
        item(entry.failed ? `${what} _(failed)_` : what)
        if (
          options.lastStretchOutputs &&
          entry.complete &&
          entries.indexOf(entry) > lastUser &&
          entry.output !== undefined
        ) {
          const text = outputText(entry.output, outputChars).trim()
          if (text) {
            inList = false
            out.push('', '  ```', ...text.split('\n').map((line) => `  ${line}`), '  ```')
          }
        }
        break
      }
      case 'permission': {
        turn('agent', entry.at)
        const asked = entry.request.description.trim() || entry.request.toolName || 'Approval'
        const answered = entry.answers
          ? Object.values(entry.answers).join('; ')
          : entry.answer
            ? (entry.request.options.find((o) => o.id === entry.answer)?.label ?? entry.answer)
            : entry.answeredElsewhere
              ? 'answered elsewhere'
              : 'no answer'
        block(`> **Asked:** ${asked.replace(/\n+/g, ' ')}\n> **Answer:** ${answered}`)
        break
      }
      case 'error': {
        block(`> **Error:** ${entry.message.replace(/\n+/g, ' ')}`)
        break
      }
    }
  }
  return out.join('\n').trimEnd() + '\n'
}

/** A file name for the transcript, from the tab's name: safe on every disk. */
export function transcriptFileName(title: string, exportedAt: Date): string {
  // Control characters out first, by code point: a regex naming them is one
  // the linter refuses, and they are rare enough not to need one.
  const printable = Array.from(title, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  const base =
    printable
      .trim()
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Session'
  return `${base} ${day(exportedAt)}.md`
}

/** The files the agent edited or created in this conversation, from its own
 *  edit calls, each once, in the order first touched. */
export function editedFiles(entries: Entry[]): string[] {
  const files: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    const { kind, target } = describeToolHead(entry)
    if (kind === 'edit' && target && !files.includes(target)) files.push(target)
  }
  return files
}

/** The most files the handoff lists and the most characters of `git diff
 *  --stat` it carries; the rest is in the full conversation on disk. */
export const MAX_HANDOFF_FILES = 100
export const MAX_HANDOFF_DIFF_CHARS = 4000

export interface HandoffExtras {
  /** The provider the conversation ran on, as the reader names it (Claude). */
  from: string
  /** What the previous agent wrote for its successor, when it was asked. */
  note?: string | null
  files: string[]
  /** `git diff --stat` of the worktree, null when the folder is no checkout. */
  diffStat: string | null
  /** Where the whole conversation was written beside the work. */
  tapePath: string
  /** The room the message may take, in characters, sized to the target
   *  model's window; the transcript is cut from its oldest turns to fit,
   *  the first message kept, the cut said. */
  budgetChars: number
}

/** The newest end of a text that does not fit, the cut said first. */
function newestEnd(text: string, budget: number, tapePath: string): string {
  const note = `## … the start of this is left out for room; the full conversation is in ${tapePath}\n\n`
  // A room smaller than the note itself holds the note alone, cut.
  if (budget <= note.length) return note.slice(0, Math.max(0, budget))
  return note + text.slice(-(budget - note.length))
}

/** A head too big for its room: its first line (the title, or the first
 *  speaker's heading) kept, then the newest end of the rest, so the reader
 *  still knows whose conversation this is (verifier round 2 R4). */
function headCut(head: string, room: number, tapePath: string): string {
  const firstLine = head.split('\n', 1)[0]
  const rest = head.slice(firstLine.length).replace(/^\n+/, '')
  const keep = `${firstLine}\n\n`
  if (keep.length >= room) return newestEnd(head, room, tapePath)
  return keep + newestEnd(rest, room - keep.length, tapePath)
}

/** The transcript cut to `budget` characters: the head (the title and the
 *  first turn) kept, then the newest turns that fit, the gap said where
 *  the oldest turns were. The newest turn is never dropped: when it alone
 *  is bigger than the room, its newest end is kept and its cut said; a head
 *  too big for the room is cut the same way. Whole when it fits. */
export function cutTranscript(markdown: string, budget: number, tapePath: string): string {
  if (markdown.length <= budget) return markdown
  const turns = markdown.split(/\n(?=## )/)
  if (turns.length < 3) return headCut(markdown, budget, tapePath)
  const gap = (n: number): string =>
    `## … ${n} earlier turn${n === 1 ? '' : 's'} left out for room; the full conversation is in ${tapePath}`
  const rest = turns.slice(2)
  const newest = rest[rest.length - 1]
  let head = turns.slice(0, 2).join('\n')
  // The head takes at most a third of the room, so the newest turn always has its share.
  const headRoom = Math.floor(budget / 3)
  if (head.length > headRoom) head = headCut(head, headRoom, tapePath)
  const fixed = head.length + gap(rest.length).length + 2
  const kept: string[] = []
  let size = fixed
  for (let i = rest.length - 1; i >= 0; i--) {
    if (size + rest[i].length + 1 > budget) break
    kept.unshift(rest[i])
    size += rest[i].length + 1
  }
  if (kept.length === 0) kept.push(newestEnd(newest, Math.max(0, budget - fixed), tapePath))
  const left = rest.length - kept.length
  if (left === 0) return [head, ...kept].join('\n')
  return [head, gap(left), ...kept].join('\n')
}

/**
 * The first message of a conversation that moves to another provider as a
 * handoff (PRDCT-4300): who it comes from and what it is, the previous
 * agent's note when one was written, the conversation as Markdown with the
 * last stretch's tool outputs, the files the agent touched, the worktree's
 * diff summary, and where the full tape is. Sized to `budgetChars`.
 */
export function handoffMessage(
  entries: Entry[],
  meta: TranscriptMeta,
  extras: HandoffExtras
): string {
  const header = `Continued from ${extras.from} · handoff`
  const intro = `This conversation ran on ${extras.from}${meta.cwd ? ` in ${code(meta.cwd)}` : ''} and moves to you here. You are reading a transcript of it, not continuing it: what ${extras.from} had in its working memory, the approvals it was granted and the live results of its earlier tool runs are not yours. The files it changed are on disk. Read, then carry on from where it stopped.`
  const fixed: string[] = [`# ${header}`, '', intro]
  if (extras.note?.trim())
    fixed.push('', `## Handoff note from ${extras.from}`, '', extras.note.trim())
  // The tail has its own ceiling, so a huge diff summary or file list can
  // never push the message past its budget (verifier round 2 R6).
  const tail: string[] = []
  const files = extras.files.slice(0, MAX_HANDOFF_FILES)
  if (extras.files.length) {
    tail.push(
      '',
      '## Files edited or created in this conversation',
      '',
      ...files.map((f) => `- ${code(f)}`)
    )
    if (extras.files.length > files.length)
      tail.push(`- … and ${extras.files.length - files.length} more, in the full conversation`)
  }
  if (extras.diffStat) {
    const stat =
      extras.diffStat.length > MAX_HANDOFF_DIFF_CHARS
        ? `${extras.diffStat.slice(0, MAX_HANDOFF_DIFF_CHARS)}\n… (${extras.diffStat.length - MAX_HANDOFF_DIFF_CHARS} more characters)`
        : extras.diffStat
    tail.push('', '## Working tree (git diff --stat)', '', '```', stat, '```')
  }
  tail.push('', `The full conversation, tool outputs included, is in ${code(extras.tapePath)}.`)
  const transcript = transcriptMarkdown(entries, meta, { lastStretchOutputs: true })
    .replace(/^# .*\n\n[^\n]*\n/, '')
    .trim()
  const room = extras.budgetChars - fixed.join('\n').length - tail.join('\n').length - 40
  const body = cutTranscript(transcript, Math.max(room, 2000), extras.tapePath)
  return [...fixed, '', '## The conversation so far', '', body, ...tail].join('\n').trimEnd() + '\n'
}
