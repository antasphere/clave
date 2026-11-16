import type { LinkedUpdate } from '../../../shared/linked-documents'

/**
 * Whether an update of a linked document saves something, and so earns the
 * panel's Saving status. A read of the file from disk (`reloadExternal`)
 * saves nothing: the panel makes one each time its file changes, and one
 * more when its watch is set, so a status shown for them would flash at
 * every open.
 */
export const savesSomething = (input: LinkedUpdate): boolean => !input.reloadExternal
