import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'

let highlighter: Promise<HighlighterCore> | undefined

/** The desktop's grammars and GitHub colors, without its HTML or Wasm renderer.
 * Grammars compile only when their language is first shown. */
export async function highlightCode(
  code: string,
  language: string | null | undefined,
  theme: string
): Promise<ThemedToken[][] | null> {
  if (!language || !Object.hasOwn(bundledLanguages, language)) return null
  try {
    const h = await (highlighter ??= createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [],
      engine: createJavaScriptRegexEngine()
    }))
    await h.loadLanguage(bundledLanguages[language as BundledLanguage])
    return h.codeToTokens(code, {
      lang: language,
      theme: theme === 'light' || theme === 'coffee' ? 'github-light' : 'github-dark'
    }).tokens
  } catch {
    // A partial fence or unsupported grammar still displays its exact source.
    return null
  }
}
