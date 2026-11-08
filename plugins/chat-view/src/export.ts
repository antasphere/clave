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
export function transcriptMarkdown(entries: Entry[], meta: TranscriptMeta): string {
  const out: string[] = []
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

  for (const entry of visibleEntries(entries)) {
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
