import { useEffect, useState } from 'react'
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type Highlighter,
  type BundledLanguage,
  type ThemedToken
} from 'shiki'
import type { ComponentPropsWithoutRef } from 'react'
let highlighter: Promise<Highlighter> | undefined
function getHighlighter(): Promise<Highlighter> {
  return (highlighter ??= createHighlighter({
    themes: [],
    langs: [],
    engine: createJavaScriptRegexEngine()
  }))
}
export function ChatCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'code'>): React.JSX.Element {
  const text = String(children ?? '')
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1]
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  useEffect(() => {
    let live = true
    const update = async (): Promise<void> => {
      if (!language) return
      const base = document.documentElement.dataset.theme
      const theme = base === 'light' || base === 'coffee' ? 'github-light' : 'github-dark'
      try {
        const highlighter = await getHighlighter()
        await highlighter.loadTheme(theme)
        // Unknown fence languages remain plain text.
        await highlighter.loadLanguage(language as Parameters<Highlighter['loadLanguage']>[0])
        const result = highlighter.codeToTokens(text, { lang: language as BundledLanguage, theme })
        if (live) setTokens(result.tokens)
      } catch {
        if (live) setTokens(null)
      }
    }
    void update()
    const observer = new MutationObserver(() => void update())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin']
    })
    return () => {
      live = false
      observer.disconnect()
    }
  }, [text, language])
  // Syntax colors are provided by the lazily loaded theme, never authored literals.
  return (
    <code {...props} className={className}>
      {tokens
        ? tokens.map((line, i) => (
            <span key={i}>
              {line.map((token, j) => (
                <span
                  key={j}
                  style={{ color: token.color }}
                  className={token.fontStyle ? 'chat-code-emphasis' : undefined}
                >
                  {token.content}
                </span>
              ))}
              {i < tokens.length - 1 ? '\n' : ''}
            </span>
          ))
        : children}
    </code>
  )
}
