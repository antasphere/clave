/**
 * What a photo, a screenshot or a file is on its way into a message
 * (decision 11 of the spec), and the limits the beta sends under: the
 * desktop chat's (`src/shared/attachments.ts`: ten records per message,
 * images of 5 MiB at most and 20 MiB together) and the files route's
 * (`packages/contract/src/files.ts`, `MAX_TRANSFER_BYTES`: an upload of
 * 5 MiB at most). What the beta cannot send is said with a sentence, never
 * dropped in silence.
 */
export const MAX_ATTACHMENTS = 10
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
/** The files route's own limit on one upload. */
export const MAX_TRANSFER_BYTES = 5 * 1024 * 1024
/** The formats a provider takes as image content; anything else travels as a file. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type PickedKind = 'image' | 'video' | 'file'

/** A file the platform's picker handed over, before anything is read. */
export interface PickedFile {
  readonly uri: string
  readonly name: string
  readonly mimeType: string
  /** Bytes, when the picker knew; null when it did not. */
  readonly size: number | null
  readonly kind: PickedKind
}

/** The media type a file's name says it is: the extensions the pickers
 *  hand over most, the server re-types every upload by name anyway
 *  (`packages/server/src/files/service.ts`). */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip'
}

export function mimeTypeOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export const kindOf = (mimeType: string): PickedKind =>
  mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file'
