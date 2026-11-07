import { LAB_VIEW } from '../../../../../plugins/chat-view/src/lab/meta'

/* The walk's words and the few pure rules under it (Onboarding.tsx). */

/** The wording the reader may be told to look for: keep it as it is. */
export const SETUP_LINE_HINT = 'If someone gave you a setup line, paste it here'

export const FIRST_MESSAGE = `Hi! I just installed Clave, and this is my first session in it. Could you be my guide for a few minutes?

Start by telling me, in a few short sentences and without jargon, what you can do for me here. Then ask me what I would like to work on.

If anything needs to be installed or set up on this Mac along the way, tell me what it is and why, and ask me before you do it.`

export const CHAT_VIEWS = [
  {
    id: 'clave.chat-view/chat',
    title: 'Chat',
    tagline:
      'A conversation, like a messaging app: your messages on one side, the answers flowing in.',
    preview: 'chat'
  },
  {
    id: 'clave.chat-view/terminal',
    title: 'Enclave',
    tagline: 'Dense and calm, every step the assistant takes laid out in one column.',
    preview: 'enclave'
  },
  {
    id: 'clave.chat-view/lab',
    title: LAB_VIEW.title,
    tagline:
      'Each question gets a page of its own, written like a document. It can read the answer aloud.',
    preview: 'lab'
  }
] as const

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
