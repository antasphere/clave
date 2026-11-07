import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  FilesSyncWatch,
  FilesListAll,
  CreateDirectory,
  CreateFile,
  DownloadFile,
  FileOperationFailed,
  ListFiles,
  PrepareFileAttachment,
  PreviewFileAttachment,
  ReadFile,
  StatFile,
  UploadFile,
  WriteFile
} from '@clave/contract/files'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { FilesPort } from './port'

const failure = (error: unknown): FileOperationFailed | CapabilityUnavailable => {
  if (error instanceof FileOperationFailed || error instanceof CapabilityUnavailable) return error
  // Paths and file contents from OS exceptions must not enter logs or responses.
  return new FileOperationFailed({ code: 'io', message: 'The file operation failed.' })
}
export const fileHandlers = [
  CommandHandler.make(FilesSyncWatch, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.syncWatch(input), catch: failure })
    )
  ),
  QueryHandler.make(FilesListAll, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.listAll(input), catch: failure })
    )
  ),
  QueryHandler.make(ListFiles, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.list(input), catch: failure })
    )
  ),
  QueryHandler.make(ReadFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.read(input), catch: failure })
    )
  ),
  QueryHandler.make(StatFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.stat(input), catch: failure })
    )
  ),
  QueryHandler.make(DownloadFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.download(input), catch: failure })
    )
  ),
  CommandHandler.make(WriteFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.write(input), catch: failure })
    )
  ),
  CommandHandler.make(UploadFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.upload(input), catch: failure })
    )
  ),
  CommandHandler.make(CreateFile, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.createFile(input), catch: failure })
    )
  ),
  CommandHandler.make(CreateDirectory, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.createDirectory(input), catch: failure })
    )
  ),
  CommandHandler.make(PrepareFileAttachment, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.prepareAttachment(input), catch: failure })
    )
  ),
  QueryHandler.make(PreviewFileAttachment, (input) =>
    Effect.flatMap(FilesPort, (files) =>
      Effect.tryPromise({ try: () => files.previewAttachment(input), catch: failure })
    )
  )
] as const
