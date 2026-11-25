/**
 * Writing styles (PRDCT-5166): how an agent writes to the person, as a named
 * set of instructions a machine keeps and every tab it launches starts with,
 * whatever its harness. Claude Code has its output styles, Codex its
 * developer instructions, OpenCode its instruction files, Pi a flag,
 * Antigravity nothing: a style is written once here and Clave hands it to
 * each harness its own way (`STYLE_SUPPORT`, applied at the spawn).
 *
 * This file is what every side reads: the host's store
 * (`src/main/writing-styles/`), the spawn, the agent tools, the preload's
 * members and the Settings page. The wire's schemas are
 * `@clave/contract/settings/writing-styles`, written from these.
 *
 * Three rules the rest depends on:
 *  - ONE style for every harness. It says how to write to a person, which
 *    does not depend on the tool; only the way it reaches the tool does.
 *  - A tab keeps the style it was opened with. The style's id goes on the
 *    tab's record at its first launch; Claude Code fixes the text for the
 *    whole conversation (its system prompt is recorded on the first request).
 *  - A style takes the place of the harness's own: in a tab that has one,
 *    Claude Code's output style is reset and Codex's own
 *    `developer_instructions` are replaced. `NO_STYLE` leaves both untouched.
 */
import type { LauncherFamily } from './agent-launch'
import { STATUS_CARD_RULE } from './status-card'

/** The id that means no style: the harness writes its own way, and nothing
 *  of Clave's is added to its instructions. What a machine starts on. */
export const NO_STYLE = 'none'

export interface WritingStyle {
  /** Its handle: what a tab's record keeps and what an agent names when it
   *  opens a tab. A slug, unique on the machine, never `none`. */
  id: string
  name: string
  /** One line on when to use it, read by the person in Settings and by an
   *  agent choosing a style (`clave_launch_options`). */
  description: string
  /** The instructions, as the agent is given them. */
  text: string
  /** Whether each answer ends with the status card: the card's rule is then
   *  added after the text (`composeStyleText`). */
  statusCard: boolean
  /** A style Clave ships: read-only, on every machine under the same id. */
  builtIn: boolean
}

/** What a save carries. An `id` names the style to change; none creates one. */
export interface WritingStyleDraft {
  id?: string
  name: string
  description: string
  text: string
  statusCard: boolean
}

/** A machine's styles as Settings and the agent tools read them. */
export interface WritingStylesView {
  /** The built-in styles first, then the machine's own in the order made. */
  styles: WritingStyle[]
  /** The style a tab starts with when its launch names none; null is no style. */
  defaultStyleId: string | null
  /** The output style Claude Code is set to on this machine, when it is one
   *  of the person's own files: what "Import from Claude Code" would copy.
   *  Null when Claude Code runs on its default or one of its built-in styles. */
  claudeOutputStyle: { name: string } | null
}

/** What a server released before the writing styles is said to need. The
 *  client says the same words (`packages/client/src/settings.ts`, which
 *  cannot import this file; its test holds the two equal). */
export const WRITING_STYLES_NEED_UPDATE = 'This server needs an update to show its writing styles.'

export const WRITING_STYLE_LIMITS = {
  name: 60,
  description: 200,
  text: 6000,
  /** The machine's own styles, the built-in ones not counted. */
  styles: 30
} as const

export const BUILT_IN_STYLES: readonly WritingStyle[] = [
  {
    id: 'brief',
    name: 'Brief',
    description:
      'For a tab you talk to: the answer first, short, in plain sentences, with a status card at the end.',
    text: [
      'How you write to the person in this session:',
      '',
      'The answer comes first. Your first sentence answers the question or says what you did, not what you checked or what you are about to do.',
      '',
      'Keep it short. Most replies fit in 120 words, an explanation in 200. One idea per sentence. Write plain full sentences: say what a thing is before you use a name for it, and never use a label you coined while working.',
      '',
      'Bullets are for parallel items, one line each. No headings in a short reply. When there is a choice, give one recommendation with its reason and what would change it, not a survey of the options.',
      '',
      'Never cut an error message, the output of a failing test, the confirmation of a destructive action, or a path the person must open.'
    ].join('\n'),
    statusCard: true,
    builtIn: true
  },
  {
    id: 'quiet',
    name: 'Quiet',
    description:
      'For work handed to an agent that nobody watches as it runs, a lane for instance: no comments on the way, one report at the end.',
    text: [
      'How you write in this session: nobody reads it while you work.',
      '',
      'Write nothing between your tool calls: no plan, no progress note, no summary of what a command printed. Work until the task is done, or until you cannot go on without the person.',
      '',
      'Then write one report: what was asked, what you did, what you checked and how, and what is left. Keep it short and plain. If you are blocked, say first what blocks you and what would unblock you.'
    ].join('\n'),
    statusCard: true,
    builtIn: true
  }
]

const BUILT_IN_IDS = new Set(BUILT_IN_STYLES.map((style) => style.id))

/** Whether an id is one a machine's own style may not take. */
export function isReservedStyleId(id: string): boolean {
  return id === NO_STYLE || BUILT_IN_IDS.has(id)
}

/** The instructions a tab is launched with for a style: its text, then the
 *  status card's rule when the style asks for the card. Empty for a style
 *  with neither, which adds nothing. */
export function composeStyleText(style: Pick<WritingStyle, 'text' | 'statusCard'>): string {
  const text = style.text.trim()
  if (!style.statusCard) return text
  return text ? `${text}\n\n${STATUS_CARD_RULE}` : STATUS_CARD_RULE
}

/** How a style reaches a harness's tab:
 *  - `instructions`: in the harness's own instructions, beside its base
 *    prompt, for the whole conversation;
 *  - `first-message`: sent with the first message of the conversation, the
 *    weaker road of a harness that takes no instructions at launch;
 *  - `none`: the harness has no way to take it there. */
export type StyleSupport = 'instructions' | 'first-message' | 'none'

/**
 * What each harness takes, in a terminal tab and in a chat (checked on 25
 * November 2026):
 *  - Claude Code: `--append-system-prompt`, with `outputStyle` reset in the
 *    `--settings` the launch already passes (real model, 2.1.332);
 *  - Pi: `--append-system-prompt`, in its rpc mode too (real model, 1.6.1);
 *  - OpenCode: an instruction file named in `OPENCODE_CONFIG_CONTENT`, read
 *    by a `--standalone` TUI and by `opencode acp`; the person's own
 *    instruction files are kept beside it (real model, 2.4.1);
 *  - Codex: `-c developer_instructions=…` in a terminal, the
 *    `developerInstructions` of `thread/start` and `thread/resume` in a chat
 *    (read in its source, 0.53.0 and later; not run here);
 *  - Antigravity: no flag, setting or protocol parameter at launch (read in
 *    its documentation; not run here). A chat sends the style with its first
 *    message; a terminal tab, typed into by the person, cannot.
 */
export const STYLE_SUPPORT: Readonly<
  Record<LauncherFamily, { terminal: StyleSupport; chat: StyleSupport }>
> = {
  claude: { terminal: 'instructions', chat: 'instructions' },
  codex: { terminal: 'instructions', chat: 'instructions' },
  pi: { terminal: 'instructions', chat: 'instructions' },
  opencode: { terminal: 'instructions', chat: 'instructions' },
  antigravity: { terminal: 'none', chat: 'first-message' }
}

/** How a first message that carries a style opens, and where the person's
 *  own message begins in it: the two marks `messageWithoutStyle` reads back. */
const FIRST_MESSAGE_OPENING =
  'Before my message, how to write to me for this whole conversation. Follow it without commenting on it.'
const FIRST_MESSAGE_MARK = '\n\nMy message:\n\n'

/** A first message that carries a style, for a harness on the
 *  `first-message` road: the style said as what it is, so the agent does not
 *  answer it, then the message as the person wrote it. */
export function styleAsFirstMessage(styleText: string, message: string): string {
  return `${FIRST_MESSAGE_OPENING}\n\n${styleText}${FIRST_MESSAGE_MARK}${message}`
}

/** The message the person wrote, from what a harness on the `first-message`
 *  road kept of it: a conversation loaded back replays what was SENT, the
 *  style included, and the views show what was written. A message that does
 *  not open on the style is given back as it is. */
export function messageWithoutStyle(sent: string): string {
  if (!sent.startsWith(FIRST_MESSAGE_OPENING)) return sent
  const at = sent.indexOf(FIRST_MESSAGE_MARK, FIRST_MESSAGE_OPENING.length)
  return at < 0 ? sent : sent.slice(at + FIRST_MESSAGE_MARK.length)
}

/** A slug of a name: lower-case words joined by dashes. */
function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** The id a new style takes: its name's slug, numbered when taken. */
export function styleIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = slug(name) || 'style'
  const free = (id: string): boolean => !taken.has(id) && !isReservedStyleId(id)
  if (free(base)) return base
  for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`
}

export type StyleDraftCheck = { ok: true; draft: WritingStyleDraft } | { ok: false; reason: string }

/** A draft as far as it can be saved: trimmed, within the limits, with a
 *  name. The reason is a sentence for the person. */
export function checkStyleDraft(raw: unknown): StyleDraftCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, reason: 'The style is not valid.' }
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const description = typeof r.description === 'string' ? r.description.trim() : ''
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  const statusCard = r.statusCard === true
  if (!name) return { ok: false, reason: 'A style needs a name.' }
  if (name.toLowerCase() === NO_STYLE)
    return { ok: false, reason: `"${name}" is the name of no style: choose another.` }
  if (name.length > WRITING_STYLE_LIMITS.name)
    return { ok: false, reason: `The name is over ${WRITING_STYLE_LIMITS.name} characters.` }
  if (description.length > WRITING_STYLE_LIMITS.description)
    return {
      ok: false,
      reason: `The description is over ${WRITING_STYLE_LIMITS.description} characters.`
    }
  if (text.length > WRITING_STYLE_LIMITS.text)
    return {
      ok: false,
      reason: `The instructions are over ${WRITING_STYLE_LIMITS.text} characters.`
    }
  if (!text && !statusCard)
    return { ok: false, reason: 'A style needs instructions, or the status card.' }
  const id = typeof r.id === 'string' && r.id ? r.id : undefined
  return { ok: true, draft: { ...(id ? { id } : {}), name, description, text, statusCard } }
}

/** The style a launch names, by id or by its exact name in any case:
 *  the style, `none` for the word that means no style, or null when the
 *  machine has no such style. */
export function findStyle(
  styles: readonly WritingStyle[],
  ref: string
): WritingStyle | typeof NO_STYLE | null {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) return null
  if (wanted === NO_STYLE) return NO_STYLE
  return (
    styles.find((style) => style.id === wanted) ??
    styles.find((style) => style.name.toLowerCase() === wanted) ??
    null
  )
}
