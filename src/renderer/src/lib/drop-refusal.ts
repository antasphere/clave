import type { SavedServerConnection } from '@clave/contract/fleet'
import { droppedPathFallback, failureText } from './dropped-paths'
import { isRemoteKey } from './fleet-identity'

/* The refusal card (PRDCT-4329): what a drop on a server's tab leaves on this
   Mac, said above the composer rather than as a line in the conversation,
   which read as if nothing had happened. A folder always ends here (the
   transfer carries one file's bytes, and `readBounded` refuses a directory);
   so does a special file, a file too large to carry, one that cannot be read.
   This Mac's own tabs never get the card: a refused drop there keeps its
   path in the message. Everything here is pure; the composer's hook holds the
   state and the views draw it (`DropRefusal.tsx`). */

/** Why an item stayed: the words the card picks for it. */
export type RefusedKind = 'folder' | 'special' | 'large' | 'other'

export interface RefusedItem {
  name: string
  kind: RefusedKind
  /** The refusal as main or the server said it, for an `other`. */
  reason: string
}

/** The card's content: the items of one drop. `batch` numbers the drop, so a
 *  later drop that lands something takes an earlier drop's card away while
 *  the files of the same drop that did land leave it standing. */
export interface DropRefusalState {
  batch: number
  items: RefusedItem[]
}

export type DropRefusalAction =
  | { type: 'refused'; batch: number; item: RefusedItem }
  | { type: 'landed'; batch: number }
  | { type: 'dismissed' }

/** The kind of a refusal, from the words `readBounded` and the upload use
 *  (`packages/server/src/files/binary.ts`). */
export function refusedKind(reason: string): RefusedKind {
  if (/^Folders cannot be attached/i.test(reason)) return 'folder'
  if (/^Special files cannot be attached/i.test(reason)) return 'special'
  if (/too large/i.test(reason)) return 'large'
  return 'other'
}

/** A dropped path that could not be attached, as the card's item: only on a
 *  server's tab, and only for a path of THIS Mac. Null elsewhere: this Mac's
 *  tab keeps the path in the message, and another server's file is not on
 *  this Mac at all. */
export function refusedOnThisMac(
  sessionId: string,
  path: string,
  failure: unknown,
  name: string
): RefusedItem | null {
  if (isRemoteKey(path) || droppedPathFallback(sessionId, path) !== 'refuse') return null
  const reason = failureText(failure)
  return { name, kind: refusedKind(reason), reason }
}

export function reduceDropRefusal(
  state: DropRefusalState | null,
  action: DropRefusalAction
): DropRefusalState | null {
  switch (action.type) {
    case 'refused':
      // A new drop's refusal replaces the card; the same drop's adds to it.
      if (!state || action.batch > state.batch) return { batch: action.batch, items: [action.item] }
      return { batch: state.batch, items: [...state.items, action.item] }
    case 'landed':
      // A later drop or attach that landed: the card it followed goes.
      return state && action.batch > state.batch ? null : state
    case 'dismissed':
      return null
  }
}

/** The name the person gave the server the tab runs on. */
export function serverNameOf(
  connections: readonly SavedServerConnection[],
  serverId: string
): string {
  return connections.find((c) => c.id === serverId)?.name || 'a Clave server'
}

const FOLDERS = (server: string): string =>
  `This session runs on ${server}, which can't open the folders on your Mac. Drop files instead: they are copied to the server.`

/** Why one item stayed, in plain words, for a card about it alone. */
function oneReason(item: RefusedItem, server: string): string {
  switch (item.kind) {
    case 'folder':
      return FOLDERS(server)
    case 'special':
      return `This session runs on ${server}, and ${item.name} is not a regular file: a socket, a pipe or a device has no contents to copy there.`
    case 'large':
      return `This session runs on ${server}, and ${item.name} is too large to be copied there. Share it another way, or drop a smaller file.`
    case 'other':
      return `This session runs on ${server}, and ${item.name} could not be copied there: ${lowerFirst(item.reason.replace(/\.$/, ''))}.`
  }
}

/** Why each stayed, in a few words, for a card about several. */
function shortReason(kind: RefusedKind): string {
  switch (kind) {
    case 'folder':
      return 'a folder'
    case 'special':
      return 'not a regular file'
    case 'large':
      return 'too large'
    case 'other':
      return 'could not be read'
  }
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text
}

/** The card's title and its one sentence. */
export function dropRefusalWords(
  items: readonly RefusedItem[],
  server: string
): { title: string; sentence: string } {
  const folders = items.every((item) => item.kind === 'folder')
  if (folders)
    return {
      title:
        items.length > 1 ? `${items.length} folders stay on this Mac` : 'Folders stay on this Mac',
      sentence: FOLDERS(server)
    }
  if (items.length === 1)
    return { title: `${items[0].name} stayed on this Mac`, sentence: oneReason(items[0], server) }
  const anyFolder = items.some((item) => item.kind === 'folder')
  return {
    title: `${items.length} ${anyFolder ? 'items' : 'files'} stayed on this Mac`,
    sentence: `This session runs on ${server}, and these could not be copied there: ${items
      .map((item) => `${item.name} (${shortReason(item.kind)})`)
      .join(', ')}.`
  }
}
