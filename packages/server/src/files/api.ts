import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import {
  CreateDirectory,
  CreateFile,
  DownloadFile,
  ListFiles,
  PrepareFileAttachment,
  PreviewFileAttachment,
  ReadFile,
  StatFile,
  UploadFile,
  WriteFile
} from '@clave/contract/files'

export const FilesLive = HttpApiBuilder.group(ClaveApi, 'files', (handlers) =>
  handlers
    .handle('list', HttpCqrs.query(ListFiles))
    .handle('read', HttpCqrs.query(ReadFile))
    .handle('stat', HttpCqrs.query(StatFile))
    .handle('download', HttpCqrs.query(DownloadFile))
    .handle('write', HttpCqrs.command(WriteFile))
    .handle('upload', HttpCqrs.command(UploadFile))
    .handle('createFile', HttpCqrs.command(CreateFile))
    .handle('createDirectory', HttpCqrs.command(CreateDirectory))
    .handle('prepareAttachment', HttpCqrs.command(PrepareFileAttachment))
    .handle('previewAttachment', HttpCqrs.query(PreviewFileAttachment))
)
