/**
 * The kinds of value an agent may ask the person for through
 * `clave_request_input`, and the one rule that says whether an answer fits
 * its kind. Pure and dependency-free on purpose: the renderer validates a
 * field as it is typed, the server validates the answer it is handed, and
 * both must say the same thing, so both read this file (PRDCT-4157).
 *
 * A question's `kind` is optional on the wire: a question without one is a
 * provider's own (Claude's AskUserQuestion, Codex's request_user_input), a
 * choice among its options with the reader's own words allowed, exactly as
 * before this file existed.
 */

export const INPUT_KINDS = [
  'text',
  'long-text',
  'email',
  'url',
  'github-login',
  'number',
  'date',
  'choice',
  'file',
  'folder',
  'link'
] as const
export type InputKind = (typeof INPUT_KINDS)[number]

/** The tool name a hosted request carries, the way the renderer and the
 *  server tell it from a provider's native question. */
export const INPUT_REQUEST_TOOL = 'clave_request_input'

/** The option ids every hosted request answers with: the answers themselves,
 *  or a skip. The same two words a native question uses, so the card's
 *  keyboard and its transcript row read both alike. */
export const INPUT_REQUEST_OPTIONS = [
  { id: 'answer', label: 'Send' },
  { id: 'deny', label: 'Skip' }
] as const

/** What a hosted request's `input` carries beside the questions: the tool
 *  that asked, and how the card lays the questions out. */
export interface InputRequestMeta {
  tool: typeof INPUT_REQUEST_TOOL
  layout: 'form' | 'steps'
}

/** The fields of a question this file judges; the wire's `AgentQuestion`
 *  carries them all as optionals. */
export interface InputQuestion {
  id?: string
  question: string
  kind?: InputKind
  optional?: boolean
  multiSelect?: boolean
  options: readonly { label: string }[]
  min?: number
  max?: number
}

export type InputAnswer = string | readonly string[]

/** A GitHub login: 1 to 39 alphanumerics or hyphens, no hyphen at either
 *  end, no two in a row. GitHub's own rule. */
const GITHUB_LOGIN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/
/** An e-mail as the person will type it: one @, something on each side, a
 *  dot in the domain. Enough to catch a typo, never the RFC. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const text = (value: InputAnswer): string => (typeof value === 'string' ? value : '')

/**
 * Why an answer does not fit its question, in the words the card shows under
 * the field; `null` when it fits. An empty answer fits only an optional
 * question. The message is the person's, so it names what to type, never the
 * rule that failed.
 */
export function answerProblem(
  question: InputQuestion,
  value: InputAnswer | undefined
): string | null {
  const kind = question.kind
  const empty =
    value === undefined || (typeof value === 'string' ? value.trim() === '' : value.length === 0)
  if (empty) return question.optional ? null : 'An answer is needed'
  if (kind === 'choice' || kind === undefined) {
    if (kind === undefined) return null
    // A choice is one of the options, or several when the question allows it;
    // a hosted choice offers no free words (a text field asks for those).
    const picked = typeof value === 'string' ? [value] : [...value]
    if (!question.multiSelect && picked.length > 1) return 'Choose one'
    const labels = new Set(question.options.map((o) => o.label))
    return picked.every((label) => labels.has(label)) ? null : 'Choose among the options'
  }
  if (Array.isArray(value)) return 'One answer is expected'
  const v = text(value).trim()
  switch (kind) {
    case 'email':
      return EMAIL.test(v) ? null : 'This is not an e-mail address'
    case 'url':
      try {
        const url = new URL(v)
        return url.protocol === 'http:' || url.protocol === 'https:'
          ? null
          : 'A web address starts with https://'
      } catch {
        return 'This is not a web address'
      }
    case 'github-login':
      return GITHUB_LOGIN.test(v) ? null : 'A GitHub login is letters, digits and hyphens'
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return 'This is not a number'
      const n = Number(v)
      if (question.min !== undefined && n < question.min) return `At least ${question.min}`
      if (question.max !== undefined && n > question.max) return `At most ${question.max}`
      return null
    }
    case 'date': {
      if (!DATE.test(v)) return 'A date, as YYYY-MM-DD'
      const d = new Date(`${v}T00:00:00Z`)
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v
        ? 'This is not a date'
        : null
    }
    case 'file':
    case 'folder':
      return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('~')
        ? null
        : 'A full path, from the root of the disk'
    case 'link':
      // The only answer a link takes is the confirmation that the reader is back.
      return v === 'done' ? null : 'Open the link, then confirm'
    case 'text':
    case 'long-text':
      return null
  }
  return null
}

/** The kinds whose field is one line of text the person types. */
export const isTypedKind = (kind: InputKind | undefined): boolean =>
  kind === 'text' ||
  kind === 'email' ||
  kind === 'url' ||
  kind === 'github-login' ||
  kind === 'number' ||
  kind === 'date'

/** The kinds whose answer is a path on a disk. */
export const isPathKind = (kind: InputKind | undefined): boolean =>
  kind === 'file' || kind === 'folder'

/** Whether the `input` of a request says it is a hosted input request, and
 *  the layout it asked for; `null` for a provider's native question. */
export function inputRequestMeta(input: unknown): InputRequestMeta | null {
  if (!input || typeof input !== 'object') return null
  const meta = input as { tool?: unknown; layout?: unknown }
  if (meta.tool !== INPUT_REQUEST_TOOL) return null
  return { tool: INPUT_REQUEST_TOOL, layout: meta.layout === 'steps' ? 'steps' : 'form' }
}
