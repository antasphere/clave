import { useState, useEffect, useRef } from 'react'
import { type Highlighter } from 'shiki'
import { useSessionStore } from '../store/session-store'
import { isDarkTheme } from '../store/session-types'

let highlighterPromise: Promise<Highlighter> | null = null

const MAX_HIGHLIGHT_SIZE = 100_000 // 100KB

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  graphql: 'graphql',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  r: 'r'
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [
          'typescript',
          'tsx',
          'javascript',
          'jsx',
          'python',
          'rust',
          'go',
          'ruby',
          'java',
          'json',
          'yaml',
          'toml',
          'markdown',
          'html',
          'css',
          'scss',
          'sql',
          'shellscript',
          'xml',
          'c',
          'cpp'
        ]
      })
    )
  }
  return highlighterPromise
}

function getLang(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? 'text'
}

export function useSyntaxHighlight(
  content: string | null,
  filename: string
): { html: string | null; loading: boolean } {
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const theme = useSessionStore((s) => s.theme)
  const cancelRef = useRef(0)

  // What needs no highlighter is settled while rendering, against the inputs
  // the last render saw: no content, or a file too large to highlight. A file
  // that will be highlighted starts loading in the same render.
  const [seen, setSeen] = useState<{
    content: string | null
    filename: string
    theme: typeof theme
  } | null>(null)
  if (!seen || seen.content !== content || seen.filename !== filename || seen.theme !== theme) {
    setSeen({ content, filename, theme })
    if (!content) {
      setHtml(null)
    } else if (content.length > MAX_HIGHLIGHT_SIZE) {
      // Fall back to plain pre for large files
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      setHtml(`<pre style="margin:0;white-space:pre-wrap;">${escaped}</pre>`)
    } else {
      setLoading(true)
    }
  }

  useEffect(() => {
    if (!content || content.length > MAX_HIGHLIGHT_SIZE) return

    const id = ++cancelRef.current

    getHighlighter()
      .then((highlighter) => {
        if (id !== cancelRef.current) return

        const lang = getLang(filename)
        const loadedLangs = highlighter.getLoadedLanguages()

        const actualLang = loadedLangs.includes(lang) ? lang : 'text'
        const shikiTheme = isDarkTheme(theme) ? 'github-dark' : 'github-light'

        const result = highlighter.codeToHtml(content, {
          lang: actualLang,
          theme: shikiTheme
        })
        setHtml(result)
      })
      .catch(() => {
        if (id !== cancelRef.current) return
        const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        setHtml(`<pre style="margin:0;white-space:pre-wrap;">${escaped}</pre>`)
      })
      .finally(() => {
        if (id === cancelRef.current) setLoading(false)
      })
  }, [content, filename, theme])

  return { html, loading }
}
