import type { FilesOperations } from '@clave/contract/files'
import type { Call } from './call'

/** Files at exactly one endpoint. No local fallback on failure. */
export type FilesClient = FilesOperations

export const filesClient = (call: Call): FilesClient => ({
  syncWatch: (payload) => call((c) => c.files.syncWatch({ payload })),
  listAll: (payload) => call((c) => c.files.listAll({ payload })),
  list: (payload) => call((c) => c.files.list({ payload })),
  read: (payload) => call((c) => c.files.read({ payload })),
  stat: (payload) => call((c) => c.files.stat({ payload })),
  write: (payload) => call((c) => c.files.write({ payload })).then(() => undefined),
  upload: (payload) => call((c) => c.files.upload({ payload })).then(() => undefined),
  download: (payload) => call((c) => c.files.download({ payload })),
  createFile: (payload) => call((c) => c.files.createFile({ payload })).then(() => undefined),
  createDirectory: (payload) =>
    call((c) => c.files.createDirectory({ payload })).then(() => undefined),
  prepareAttachment: (payload) => call((c) => c.files.prepareAttachment({ payload })),
  previewAttachment: (payload) => call((c) => c.files.previewAttachment({ payload }))
})
