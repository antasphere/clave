/**
 * The writing styles of each machine as the Settings page shows them
 * (PRDCT-5166): this Mac's and every saved server's, by machine id
 * (`LOCAL_SERVER_ID` for this Mac). Nothing here is a truth of its own: the
 * styles live on the machine whose tabs start with them, every read and
 * every write goes there (`fleetWritingStyles` and the `fleetWritingStyle*`
 * members, which keep this Mac's on its own route), and the view kept is
 * that machine's last answer.
 */
import { create } from 'zustand'
import {
  STYLE_SUPPORT,
  WRITING_STYLES_NEED_UPDATE,
  type StyleSupport,
  type WritingStyle,
  type WritingStyleDraft,
  type WritingStylesView
} from '../../../shared/writing-styles'
import type { Harness } from '../../../shared/harness'

export interface MachineWritingStyles {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** One safe sentence about the machine's styles, never the raw error. */
  error: string | null
  view: WritingStylesView | null
}

export const EMPTY_MACHINE_STYLES: MachineWritingStyles = {
  status: 'idle',
  error: null,
  view: null
}

export const useWritingStylesStore = create<{ byMachine: Record<string, MachineWritingStyles> }>(
  () => ({ byMachine: {} })
)

function patchMachine(
  machine: string,
  next: (current: MachineWritingStyles) => MachineWritingStyles
): void {
  useWritingStylesStore.setState((state) => ({
    byMachine: {
      ...state.byMachine,
      [machine]: next(state.byMachine[machine] ?? EMPTY_MACHINE_STYLES)
    }
  }))
}

/** The sentences the machine's store refuses with (`src/main/writing-styles/
 *  store.ts` and the seam's `checkStyleDraft`): shown as they are. Anything
 *  else is a failure on the road, said plainly, never as the raw error. */
const REFUSAL =
  /^(A style needs|The style is not valid|"[^"]*" is the name of no style|The name is over|The description is over|The instructions are over|Another style is already named|The built-in styles cannot|This style no longer exists|This machine keeps at most|Claude Code has no output style|Claude Code's output style is over|This server keeps no writing styles)/

/** The refusal's own sentence when the machine gave one, else a plain one. */
function sentenceOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes(WRITING_STYLES_NEED_UPDATE)) return WRITING_STYLES_NEED_UPDATE
  // IPC wraps a refusal ("Error invoking remote method '…': Error: <sentence>").
  const sentence = message.split(/\bError: /).pop() ?? ''
  return REFUSAL.test(sentence) ? sentence : fallback
}

/** Read a machine's styles. */
export async function loadWritingStyles(machine: string): Promise<void> {
  patchMachine(machine, (current) => ({ ...current, status: 'loading', error: null }))
  try {
    const view = await window.electronAPI.fleetWritingStyles(machine)
    patchMachine(machine, () => ({ status: 'ready', error: null, view }))
  } catch (error) {
    // A server released before this page answers its routes with a 404,
    // which the client says as the update it needs.
    patchMachine(machine, (current) => ({
      ...current,
      status: 'error',
      error: sentenceOf(error, 'The writing styles could not be read from this machine.')
    }))
  }
}

/** One write on the machine: the view on screen becomes its answer, and a
 *  refusal comes back as its sentence (null when the write landed), for the
 *  control that made it to show beside itself. */
async function write(
  machine: string,
  run: () => Promise<WritingStylesView>,
  fallback: string
): Promise<string | null> {
  try {
    const view = await run()
    patchMachine(machine, () => ({ status: 'ready', error: null, view }))
    return null
  } catch (error) {
    return sentenceOf(error, fallback)
  }
}

const NOT_REACHED = 'The change did not reach the machine.'

export function saveWritingStyle(
  machine: string,
  draft: WritingStyleDraft
): Promise<string | null> {
  return write(machine, () => window.electronAPI.fleetWritingStyleSave(machine, draft), NOT_REACHED)
}

export function deleteWritingStyle(machine: string, id: string): Promise<string | null> {
  return write(machine, () => window.electronAPI.fleetWritingStyleDelete(machine, id), NOT_REACHED)
}

export function setDefaultWritingStyle(machine: string, id: string | null): Promise<string | null> {
  return write(
    machine,
    () => window.electronAPI.fleetWritingStyleSetDefault(machine, id),
    NOT_REACHED
  )
}

export function importClaudeOutputStyle(machine: string): Promise<string | null> {
  return write(
    machine,
    () => window.electronAPI.fleetWritingStyleImportClaude(machine),
    'The output style could not be imported.'
  )
}

// ── What the page offers ─────────────────────────────────────────────────────

/** The draft "Duplicate" opens: the style's fields under "{name} copy", with
 *  no id, so a save makes a new style. */
export function duplicateDraft(style: WritingStyle): WritingStyleDraft {
  return {
    name: `${style.name} copy`,
    description: style.description,
    text: style.text,
    statusCard: style.statusCard
  }
}

/** A style as the editor opens it, its id kept so a save rewrites it. */
export function draftOf(style: WritingStyle): WritingStyleDraft {
  return {
    id: style.id,
    name: style.name,
    description: style.description,
    text: style.text,
    statusCard: style.statusCard
  }
}

export const EMPTY_DRAFT: WritingStyleDraft = {
  name: '',
  description: '',
  text: '',
  statusCard: false
}

const SUPPORT_WORDS: Record<StyleSupport, string> = {
  instructions: 'in its instructions',
  'first-message': 'with the first message',
  none: 'not taken'
}

/** What a harness takes, in one line derived from `STYLE_SUPPORT`, never
 *  written per harness: once when a chat and a terminal agree, both when
 *  they differ. */
export function styleSupportLine(harness: Pick<Harness, 'id' | 'name'>): string {
  const support = STYLE_SUPPORT[harness.id]
  if (support.chat === support.terminal)
    return `${harness.name}: ${SUPPORT_WORDS[support.chat]}, in a chat and in a terminal.`
  return `${harness.name}: ${SUPPORT_WORDS[support.chat]} in a chat; ${SUPPORT_WORDS[support.terminal]} in a terminal.`
}
