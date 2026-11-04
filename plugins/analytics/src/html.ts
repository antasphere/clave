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
  /** The plugin server's token root: where the assets, the open route and the settings live.
   *  A path on the served page, an absolute URL on a deck. */
  base?: string
  /** `live` on the page the plugin serves (the stream on); `deck` on a deck the viewer
   *  serves (the stream off, every link through the open route). */
  mode?: PageMode
  /** The footer's last line: what serves the page, or why the viewer does not. */
  note?: string
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
 * (the `analytics-events` meta), `{{mode}}` (the `analytics-mode` meta), `{{base}}` (the
 * asset paths and the `analytics-base` meta), `{{note}}` (the `analytics-note` meta) and
 * `{{data}}` (inside the `slideless-data` JSON block).
 */
export function renderPage(template: string, options: PageOptions): string {
  const values: Record<string, string> = {
    title: escapeHtml(options.title),
    theme: options.theme,
    events: escapeHtml(options.events ?? ''),
    mode: options.mode ?? 'live',
    base: escapeHtml(options.base ?? '/'),
    note: escapeHtml(options.note ?? ''),
    data: jsonBlock(options.data)
  }
  return template.replace(
    /\{\{(title|theme|events|mode|base|note|data)\}\}/g,
    (_, key: string) => values[key]!
  )
}
