import { Context, Layer } from 'effect'
import type { FilesOperations, FilesDirsChanged } from '@clave/contract/files'
import { CapabilityUnavailable } from '@clave/contract/errors'

/** Node operations with the same DTOs as the wire; each server supplies its
 * own storage. No attachment or filesystem state belongs to an Electron window. */
export interface FilesService extends FilesOperations {
  readonly onEvent: (listener: (event: FilesDirsChanged) => void) => () => void
  readonly dispose: () => void
}
const missing = async (): Promise<never> => {
  throw new CapabilityUnavailable({
    capability: 'files',
    message: 'This server has no file service.'
  })
}
export class FilesPort extends Context.Tag('@clave/server/Files')<FilesPort, FilesService>() {
  static layer(service: FilesService): Layer.Layer<FilesPort> {
    return Layer.succeed(FilesPort, service)
  }
  static readonly none: FilesService = {
    syncWatch: missing,
    listAll: missing,
    onEvent: () => () => {},
    dispose: () => {},
    list: missing,
    read: missing,
    stat: missing,
    write: missing,
    upload: missing,
    download: missing,
    createFile: missing,
    createDirectory: missing,
    prepareAttachment: missing,
    previewAttachment: missing
  }
}
