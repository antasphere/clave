import { createHash } from 'node:crypto'
import type { LauncherFamily } from '../../shared/agent-launch'
import { HARNESS_BY_ID } from '../../shared/harness'
import { STYLE_SUPPORT } from '../../shared/writing-styles'
import { lazyTerminalPorts } from '../ports/terminals'
import { launchStyle, recordedStyle, type LaunchStyleAnswer } from './source'

/**
 * Which writing style a spawn runs on (PRDCT-5166): the one decision
 * `ptyManager.spawn` takes before any adapter is configured, kept here so it
 * can be read and tested without spawning anything. The machine's styles are
 * read through `source.ts`.
 */

export interface StyleDecisionInput {
  /** The harness the spawn runs; null for a plain terminal. */
  family: LauncherFamily | null
  /** Claude Code's agents view: no conversation, nothing to style. */
  agentsMode?: boolean
  /** A chat tab (events transport) rather than a terminal. */
  chat: boolean
  /** What the launch said (`PtySpawnOptions.writingStyle`). */
  named?: string
  /** The tab is launched again: a restore, a Resume, a restart. */
  adopting: boolean
  /** The style id the adopted tab's record keeps, read before its rewrite. */
  recorded?: string
  /** A routine's run: unattended, so it takes a style only when it names one. */
  routine: boolean
  /** The spawn runs on Windows, where a terminal tab is given no style
   *  (`pty-backend.ts`: `cmd.exe` cannot carry the text). */
  windows?: boolean
}

/**
 * The style a spawn runs on, or the refusal of a style the launch names and
 * cannot have. `style: null` is no style, and then nothing is applied and
 * nothing is recorded:
 *  - a spawn that runs none of the five harnesses (a plain terminal, the
 *    agents view);
 *  - a tab that cannot take a style (`STYLE_SUPPORT`, and a terminal on
 *    Windows) when its launch names none: the machine's default simply does
 *    not apply there, so a record never names a style its agent was not
 *    given. A launch that NAMES one there is refused, never dropped in
 *    silence: an unknown name with the list, as everywhere, a known one with
 *    the sentence that says why;
 *  - a routine's run that names none: nobody reads an unattended run.
 * A tab launched again runs on the style its record keeps when the machine
 * still has it and the tab can take it, never on the default and never
 * refused: it must come back.
 */
export function decideLaunchStyle(input: StyleDecisionInput): LaunchStyleAnswer {
  if (input.family === null || input.agentsMode) return { ok: true, style: null }
  const refusal = cannotTakeStyle(input.family, input.chat, input.windows === true)
  if (refusal !== null) {
    if (input.adopting || input.named === undefined) return { ok: true, style: null }
    const named = launchStyle(input.named)
    if (!named.ok || named.style === null) return named
    return { ok: false, reason: refusal }
  }
  if (input.adopting) return { ok: true, style: recordedStyle(input.named ?? input.recorded) }
  if (input.routine && input.named === undefined) return { ok: true, style: null }
  return launchStyle(input.named)
}

/** Why a tab of this harness and kind takes no style, as the sentence a
 *  launch that names one is refused with; null when it takes one. The way
 *  out names the chat only when the harness's chat does take a style. */
function cannotTakeStyle(family: LauncherFamily, chat: boolean, windows: boolean): string | null {
  const support = STYLE_SUPPORT[family]
  const orChat = support.chat === 'none' ? 'name no style' : 'open it as a chat, or name no style'
  if (support[chat ? 'chat' : 'terminal'] === 'none')
    return `${HARNESS_BY_ID[family].name} takes no writing style in ${chat ? 'a chat' : 'a terminal tab'}: ${chat ? 'name no style' : orChat}.`
  if (!chat && windows) return `A terminal tab takes no writing style on Windows: ${orChat}.`
  return null
}

/** Where an applied style's text is written for a harness that reads its
 *  instructions from a file (OpenCode), under the host's data folder. */
const APPLIED_FOLDER = 'writing-styles/applied'

/**
 * The absolute path of a file holding the style's text, written once: the
 * name is the first 16 hex of the text's sha256, so every tab on the same
 * text shares one file and a changed style gets a new one, never rewriting a
 * file a running tab reads. Under the terminal layer's storage port, the
 * folder `agent-state/` lives under, so the shell and a server of its own
 * each write under their own data folder.
 */
export function appliedStyleFile(text: string): string {
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  const name = `${APPLIED_FOLDER}/${hash}.md`
  const storage = lazyTerminalPorts.storage
  if (storage.read(name) !== text) storage.write(name, text)
  return storage.pathOf(name)
}
