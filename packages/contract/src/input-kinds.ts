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
 * before this file existed. A hosted choice takes the person's own words too
 * (PRDCT-4322), unless the agent closed it to its options (`optionsOnly`).
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
  { id: 'answer', label: 'Approve' },
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
  /** choice only: the answer is one of the options, never the person's own
   *  words (PRDCT-4322); absent, they may edit the option or write their own. */
  optionsOnly?: boolean
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
    value === undefined ||
    (typeof value === 'string' ? value.trim() === '' : value.every((entry) => entry.trim() === ''))
  if (empty) return question.optional ? null : 'An answer is needed'
  if (kind === 'choice' || kind === undefined) {
    if (kind === undefined) return null
    // A choice is one of the options, or several when the question allows
    // it, with the person's own words beside or instead of them (PRDCT-4322);
    // a choice the agent closed to its options (`optionsOnly`) takes those alone.
    const picked = typeof value === 'string' ? [value] : [...value]
    if (!question.multiSelect && picked.length > 1) return 'Choose one'
    if (!question.optionsOnly) return null
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

/** The key a hosted question's answer comes back under: lowercase, digits,
 *  - and _, and never a name the Object prototype already has (`constructor`,
 *  `toString`): a lookup on a plain object would read the prototype's. */
const HOSTED_ID = /^[a-z][a-z0-9_-]{0,63}$/
export const isHostedQuestionId = (id: unknown): id is string =>
  typeof id === 'string' && HOSTED_ID.test(id) && !Object.hasOwn(Object.prototype, id)

/** Why a hosted question's shape does not fit its kind, in the agent's words;
 *  `null` when it fits. The one rule for the tool that takes the question and
 *  the server that stores it, so the server never holds what the tool
 *  refuses: a choice needs its options and nothing else may carry them, a
 *  link needs an http(s) address, bounds belong to a number. */
export function questionShapeProblem(
  q: InputQuestion & { url?: string; confirm?: string }
): string | null {
  if (!isHostedQuestionId(q.id)) return 'a question needs an id: lowercase, digits, - and _'
  const kind = q.kind ?? 'text'
  const has = q.options.length > 0
  if (kind === 'choice' && q.options.length < 2)
    return `"${q.id}": a choice needs two options or more.`
  if (kind === 'choice') {
    // A label is what the answer carries back, trimmed: a label with spaces
    // at its ends could never be answered, two alike could not be told apart.
    const labels = q.options.map((o) => o.label)
    if (labels.some((label) => label !== label.trim() || label === ''))
      return `"${q.id}": an option label has no spaces at its ends.`
    if (new Set(labels).size !== labels.length) return `"${q.id}": two options share a label.`
  }
  if (kind !== 'choice' && (has || q.multiSelect))
    return `"${q.id}": options belong to a choice; use kind "choice".`
  if (kind !== 'choice' && q.optionsOnly !== undefined)
    return `"${q.id}": optionsOnly belongs to a choice.`
  if (kind === 'link') {
    if (!q.url) return `"${q.id}": a link needs its url.`
    try {
      const url = new URL(q.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return `"${q.id}": a link opens an http(s) address.`
    } catch {
      return `"${q.id}": a link opens an http(s) address.`
    }
  } else if (q.url !== undefined || q.confirm !== undefined)
    return `"${q.id}": url and confirm belong to a link.`
  if (kind !== 'number' && (q.min !== undefined || q.max !== undefined))
    return `"${q.id}": min and max belong to a number.`
  if (kind === 'number' && q.min !== undefined && q.max !== undefined && q.min > q.max)
    return `"${q.id}": min is above max.`
  return null
}

/** The first problem among a hosted request's questions, duplicates included. */
export function questionsShapeProblem(
  questions: readonly (InputQuestion & { url?: string; confirm?: string })[]
): string | null {
  if (questions.length === 0) return 'a request needs at least one question'
  const seen = new Set<string>()
  for (const q of questions) {
    const problem = questionShapeProblem(q)
    if (problem) return problem
    if (seen.has(q.id!)) return `Two questions share the id "${q.id}".`
    seen.add(q.id!)
  }
  return null
}

/** A plain object read without its prototype: a key named like a prototype
 *  member answers undefined, never the member. */
export const own = <V>(record: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

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
