/** General files belong to the endpoint receiving the call. Paths are always
 * server-local. A bearer grants the same filesystem authority as that server's
 * user; `root` additionally bounds each operation, including symlinks. */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

export const MAX_TRANSFER_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_BYTES = 1024 * 1024
export const MAX_PREVIEW_BYTES = 16 * 1024
export const MAX_FILE_ENTRIES = 5000
export const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_TRANSFER_BYTES / 3)
const Path = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.pattern(/^[^\0]+$/)
)
const Name = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(/^[^/\\\0]+$/)
)
export const FileLocation = Schema.Struct({ root: Path, path: Path })
export type FileLocation = typeof FileLocation.Type
const Base64 = Schema.String.pipe(Schema.maxLength(MAX_BASE64_LENGTH))
export const FileEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literal('file', 'directory'),
  size: Schema.Number
})
export type FileEntry = typeof FileEntry.Type
export const FileListing = Schema.Struct({
  entries: Schema.Array(FileEntry),
  truncated: Schema.Boolean
})
export type FileListing = typeof FileListing.Type
export const FileInfo = Schema.Struct({
  type: Schema.Literal('file', 'directory'),
  size: Schema.Number,
  modified: Schema.Number
})
export type FileInfo = typeof FileInfo.Type
export const FileText = Schema.Struct({
  content: Schema.String,
  truncated: Schema.Boolean,
  size: Schema.Number,
  binary: Schema.Boolean
})
export type FileText = typeof FileText.Type
export const FileDownload = Schema.Struct({ name: Name, base64: Base64, size: Schema.Number })
export type FileDownload = typeof FileDownload.Type
export const FileAttachment = Schema.Struct({
  id: Schema.String,
  path: Path,
  name: Name,
  mimeType: Schema.String,
  size: Schema.Number,
  delivery: Schema.Literal('image', 'reference')
})
export type FileAttachment = typeof FileAttachment.Type
export const FilePreview = Schema.Struct({
  image: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  notice: Schema.optional(Schema.String)
})
export type FilePreview = typeof FilePreview.Type
export const AttachmentSource = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('file'), root: Path, path: Path }),
  Schema.Struct({
    kind: Schema.Literal('upload'),
    name: Name,
    base64: Base64,
    image: Schema.Boolean
  })
)
export type AttachmentSource = typeof AttachmentSource.Type
export const PrepareFileAttachmentInput = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,128}$/)),
  source: AttachmentSource
})
export type PrepareFileAttachmentInput = typeof PrepareFileAttachmentInput.Type
export const PreviewFileAttachmentInput = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,128}$/)),
  path: Path,
  root: Schema.optional(Path)
})
export type PreviewFileAttachmentInput = typeof PreviewFileAttachmentInput.Type
export const WriteFileInput = Schema.Struct({
  ...FileLocation.fields,
  content: Schema.String.pipe(Schema.maxLength(MAX_TEXT_BYTES))
})
export type WriteFileInput = typeof WriteFileInput.Type
export const UploadFileInput = Schema.Struct({ ...FileLocation.fields, base64: Base64 })
export type UploadFileInput = typeof UploadFileInput.Type

export class FileOperationFailed extends Schema.TaggedError<FileOperationFailed>()(
  'FileOperationFailed',
  {
    code: Schema.Literal(
      'invalid_path',
      'too_large',
      'not_found',
      'invalid_data',
      'not_file',
      'io'
    ),
    message: Schema.String
  }
) {}
const Failure = Schema.Union(FileOperationFailed, CapabilityUnavailable)
export const ListFiles = Query.define('ListFiles', {
  payload: FileLocation,
  success: FileListing,
  failure: Failure
})
export const ReadFile = Query.define('ReadFile', {
  payload: FileLocation,
  success: FileText,
  failure: Failure
})
export const StatFile = Query.define('StatFile', {
  payload: FileLocation,
  success: FileInfo,
  failure: Failure
})
export const DownloadFile = Query.define('DownloadFile', {
  payload: FileLocation,
  success: FileDownload,
  failure: Failure
})
export const WriteFile = Command.define('WriteFile', {
  payload: WriteFileInput,
  success: Schema.Void,
  failure: Failure
})
export const UploadFile = Command.define('UploadFile', {
  payload: UploadFileInput,
  success: Schema.Void,
  failure: Failure
})
export const CreateFile = Command.define('CreateFile', {
  payload: FileLocation,
  success: Schema.Void,
  failure: Failure
})
export const CreateDirectory = Command.define('CreateDirectory', {
  payload: FileLocation,
  success: Schema.Void,
  failure: Failure
})
export const PrepareFileAttachment = Command.define('PrepareFileAttachment', {
  payload: PrepareFileAttachmentInput,
  success: FileAttachment,
  failure: Failure
})
export const PreviewFileAttachment = Query.define('PreviewFileAttachment', {
  payload: PreviewFileAttachmentInput,
  success: FilePreview,
  failure: Failure
})

export const filesGroup = ApiGroup.make('files')
  .add(HttpCqrs.queryEndpoint('list', '/files/list', ListFiles))
  .add(HttpCqrs.queryEndpoint('read', '/files/read', ReadFile))
  .add(HttpCqrs.queryEndpoint('stat', '/files/stat', StatFile))
  .add(HttpCqrs.queryEndpoint('download', '/files/download', DownloadFile))
  .add(HttpCqrs.commandEndpoint('write', '/files/write', WriteFile))
  .add(HttpCqrs.commandEndpoint('upload', '/files/upload', UploadFile))
  .add(HttpCqrs.commandEndpoint('createFile', '/files/create', CreateFile))
  .add(HttpCqrs.commandEndpoint('createDirectory', '/files/mkdir', CreateDirectory))
  .add(
    HttpCqrs.commandEndpoint(
      'prepareAttachment',
      '/files/attachments/prepare',
      PrepareFileAttachment
    )
  )
  .add(
    HttpCqrs.queryEndpoint('previewAttachment', '/files/attachments/preview', PreviewFileAttachment)
  )

/** The promise-facing port and client share DTOs, independently of transport. */
export interface FilesOperations {
  readonly list: (input: FileLocation) => Promise<FileListing>
  readonly read: (input: FileLocation) => Promise<FileText>
  readonly stat: (input: FileLocation) => Promise<FileInfo>
  readonly write: (input: WriteFileInput) => Promise<void>
  readonly upload: (input: UploadFileInput) => Promise<void>
  readonly download: (input: FileLocation) => Promise<FileDownload>
  readonly createFile: (input: FileLocation) => Promise<void>
  readonly createDirectory: (input: FileLocation) => Promise<void>
  readonly prepareAttachment: (input: PrepareFileAttachmentInput) => Promise<FileAttachment>
  readonly previewAttachment: (input: PreviewFileAttachmentInput) => Promise<FilePreview>
}
