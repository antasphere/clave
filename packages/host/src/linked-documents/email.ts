import { mapCssImages, rasterizeSvgData } from './signature-images'
import { readFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import sanitizeHtml from 'sanitize-html'
import { createHash } from 'crypto'

export const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex')

/** Reject unsupported markup explicitly: never strip a signature and silently send it. */
export function validateEmailHtml(html: string): void {
  let invalid = false
  sanitizeHtml(html, {
    allowedTags: [
      'p',
      'div',
      'br',
      'span',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'img',
      'table',
      'tbody',
      'thead',
      'tr',
      'td',
      'th',
      'hr'
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      a: ['href', 'title', 'target'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan']
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    exclusiveFilter(frame) {
      if (/(?:expression\s*\(|@import)/i.test(frame.attribs.style ?? '')) invalid = true
      return false
    },
    onOpenTag(tag, attrs) {
      const allowed = [
        'p',
        'div',
        'br',
        'span',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'a',
        'ul',
        'ol',
        'li',
        'blockquote',
        'h1',
        'h2',
        'h3',
        'img',
        'table',
        'tbody',
        'thead',
        'tr',
        'td',
        'th',
        'hr'
      ]
      if (
        !allowed.includes(tag) ||
        Object.keys(attrs).some(
          (k) =>
            ![
              'style',
              'class',
              'href',
              'title',
              'target',
              'colspan',
              'rowspan',
              'src',
              'alt',
              'width',
              'height',
              'align',
              'valign',
              'bgcolor',
              'border',
              'cellpadding',
              'cellspacing',
              'role',
              'data-spark-custom-html'
            ].includes(k)
        )
      )
        invalid = true
      if (
        tag === 'img' &&
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(attrs.src ?? '')
      )
        invalid = true
      if (tag === 'img') {
        const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
          attrs.src ?? ''
        )
        if (data) {
          try {
            if (rasterMediaType(Buffer.from(data[2], 'base64')) !== data[1]) invalid = true
          } catch {
            invalid = true
          }
        }
      }
      try {
        mapCssImages(attrs.style ?? '', (source) => {
          const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(source)
          if (!data || rasterMediaType(Buffer.from(data[2], 'base64')) !== data[1]) invalid = true
          return source
        })
      } catch {
        invalid = true
      }
      if (attrs.href && !/^(https?:|mailto:|tel:|#)/i.test(attrs.href)) invalid = true
      if (/(?:expression\s*\(|@import|\\)/i.test(attrs.style ?? '')) invalid = true
    }
  })
  if (invalid)
    throw new Error(
      'Unsupported email HTML: use text, links, tables and inline styles. Import image signatures from an HTML file to stage local/HTTPS assets. Scripts, style blocks and embedded content are unsupported.'
    )
}
/** Trust supported raster file signatures, not server MIME labels or filename extensions. */
export function rasterMediaType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (bytes.length >= 6 && /GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')))
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  throw new Error('Signature images must contain PNG, JPEG, GIF or WebP bytes')
}
/** Stage signature assets once; the preview, a restart and the agent's read all use these same bytes. */
export async function importSignature(
  file: string,
  request: typeof fetch = fetch
): Promise<string> {
  if (statSync(file).size > 500000) throw new Error('Signature exceeds 500 KB')
  const html = readFileSync(file, 'utf8')
  const sources = new Set<string>()
  sanitizeHtml(html, {
    onOpenTag(tag, attrs) {
      if (tag === 'img' && attrs.src) sources.add(attrs.src)
      mapCssImages(attrs.style ?? '', (source) => {
        sources.add(source)
        return source
      })
    }
  })
  const replacements = new Map<string, string>()
  let total = 0
  for (const source of sources) {
    if (/^data:image\/svg\+xml[;,]/i.test(source)) {
      const bytes = rasterizeSvgData(source)
      total += bytes.length
      replacements.set(source, `data:image/png;base64,${bytes.toString('base64')}`)
    } else if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(source)) {
      const bytes = Buffer.from(source.split(',')[1], 'base64')
      if (bytes.length > 2000000) throw new Error('Signature image exceeds 2 MB')
      total += bytes.length
      replacements.set(source, `data:${rasterMediaType(bytes)};base64,${bytes.toString('base64')}`)
    } else {
      let bytes: Buffer
      if (source.startsWith('https://')) {
        const response = await request(source, {
          signal: AbortSignal.timeout(15000),
          redirect: 'error'
        })
        if (!response.ok) throw new Error(`Signature image unavailable (HTTP ${response.status})`)
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Empty signature image')
        const chunks: Uint8Array[] = []
        let count = 0
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          count += part.value.length
          if (count > 2000000) {
            await reader.cancel()
            throw new Error('Signature image exceeds 2 MB')
          }
          chunks.push(part.value)
        }
        bytes = Buffer.concat(chunks)
      } else {
        if (/^[a-z]+:|^\/\//i.test(source))
          throw new Error('Signature image must be a local path, data image or HTTPS URL')
        const p = resolve(dirname(file), source)
        if (statSync(p).size > 2000000) throw new Error('Signature image exceeds 2 MB')
        bytes = readFileSync(p)
      }
      total += bytes.length
      replacements.set(source, `data:${rasterMediaType(bytes)};base64,${bytes.toString('base64')}`)
    }
    if (total > 3000000) throw new Error('Signature images exceed 3 MB total')
  }
  // Parser-based replacement handles quotes and entity-encoded URLs without regex HTML parsing.
  let invalid = false
  const staged = sanitizeHtml(html, {
    allowedTags: false,
    allowVulnerableTags: true, // Validation below rejects active content rather than silently dropping it.
    allowedAttributes: false,
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
    transformTags: {
      '*': (tag, attrs) => ({
        tagName: tag,
        attribs: {
          ...attrs,
          ...(tag === 'img' ? { src: replacements.get(attrs.src) ?? '' } : {}),
          ...(attrs.style
            ? { style: mapCssImages(attrs.style, (source) => replacements.get(source) ?? source) }
            : {})
        }
      })
    },
    onOpenTag(tag, attrs) {
      if (tag === 'script' || Object.keys(attrs).some((k) => k.startsWith('on'))) invalid = true
    }
  })
  if (invalid) throw new Error('Unsupported active content in signature')
  validateEmailHtml(staged)
  return staged
}
