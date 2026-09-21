import { memo, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useSyntaxHighlight } from '../../hooks/use-syntax-highlight'
import { handleClaveLink } from '../../lib/navigation'
import { splitFrontmatter } from './file-types'

/** 'compact' is the dense preview used in panels and chat; 'page' renders a
 * document-style reading column with generous type and margins. */
export type MarkdownVariant = 'compact' | 'page'

function urlTransform(url: string): string {
  if (url.startsWith('clave://')) return url
  return defaultUrlTransform(url)
}

const CodeBlock = memo(function CodeBlock({
  lang,
  code,
  textClass
}: {
  lang: string
  code: string
  textClass: string
}) {
  const filename = lang ? `file.${lang}` : 'file.txt'
  const { html } = useSyntaxHighlight(code, filename)

  if (!html) {
    return (
      <pre className="rounded-lg bg-surface-200/50 p-3 overflow-x-auto">
        <code className={`${textClass} font-mono`}>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className={`rounded-lg bg-surface-200/50 p-3 overflow-x-auto [&_pre]:!bg-transparent [&_code]:!bg-transparent ${textClass}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

const remarkPlugins = [remarkGfm]

/** Per-variant style maps. 'compact' must stay exactly what panels and chat render today. */
const STYLES = {
  compact: {
    wrapper: 'p-5 prose-preview text-sm leading-relaxed text-text-primary',
    h1: 'text-xl font-bold text-text-primary mt-6 mb-3 first:mt-0 pb-2 border-b border-border-subtle',
    h2: 'text-lg font-semibold text-text-primary mt-5 mb-2 first:mt-0 pb-1.5 border-b border-border-subtle',
    h3: 'text-base font-semibold text-text-primary mt-4 mb-2 first:mt-0',
    h4: 'text-sm font-semibold text-text-primary mt-3 mb-1.5 first:mt-0',
    p: 'mb-3 last:mb-0',
    ul: 'mb-3 pl-5 list-disc space-y-1',
    ol: 'mb-3 pl-5 list-decimal space-y-1',
    blockquote: 'border-l-3 border-accent/40 pl-4 my-3 text-text-secondary italic',
    codeText: 'text-xs',
    tableWrap: 'overflow-x-auto mb-3',
    table: 'w-full text-xs border-collapse',
    hr: 'my-4 border-border-subtle',
    img: 'max-w-full rounded my-3'
  },
  page: {
    wrapper: 'markdown-page w-full px-10 py-12 text-[15px] leading-7 text-text-primary',
    h1: 'text-[1.9rem] leading-tight tracking-tight font-semibold text-text-primary mt-10 mb-4 first:mt-0',
    h2: 'text-[1.35rem] tracking-tight font-semibold text-text-primary mt-8 mb-3 first:mt-0',
    h3: 'text-lg font-semibold text-text-primary mt-6 mb-2 first:mt-0',
    h4: 'text-base font-semibold text-text-primary mt-5 mb-2 first:mt-0',
    p: 'mb-4 last:mb-0',
    ul: 'mb-4 pl-6 list-disc space-y-1.5',
    ol: 'mb-4 pl-6 list-decimal space-y-1.5',
    blockquote: 'border-l-3 border-accent/40 pl-4 my-4 text-text-secondary italic',
    codeText: 'text-control',
    tableWrap: 'overflow-x-auto mb-4',
    table: 'w-full text-sm border-collapse',
    hr: 'my-8 border-border-subtle',
    img: 'max-w-full rounded-lg my-4'
  }
} as const

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  variant = 'compact',
  frontmatter = false
}: {
  content: string
  variant?: MarkdownVariant
  /** Strip leading YAML frontmatter and surface its title. On for file surfaces, off for chat/help content. */
  frontmatter?: boolean
}) {
  const s = STYLES[variant]

  const { body, title } = useMemo(
    () => (frontmatter ? splitFrontmatter(content) : { body: content, title: null }),
    [content, frontmatter]
  )

  const components = useMemo(
    () =>
      ({
        h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
        h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
        h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
        h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
        p: ({ children }) => <p className={s.p}>{children}</p>,
        a: ({ href, children }) => {
          const isClaveLink = href?.startsWith('clave://')
          return (
            <a
              href={isClaveLink ? undefined : href}
              className="text-accent hover:underline cursor-pointer"
              onClick={(e) => {
                if (href && handleClaveLink(href)) {
                  e.preventDefault()
                }
              }}
              target={isClaveLink ? undefined : '_blank'}
              rel={isClaveLink ? undefined : 'noopener noreferrer'}
            >
              {children}
            </a>
          )
        },
        ul: ({ children }) => <ul className={s.ul}>{children}</ul>,
        ol: ({ children }) => <ol className={s.ol}>{children}</ol>,
        li: ({ children }) => <li className="text-text-primary">{children}</li>,
        blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
        code: ({ className, children }) => {
          const match = /language-(\w+)/.exec(className || '')
          const code = String(children).replace(/\n$/, '')

          if (match || code.includes('\n')) {
            return <CodeBlock lang={match?.[1] ?? ''} code={code} textClass={s.codeText} />
          }

          return (
            <code className="bg-surface-200/60 text-text-primary px-1.5 py-0.5 rounded text-[0.85em] font-mono">
              {children}
            </code>
          )
        },
        pre: ({ children }) => <>{children}</>,
        table: ({ children }) => (
          <div className={s.tableWrap}>
            <table className={s.table}>{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
        th: ({ children }) => (
          <th className="text-left px-3 py-1.5 font-semibold text-text-secondary">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-1.5 border-b border-border-subtle">{children}</td>
        ),
        hr: () => <hr className={s.hr} />,
        img: ({ src, alt }) => <img src={src} alt={alt ?? ''} className={s.img} />,
        input: ({ checked, ...props }) => (
          <input
            {...props}
            checked={checked}
            disabled
            className="mr-1.5 accent-accent"
            type="checkbox"
          />
        ),
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        del: ({ children }) => <del className="text-text-tertiary">{children}</del>
      }) as import('react-markdown').Components,
    [s]
  )

  return (
    <div className={s.wrapper}>
      {title && <h1 className={s.h1}>{title}</h1>}
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
})
