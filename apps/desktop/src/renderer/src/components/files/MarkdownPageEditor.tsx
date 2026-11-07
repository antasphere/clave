import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  imagePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin
} from '@mdxeditor/editor'
import { MarkdownRenderer } from './MarkdownRenderer'
import { splitFrontmatter } from './file-types'

/** Languages offered in the code-block language picker. Anything else falls
 * back to plain-text editing while preserving the fence's language tag. */
const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  '': 'Plain text',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  md: 'Markdown',
  bash: 'Bash',
  sh: 'Shell',
  python: 'Python',
  yaml: 'YAML',
  sql: 'SQL',
  go: 'Go',
  rust: 'Rust'
}

const editorPlugins = [
  headingsPlugin(),
  listsPlugin(),
  quotePlugin(),
  thematicBreakPlugin(),
  linkPlugin(),
  linkDialogPlugin(),
  tablePlugin(),
  imagePlugin(),
  codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
  codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
  markdownShortcutPlugin()
]

/** Catches Lexical/parse crashes from markdown the editor can't represent and
 * reports up so the surface can fall back to the read-only page. */
class PageEditorErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(): void {
    this.props.onError()
  }

  render(): ReactNode {
    return this.state.hasError ? null : this.props.children
  }
}

interface MarkdownPageEditorProps {
  /** Full file buffer, frontmatter included. Read once at mount — the parent
   * must remount (key) when the underlying file changes. */
  content: string
  onChange: (value: string) => void
  onSave: () => void
  /** Put the caret in the document at mount — a file with nothing in it. */
  autoFocus?: boolean
}

/**
 * Notion-style editable document surface for markdown page mode. Renders the
 * file as a rich-text page that is directly editable: typing `# `, `- `, `> `
 * etc. converts blocks live, checkboxes toggle, code blocks edit inline with
 * CodeMirror. Edits serialize back to markdown into the shared file buffer,
 * so dirty state, Save and ⌘S behave exactly as in source mode. Frontmatter
 * is held out of the editor and reattached verbatim on every change.
 */
export function MarkdownPageEditor({
  content,
  onChange,
  onSave,
  autoFocus
}: MarkdownPageEditorProps): React.JSX.Element {
  // Frozen at mount: the editor owns the buffer from here on.
  const [initial] = useState(() => splitFrontmatter(content))
  const [parseError, setParseError] = useState(false)
  const failEditing = useCallback(() => setParseError(true), [])

  const handleChange = useCallback(
    (markdown: string, initialMarkdownNormalize: boolean) => {
      // The editor normalizes the document on mount (whitespace, bullet
      // symbols…); that is not a user edit and must not dirty the file.
      if (initialMarkdownNormalize) return
      const body = markdown === '' || markdown.endsWith('\n') ? markdown : `${markdown}\n`
      // Keep the conventional blank line between frontmatter and body.
      onChange(initial.prefix === '' ? body : `${initial.prefix}\n${body}`)
    },
    [onChange, initial.prefix]
  )

  // ⌘S anywhere inside the page, including nested CodeMirror code blocks
  // (which swallow keydown before it bubbles) — capture at the window and
  // scope by focus containment. FilePreview's own ⌘S listener checks
  // e.defaultPrevented, so this never double-saves.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.key !== 's') return
      if (!rootRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      onSave()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onSave])

  /** Focus the document and drop the caret at the end of it. */
  const placeCaret = useCallback((el: HTMLElement): void => {
    el.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  /** The page fills its pane and a click anywhere on it lands in the text: a
   *  short document is mostly margin, and a margin that swallows clicks reads
   *  as a document that cannot be edited. Clicks on the text itself pass
   *  through untouched — this only catches the empty page around it. So do
   *  clicks in MDXEditor's popups (a table row's menu, the link dialog): they
   *  portal to <body>, outside this element, but React bubbles their events
   *  up the component tree to here — and moving the caret to the end of the
   *  document under a "Delete this row" button is how that button did nothing. */
  const focusDocumentEnd = useCallback(
    (e: React.MouseEvent): void => {
      const el = rootRef.current?.querySelector<HTMLElement>('.markdown-page-content')
      const target = e.target as Node
      if (!el || el.contains(target) || !rootRef.current?.contains(target)) return
      e.preventDefault()
      placeCaret(el)
    },
    [placeCaret]
  )

  // An empty document opens with the caret in it. MDXEditor takes an autoFocus
  // prop and it does nothing here — the value is published into the realm and
  // nothing in the runtime reads it back — so the caret is placed by hand, on
  // the frame the editable appears (Lexical mounts it after this effect runs).
  useEffect(() => {
    if (!autoFocus) return
    let frames = 0
    let raf = 0
    const place = (): void => {
      const el = rootRef.current?.querySelector<HTMLElement>('.markdown-page-content')
      if (el) {
        placeCaret(el)
        return
      }
      if (frames++ < 30) raf = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [autoFocus, placeCaret])

  if (parseError) {
    return (
      <div>
        <div className="px-4 py-1.5 text-xs text-yellow-500 bg-yellow-500/5 border-b border-border-subtle">
          This document contains syntax the page editor cannot edit — showing read-only. Use Source
          to edit.
        </div>
        <MarkdownRenderer content={content} variant="page" frontmatter />
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      onMouseDown={focusDocumentEnd}
      className="markdown-page-editor w-full min-h-full px-10 py-12"
    >
      {initial.title && (
        <h1 className="text-[1.9rem] leading-tight tracking-tight font-semibold text-text-primary mb-4">
          {initial.title}
        </h1>
      )}
      <PageEditorErrorBoundary onError={failEditing}>
        <MDXEditor
          markdown={initial.body}
          onChange={handleChange}
          onError={failEditing}
          plugins={editorPlugins}
          contentEditableClassName="markdown-page-content"
          spellCheck={false}
          toMarkdownOptions={{ bullet: '-', rule: '-' }}
        />
      </PageEditorErrorBoundary>
    </div>
  )
}
