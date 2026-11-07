import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { renderPage } from './html'
import type { ScopeView } from './ledger'
import { scopeParam, type Range, type Scope } from './scope'

/**
 * The decks: each page the plugin draws, written as a Slideless deck folder on disk under
 * `decks/` in the data folder, one folder per scope and range. A folder holds `index.html`
 * (the page, self-contained: the built stylesheet and script inlined, the scope's data in
 * its `slideless-data` block), `data.json` (the same view, for whoever reads the folder) and
 * `AGENT.md` (what the deck is, as Slideless templates carry). The Slideless CLI's own viewer
 * (`slideless dev`, see `viewer.ts`) serves the root on localhost and reloads a page when
 * its folder changes, so a deck is rewritten whenever its view changes, for every scope
 * opened in this process, and nothing leaves the Mac. The viewer's copy follows the ledger
 * live too, through the plugin's stream (the viewer's own reload stream is refused by the
 * sandbox it sends, an opaque origin with no CORS answer, so the plugin's routes answer any
 * origin instead). Slideless is the renderer here, never a destination: a folder is the
 * person's to push by hand if they ever want to.
 */

export const DECKS_DIR = 'decks'
export const INDEX_FILE = 'index.html'
export const DATA_FILE = 'data.json'
export const AGENT_FILE = 'AGENT.md'

const STYLE_LINK = '<link rel="stylesheet" href="{{base}}assets/deck.css" />'
const SCRIPT_TAG = '<script src="{{base}}assets/deck.js"></script>'

export type DeckFs = Pick<
  typeof nodeFs,
  'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'existsSync'
>

/** A scope key as a file or folder name; a long one is cut and tailed with its hash. */
export function fileKey(key: string): string {
  const plain = key.replace(/[^A-Za-z0-9._-]+/g, '-')
  if (plain.length <= 96) return plain
  return `${plain.slice(0, 80)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`
}

/** The deck folder of a scope and a range: `session-<id>` (a session has one range),
 *  `group-<id>-<range>`, `workspace-<ws>-<range>`. */
export function deckFolder(scope: Scope, range: Range): string {
  const key = fileKey(scopeParam(scope))
  return scope.kind === 'session' ? key : `${key}-${range}`
}

/** The deck's title: the page's name, then the plugin's. */
export function deckTitle(view: ScopeView): string {
  const name = view.name.trim() || 'Analytics'
  return `${name.length > 100 ? `${name.slice(0, 99)}…` : name} · Analytics`
}

export interface DeckInput {
  /** The page template, `page/index.html` as built into `dist/`. */
  template: string
  /** The built stylesheet, `dist/deck.css`: the fonts, the tokens, the page's rules. */
  css: string
  /** The built page script, `dist/deck.js`. */
  js: string
  data: ScopeView
  title: string
  /** The plugin server's token root, absolute: where the deck's links and its gear lead. */
  base: string
  /** The plugin server's stream for the scope, absolute: the deck follows the ledger live. */
  events: string
  /** The footer's last line on the deck. */
  note: string
}

/**
 * One self-contained HTML file from the page's parts: the stylesheet and the script inlined
 * in place of their links, the data in its block, the plugin server's stream for the scope
 * in `analytics-events` (absolute: the viewer's sandbox gives the page an opaque origin and
 * the plugin's read-only routes answer any origin), the page in `deck` mode with the plugin
 * server's root in `analytics-base` so its chips, its cards and its gear lead through the
 * plugin's open route. The theme is the system's in a browser and the app's inside Clave,
 * whose page pane injects its tokens into any page it shows. A `</style>` or a `</script>`
 * inside the inlined text is escaped so it cannot close its element early.
 */
export function assembleDeck(input: DeckInput): string {
  if (!input.template.includes(STYLE_LINK) || !input.template.includes(SCRIPT_TAG))
    throw new Error(
      'The page template changed: its stylesheet link or its script tag is not where the deck expects it'
    )
  const css = input.css.replace(/<\/style/gi, '<\\/style')
  const js = input.js.replace(/<\/script/gi, '<\\/script')
  const style = `<style>\n${css}\n</style>`
  const script = `<script>\n${js}\n</script>`
  // The placeholders are filled on the template alone, before the stylesheet and the script
  // go in: a `{{data}}` inside the built code is code, not a placeholder. The replacements
  // are functions, so a `$&` or a `$'` in the built code is text, not a pattern.
  const STYLE_AT = '\u0000analytics-style\u0000'
  const SCRIPT_AT = '\u0000analytics-script\u0000'
  const page = renderPage(
    input.template.replace(STYLE_LINK, () => STYLE_AT).replace(SCRIPT_TAG, () => SCRIPT_AT),
    {
      title: input.title,
      data: input.data,
      events: input.events,
      theme: 'dark',
      base: input.base,
      mode: 'deck',
      note: input.note
    }
  )
  return page.replace(STYLE_AT, () => style).replace(SCRIPT_AT, () => script)
}

/** The root's own page, the entry the viewer needs: it names what the folders are. */
export function rootIndex(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8" /><title>Clave · Analytics decks</title></head>',
    '<body>',
    '<p>The Analytics decks Clave writes on this Mac, one folder per page it opened: a session, a group or the workspace, each with its <code>index.html</code>, its <code>data.json</code> and its <code>AGENT.md</code>. Open a page from Clave: a tab’s or a group’s menu, or the toolbar’s home button.</p>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

export interface DeckWriterOptions {
  /** The plugin's data folder: the decks go under `decks/` in it. */
  dir: string
  /** Where the built page lives: `index.html`, `deck.css`, `deck.js`. */
  pageDir: string
  /** The shipped `AGENT.md` copied into every deck folder. */
  agentFile: string
  /** The view of a scope, or null when nothing is measured for it. */
  view: (scope: Scope, range: Range) => ScopeView | null
  /** The plugin server's token root, absolute. */
  base: string
  /** The footer's last line on the deck. */
  note: string
  fs?: DeckFs
  log?: (level: 'warn', message: string) => void
}

export interface WrittenDeck {
  /** The folder's name under `decks/`. */
  name: string
  /** The folder's absolute path. */
  folder: string
  title: string
}

/**
 * Writes the decks and keeps the set of scopes opened in this process. A deck is written
 * when its page is opened and again, on `rewrite`, whenever its view changed since the last
 * write; the set is reset at restart, so a folder of a scope nobody opened since is left as
 * it was. Each file is written whole, `index.html` last, so the viewer's reload (debounced
 * on its side) lands on a complete deck.
 */
export class DeckWriter {
  readonly root: string
  private readonly opened = new Map<string, { scope: Scope; range: Range }>()
  private readonly written = new Map<string, string>()
  private readonly fs: DeckFs
  private agentText: string | null = null

  constructor(private readonly options: DeckWriterOptions) {
    this.root = join(options.dir, DECKS_DIR)
    this.fs = options.fs ?? nodeFs
  }

  /** The root folder with its own page, written once: the viewer needs an entry to start. */
  ensureRoot(): void {
    this.fs.mkdirSync(this.root, { recursive: true })
    const index = join(this.root, INDEX_FILE)
    if (!this.fs.existsSync(index)) this.fs.writeFileSync(index, rootIndex())
  }

  /** The scopes opened in this process, by folder name. */
  get openedFolders(): string[] {
    return [...this.opened.keys()]
  }

  /** Writes the deck of a scope now and keeps the scope among the opened ones; null when
   *  nothing is measured for it (the folder is left untouched). */
  write(scope: Scope, range: Range): WrittenDeck | null {
    const view = this.options.view(scope, range)
    if (!view) return null
    const name = deckFolder(scope, range)
    this.opened.set(name, { scope, range })
    return this.put(name, scope, range, view)
  }

  /** Rewrites every opened deck whose view changed; the names rewritten. */
  rewrite(): string[] {
    const done: string[] = []
    for (const [name, { scope, range }] of this.opened) {
      let view: ScopeView | null
      try {
        view = this.options.view(scope, range)
      } catch (error) {
        this.options.log?.(
          'warn',
          `The deck ${name} could not be drawn: ${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }
      if (!view) continue
      const data = JSON.stringify(view)
      if (this.written.get(name) === data) continue
      this.put(name, scope, range, view, data)
      done.push(name)
    }
    return done
  }

  private put(
    name: string,
    scope: Scope,
    range: Range,
    view: ScopeView,
    data = JSON.stringify(view)
  ): WrittenDeck {
    const folder = join(this.root, name)
    this.fs.mkdirSync(folder, { recursive: true })
    const title = deckTitle(view)
    const html = assembleDeck({
      template: this.fs.readFileSync(join(this.options.pageDir, 'index.html'), 'utf8'),
      css: this.fs.readFileSync(join(this.options.pageDir, 'deck.css'), 'utf8'),
      js: this.fs.readFileSync(join(this.options.pageDir, 'deck.js'), 'utf8'),
      data: view,
      title,
      base: this.options.base,
      events: `${this.options.base}events?${new URLSearchParams({ scope: scopeParam(scope), range })}`,
      note: this.options.note
    })
    this.fs.writeFileSync(join(folder, AGENT_FILE), this.agent())
    this.fs.writeFileSync(join(folder, DATA_FILE), data)
    this.fs.writeFileSync(join(folder, INDEX_FILE), html)
    this.written.set(name, data)
    return { name, folder, title }
  }

  private agent(): string {
    if (this.agentText === null) {
      try {
        this.agentText = this.fs.readFileSync(this.options.agentFile, 'utf8')
      } catch {
        this.agentText = '# An Analytics deck written by Clave\n'
      }
    }
    return this.agentText
  }
}
