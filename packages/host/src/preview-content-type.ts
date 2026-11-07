/**
 * The Content-Type a `clave-preview://` response carries — the MIME type for
 * the file's extension, and for text types the charset Clave defaults to.
 *
 * Without a charset anywhere, Chromium renders an HTML file as windows-1252,
 * and every multi-byte UTF-8 sequence becomes mojibake (“ → â€œ). The
 * claude.ai artifact host never shows this because it wraps every page in a
 * head that declares UTF-8; Clave serves the raw file, so the default is ours
 * to set, and it is set HERE, in the header, never by touching the file.
 *
 * The default is guarded so it can never make a file that renders correctly
 * today render worse. The transport charset beats the page's own declaration
 * in every browser, so Clave only speaks when the file has not:
 *   1. the file declares its encoding (a BOM, `<meta charset>`, `@charset`,
 *      or an XML declaration) → bare MIME, the declaration stands;
 *   2. it declares nothing and its bytes are valid UTF-8 → `charset=utf-8`;
 *   3. it declares nothing and the bytes are NOT valid UTF-8 → bare MIME, the
 *      fallback that renders it today is left alone.
 * Pure logic, no Electron import, so the unit tests cover it directly.
 */

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  wasm: 'application/wasm'
}

/** Extensions whose bytes are text a browser decodes with a charset. */
const TEXT_EXTS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'json',
  'svg',
  'txt',
  'md',
  'csv',
  'xml',
  'webmanifest',
  'map'
])

/** How far into the file an encoding declaration is looked for. The HTML
 *  prescan itself stops at 1024 bytes, so nothing later counts anyway. */
const SCAN_BYTES = 1024

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })

function hasByteOrderMark(data: Buffer): boolean {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return true
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return true
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return true
  return false
}

/** Whether the file states its own encoding, in the form its type uses. */
export function declaresEncoding(ext: string, data: Buffer): boolean {
  if (hasByteOrderMark(data)) return true
  // latin1 maps bytes 1:1, so the scan cannot itself throw on a bad sequence.
  const head = data.subarray(0, SCAN_BYTES).toString('latin1')
  switch (ext) {
    case 'html':
    case 'htm':
      // `<meta charset="x">` and `<meta http-equiv="Content-Type" content="…; charset=x">`.
      return /<meta\b[^>]*charset\s*=/i.test(head)
    case 'css':
      return /^\s*@charset\s+"/.test(head)
    case 'svg':
    case 'xml':
      return /<\?xml\b[^>]*\bencoding\s*=/i.test(head)
    default:
      return false
  }
}

export function isValidUtf8(data: Buffer): boolean {
  try {
    UTF8_STRICT.decode(data)
    return true
  } catch {
    return false
  }
}

/** The Content-Type header value for a preview file of extension `ext`. */
export function previewContentType(ext: string, data: Buffer): string {
  const mime = MIME_BY_EXT[ext]
  if (!mime) return 'application/octet-stream'
  if (!TEXT_EXTS.has(ext)) return mime
  if (declaresEncoding(ext, data)) return mime
  if (!isValidUtf8(data)) return mime
  return `${mime}; charset=utf-8`
}
