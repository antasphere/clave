/**
 * The exchange digest: what a reader needs from the messages other tabs sent
 * a session, read by a one-shot model call (`src/main/exchange-digest.ts`)
 * and shown at the head of the exchange timeline (plugins/chat-view
 * `DeliveryStack`). Not a summary of what was said: the one thing the reader
 * must know or act on, or that there is nothing for them.
 */

/** One message of the timeline, as the digest reads it. */
export interface DigestMessage {
  /** The sending tab's name. */
  from: string
  text: string
  /** What this session had sent that tab before, when it had. */
  request?: string
  /** What this session answered that tab after, when it did. */
  reply?: string
}

/** The session the timeline belongs to, so the call runs the agent it runs:
 *  the same four fields a tab title is named with. */
export interface DigestLaunch {
  workspaceId?: string
  launchProfileId?: string
  claudeProfileId?: string
  configDir?: string
}

export interface DigestRequest {
  launch: DigestLaunch
  messages: DigestMessage[]
}

export type DigestResult =
  | {
      ok: true
      /** Whether something here needs the reader. */
      needsYou: boolean
      /** One or two plain sentences, or "Nothing for you." */
      summary: string
      /** The message it came from, 0-based, when one did. */
      message: number | null
    }
  | { ok: false; error: string }

/** The opening line of the digest prompt: the session history reads it to
 *  keep these one-shots out of the reader's past conversations. */
export const DIGEST_HELPER_MARKER = 'Clave exchange digest: read the messages other agent tabs sent'

/** The prompt: the messages numbered, each with what was asked before it and
 *  answered after it, and the one question asked of them. */
export function digestPrompt(messages: readonly DigestMessage[]): string {
  const blocks = messages.map((message, index) => {
    const lines = [`### Message ${index + 1}, from "${message.from}"`]
    if (message.request) lines.push(`(This session had asked them:)\n${message.request}`)
    lines.push(`(They wrote:)\n${message.text}`)
    if (message.reply) lines.push(`(This session answered them:)\n${message.reply}`)
    return lines.join('\n')
  })
  return `${DIGEST_HELPER_MARKER} to this session, and tell its human what they need to know.

The human supervises several AI agent sessions. Other sessions send this one messages: acknowledgements, progress, reports, questions. The human does not read them all. Your job is NOT to summarise them. Say only what the human must know or act on: a decision or answer asked of them, a blocker, a failure, a finding that changes the plan, or a result they were waiting for. Ignore acknowledgements, routine progress and anything already handled.

Reply with ONE line of JSON and nothing else:
{"needs_you": true or false, "message": the number of the message it comes from or null, "summary": "at most two short plain sentences, under 35 words, saying what they need to know or decide"}
When nothing needs the human: {"needs_you": false, "message": null, "summary": "Nothing for you."}

${blocks.join('\n\n')}`
}

/** The model's reply read back: the JSON object on its own line, tolerant of a
 *  code fence or a sentence around it. Null when there is no such object, or
 *  its fields are not the asked shape. `count` bounds the message number. */
export function parseDigestReply(
  stdout: string,
  count: number
): Extract<DigestResult, { ok: true }> | null {
  const match = /\{[\s\S]*\}/.exec(stdout)
  if (!match) return null
  let value: unknown
  try {
    value = JSON.parse(match[0])
  } catch {
    return null
  }
  const reply = value as { needs_you?: unknown; message?: unknown; summary?: unknown }
  if (typeof reply.needs_you !== 'boolean' || typeof reply.summary !== 'string') return null
  const summary = reply.summary.trim()
  if (!summary) return null
  const number = typeof reply.message === 'number' ? reply.message : null
  const message =
    number !== null && Number.isInteger(number) && number >= 1 && number <= count
      ? number - 1
      : null
  return { ok: true, needsYou: reply.needs_you, summary, message }
}
