import { INTERACTION_MODES, type InteractionMode } from '../../../../shared/harness'

/* The walk's words and the few pure rules under it (Onboarding.tsx). */

/** The wording the reader may be told to look for: keep it as it is. */
export const SETUP_LINE_HINT = 'If someone gave you a setup line, paste it here'

export const FIRST_MESSAGE = `Hi! I just installed Clave, and this is my first session in it. Could you be my guide for a few minutes?

Start by telling me, in a few short sentences and without jargon, what you can do for me here. Then ask me what I would like to work on.

If anything needs to be installed or set up on this Mac along the way, tell me what it is and why, and ask me before you do it.`

/** How each interaction mode is drawn in the walk's step. */
const PREVIEWS: Record<InteractionMode, 'chat' | 'enclave' | 'lab' | 'terminal'> = {
  chat: 'chat',
  enclave: 'enclave',
  folio: 'lab',
  terminal: 'terminal'
}

/**
 * The walk's choice of how a conversation opens: the interaction modes
 * (`shared/harness.ts`, PRDCT-4425), the three chat views then the terminal.
 * `id` is the chat view's id, or `terminal`; `mode` is what the walk writes.
 */
export const CHAT_VIEWS: readonly {
  id: string
  mode: InteractionMode
  title: string
  tagline: string
  preview: 'chat' | 'enclave' | 'lab' | 'terminal'
}[] = [
  ...INTERACTION_MODES.filter((mode) => mode.viewId !== null),
  ...INTERACTION_MODES.filter((mode) => mode.viewId === null)
].map((mode) => ({
  id: mode.viewId ?? 'terminal',
  mode: mode.id,
  title: mode.title,
  tagline: mode.tagline,
  preview: PREVIEWS[mode.id]
}))

/** The folder the walk will create, as the reader reads a path: under ~ when it is. */
export function folderPreview(home: string, parent: string, name: string): string {
  const clean = name
    .replace(/[/:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  const where =
    parent === home ? '~' : parent.startsWith(home + '/') ? '~' + parent.slice(home.length) : parent
  return `${where}/${clean || '…'}`
}

/** The folder name the walk makes, as main makes it (`folderNameOf` in
 *  `src/main/onboarding.ts`): one visible segment, or null when empty. */
export function folderName(name: string): string | null {
  const clean = name
    .replace(/[/:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return clean.length > 0 && clean.length <= 120 ? clean : null
}

/** The absolute path the walk will make, for the clash check before it does. */
export function folderTarget(parent: string, name: string): string | null {
  const folder = folderName(name)
  return folder ? `${parent.replace(/\/+$/, '')}/${folder}` : null
}
