import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReleaseNote } from '../../store/updater-store'

const remarkPlugins = [remarkGfm]

/**
 * A GitHub release body, rendered at sidebar scale.
 *
 * Not `MarkdownRenderer`: its `compact` variant is a panel surface — `p-5`,
 * `text-sm`, headings up to 20px with rules under them. Dropped into an 11px
 * announcement card it renders a document inside a banner. The bodies here are
 * a narrow, known shape (`### Added` / `### Fixed` headings over bullet lists,
 * with bold lead-ins), so this maps that shape and nothing else.
 *
 * Every element is capped at the card's own type scale, and headings are
 * rendered as small uppercase labels rather than as headings, because at this
 * size a heading and its body cannot differ by weight alone.
 */
const components = {
  // ### Added / ### Fixed — section labels, not headings, at this size.
  h1: ({ children }) => <ReleaseHeading>{children}</ReleaseHeading>,
  h2: ({ children }) => <ReleaseHeading>{children}</ReleaseHeading>,
  h3: ({ children }) => <ReleaseHeading>{children}</ReleaseHeading>,
  h4: ({ children }) => <ReleaseHeading>{children}</ReleaseHeading>,
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-1.5 last:mb-0 pl-3.5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-1.5 last:mb-0 pl-3.5 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="text-text-secondary">{children}</li>,
  // The lead-in of a release bullet ("**Codex usage panel** — ..."). It is the
  // scannable half of the line, so it takes the primary text colour.
  strong: ({ children }) => <strong className="font-medium text-text-primary">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del className="text-text-tertiary">{children}</del>,
  code: ({ children }) => (
    <code className="bg-surface-200/60 text-text-primary px-1 py-px rounded text-[0.9em] font-mono">
      {children}
    </code>
  ),
  // A fenced block inside a release note is rare and would blow the card's
  // width open; render it scrolling rather than wrapping.
  pre: ({ children }) => (
    <pre className="mb-1.5 last:mb-0 p-1.5 rounded-md bg-surface-200/50 overflow-x-auto">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/40 pl-2 my-1.5 text-text-tertiary">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-border-subtle" />,
  // Links open in the browser, never in the app: a release note points at
  // GitHub, and an Electron renderer must not navigate itself away.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline"
    >
      {children}
    </a>
  ),
  // Images are stripped. A release body may embed a screenshot; in a 240px
  // sidebar card it is noise, and it would be a network fetch besides.
  img: () => null
} as import('react-markdown').Components

function ReleaseHeading({ children }: { children?: React.ReactNode }): React.ReactElement {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary mt-2 first:mt-0 mb-1">
      {children}
    </p>
  )
}

/** Everything a release note may keep. Anything else loses its box. */
const ALLOWED_TAGS = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'P',
  'UL',
  'OL',
  'LI',
  'STRONG',
  'B',
  'EM',
  'I',
  'DEL',
  'S',
  'CODE',
  'PRE',
  'BLOCKQUOTE',
  'A',
  'BR',
  'HR'
])

/** Dropped WITH their content: none of it is text a reader wants, or may run. */
const DROPPED_WHOLE = new Set([
  'SCRIPT',
  'STYLE',
  'IMG',
  'SVG',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'NOSCRIPT',
  'TEXTAREA',
  'TEMPLATE'
])

const ALLOWED_ATTRIBUTES: Record<string, string[]> = { A: ['href', 'title'] }
const SAFE_HREF = /^(?:https?:|mailto:)/i

/**
 * The allowlist, applied where the markup is actually injected.
 *
 * The main process already sanitises release bodies with `sanitize-html`
 * (`normalizeReleaseBody`), and on the real path this pass finds nothing to do.
 * It exists anyway because THIS is the line that hands a string to the DOM:
 * a guard one process away protects the one caller it knows about, while a
 * guard here protects the operation. `DOMParser` builds an inert document —
 * no script runs, no image is fetched — so the scrub happens before anything
 * in the string can act.
 *
 * Unknown tags are unwrapped rather than dropped: GitHub wraps every body in a
 * `<div>`, and dropping it would take the note with it.
 */
function scrubReleaseHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  const scrub = (parent: Element): void => {
    for (const child of [...parent.children]) {
      scrub(child)

      if (DROPPED_WHOLE.has(child.tagName)) {
        child.remove()
        continue
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes)
        continue
      }

      const allowed = ALLOWED_ATTRIBUTES[child.tagName] ?? []
      for (const attr of [...child.attributes]) {
        if (!allowed.includes(attr.name.toLowerCase())) child.removeAttribute(attr.name)
      }
      if (child.tagName === 'A') {
        // A `javascript:` href loses the link and keeps the words; a real one
        // opens in the browser, never in the renderer — an Electron window must
        // not navigate itself away from the app.
        if (!SAFE_HREF.test(child.getAttribute('href') ?? '')) child.removeAttribute('href')
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noopener noreferrer')
      }
    }
  }

  scrub(doc.body)
  return doc.body.innerHTML
}

/**
 * One body, in whichever of the two shapes the provider sent.
 *
 * The HTML branch exists because GitHub's releases *feed* — the only changelog
 * an app has for a version it has not installed — serves each body already
 * rendered, so the Markdown pipeline printed `<h3>Added</h3> <ul> <li>…` at the
 * user as visible text.
 *
 * The two branches must look the same. The Markdown one is styled by the
 * component map above, the HTML one by `.release-note-html` in main.css —
 * change one and change the other.
 */
function ReleaseBody({ note }: { note: ReleaseNote }): React.ReactElement {
  const html = useMemo(
    () => (note.format === 'html' ? scrubReleaseHtml(note.note) : null),
    [note.format, note.note]
  )

  if (html !== null) {
    return <div className="release-note-html" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {note.note}
    </ReactMarkdown>
  )
}

/**
 * Every release between the version running and the one on offer, newest first.
 *
 * The version heading appears only when there is more than one — with a single
 * release it repeats the version already on the card's own line, and a heading
 * that restates its container is noise.
 */
export const ReleaseNotes = memo(function ReleaseNotes({
  notes
}: {
  notes: ReleaseNote[]
}): React.ReactElement {
  const multiple = notes.length > 1
  const rendered = useMemo(
    () =>
      notes.map((n) => (
        <div key={n.version} className="mb-2 last:mb-0">
          {multiple && (
            <p className="text-[11px] font-medium text-text-primary mb-1">v{n.version}</p>
          )}
          <ReleaseBody note={n} />
        </div>
      )),
    [notes, multiple]
  )

  return <div>{rendered}</div>
})
