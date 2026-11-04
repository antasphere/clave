/** The themes the page knows; anything else falls back to `dark`. */
export const THEMES = ['dark', 'light', 'coffee', 'charcoal'] as const
export type Theme = (typeof THEMES)[number]

export function pickTheme(value: string | null | undefined): Theme {
  return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : 'dark'
}

export type PageMode = 'live' | 'deck'

export interface PageOptions {
  title: string
  data: unknown
  /** The live-update URL; null renders a page that never updates. */
  events: string | null
  theme: Theme
  /** The path the page's assets are served under (the token's root). */
  base?: string
  /** `live` on the served page (the stream, the chips, the links, the footer's actions);
   *  `deck` on a published copy, a still that keeps its hover and nothing that leads away. */
  mode?: PageMode
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The data as a JSON block no `</script>` inside it can close. */
export function jsonBlock(data: unknown): string {
  return JSON.stringify(data ?? null)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '\\u003c!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Fills the page template: `{{title}}`, `{{theme}}` (on `<html data-theme>`), `{{events}}`
 * (the `analytics-events` meta), `{{mode}}` (the `analytics-mode` meta), `{{base}}` (asset
 * paths) and `{{data}}` (inside the `slideless-data` JSON block).
 */
export function renderPage(template: string, options: PageOptions): string {
  const values: Record<string, string> = {
    title: escapeHtml(options.title),
    theme: options.theme,
    events: escapeHtml(options.events ?? ''),
    mode: options.mode ?? 'live',
    base: escapeHtml(options.base ?? '/'),
    data: jsonBlock(options.data)
  }
  return template.replace(
    /\{\{(title|theme|events|mode|base|data)\}\}/g,
    (_, key: string) => values[key]!
  )
}
