/* What an attachment is, from its name: the media type a file is sent or
   listed under, and the FAMILY a chip draws and names it by. One table for
   the Mac's main process, a server's file service and the renderer's chips,
   so a video is a video on every side. Only names are read here, never
   bytes: an image's bytes are checked by whoever sends them. */

const MIME_BY_EXTENSION: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // video
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // audio and recordings
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
  // documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  pages: 'application/x-iwork-pages-sffpages',
  // sheets
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  numbers: 'application/x-iwork-numbers-sffnumbers',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  // slides
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  key: 'application/x-iwork-keynote-sffkey',
  // text
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  rst: 'text/x-rst',
  tex: 'text/x-tex',
  // code and data
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  sql: 'text/x-sql',
  lua: 'text/x-lua',
  // archives
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  dmg: 'application/x-apple-diskimage'
}

/** The media type a folder record carries: a folder is listed, never read. */
export const FOLDER_MIME_TYPE = 'inode/directory'

/** The media type a file's name says it is; a name without a known
 *  extension is a stream of bytes. Takes a bare name or a whole path. */
export function mimeTypeOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** The family a chip draws and names a record by. */
export type AttachmentFamily =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'code'
  | 'archive'
  | 'folder'
  | 'file'

const SHEETS = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/x-iwork-numbers-sffnumbers',
  'text/csv',
  'text/tab-separated-values'
])
const SLIDES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'application/x-iwork-keynote-sffkey'
])
const DOCUMENTS = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'application/x-iwork-pages-sffpages'
])
const ARCHIVES = new Set([
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-apple-diskimage'
])
const DATA = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'application/toml',
  'application/xml'
])
const PROSE = new Set(['text/plain', 'text/markdown', 'text/x-rst', 'text/x-tex'])

export function attachmentFamily(mimeType: string): AttachmentFamily {
  if (mimeType === FOLDER_MIME_TYPE) return 'folder'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (SHEETS.has(mimeType)) return 'sheet'
  if (SLIDES.has(mimeType)) return 'slides'
  if (DOCUMENTS.has(mimeType)) return 'document'
  if (ARCHIVES.has(mimeType)) return 'archive'
  if (DATA.has(mimeType)) return 'code'
  if (PROSE.has(mimeType)) return 'text'
  if (mimeType.startsWith('text/')) return 'code'
  return 'file'
}

/** The family's name on a chip. */
export const FAMILY_NAMES: Record<AttachmentFamily, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  document: 'Document',
  sheet: 'Sheet',
  slides: 'Slides',
  text: 'Text',
  code: 'Code',
  archive: 'Archive',
  folder: 'Folder',
  file: 'File'
}
