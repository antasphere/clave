/** Display modes for file surfaces. Markdown uses page (document-style,
 *  default) / preview (compact) / source; HTML uses rendered (live page,
 *  default) / source. */
export type FileViewMode = 'page' | 'preview' | 'source' | 'rendered'

export const MARKDOWN_MODES: FileViewMode[] = ['page', 'preview', 'source']
export const HTML_MODES: FileViewMode[] = ['rendered', 'source']

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
export const MARKDOWN_EXTS = new Set(['md', 'mdx'])
export const HTML_EXTS = new Set(['html', 'htm'])
export const EXTERNAL_EXTS = new Set([
  'html',
  'htm',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp'
])

export function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

export function isImageFile(filename: string): boolean {
  return IMAGE_EXTS.has(extOf(filename))
}

export function isMarkdownFile(filename: string): boolean {
  return MARKDOWN_EXTS.has(extOf(filename))
}

export function isHtmlFile(filename: string): boolean {
  return HTML_EXTS.has(extOf(filename))
}

export function canOpenExternally(filename: string): boolean {
  return EXTERNAL_EXTS.has(extOf(filename))
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

/** Leading YAML frontmatter renders as noise; on file surfaces strip it and
 * surface its title (if any) as the document title. The raw `prefix` is kept
 * so editing surfaces can reattach it verbatim when writing back. */
export function splitFrontmatter(content: string): {
  prefix: string
  body: string
  title: string | null
} {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content)
  if (!match) return { prefix: '', body: content, title: null }
  const titleMatch = /^title:\s*(.+)$/m.exec(match[1])
  const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : null
  return { prefix: match[0], body: content.slice(match[0].length), title }
}
