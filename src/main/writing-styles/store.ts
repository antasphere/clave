import fs from 'fs'
import os from 'os'
import path from 'path'
import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import {
  BUILT_IN_STYLES,
  NO_STYLE,
  WRITING_STYLE_LIMITS,
  checkStyleDraft,
  isReservedStyleId,
  styleIdFor,
  type WritingStyle,
  type WritingStylesView
} from '../../shared/writing-styles'
import { setWritingStylesSource, type WritingStylesSource } from './source'

/**
 * The writing styles of a machine (PRDCT-5166): the styles the person made
 * and the one a tab starts with. ONE document per machine, with one owner:
 * the process that holds the machine's settings, as the helpers' preference
 * is (`../helpers/preferences.ts`). The owner keeps it here, one JSON
 * document under its own settings ports (`writing-styles.json`), read at
 * every call so a spawn always sees the last write.
 *
 * Only the machine's own styles are stored: the built-in ones are Clave's
 * (`BUILT_IN_STYLES`), the same on every machine, so a release that rewords
 * one reaches everyone.
 */

export const WRITING_STYLES_FILE = 'writing-styles.json'

/** Where a document that does not parse is kept before a write over it. */
export const damagedStylesFile = (n: number): string => `writing-styles.damaged-${n}.json`

/** A machine's own style as it is stored: never a built-in. */
interface StoredStyle {
  id: string
  name: string
  description: string
  text: string
  statusCard: boolean
}

interface StoredDocument {
  version: 1
  defaultStyleId: string | null
  /** The machine's OWN styles only, in the order made. */
  styles: StoredStyle[]
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A stored style read back as far as it is well formed: a hand-edited or
 *  half-written file costs the bad entry, never the list. */
function readStyle(raw: unknown): StoredStyle | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID.test(r.id) || isReservedStyleId(r.id)) return null
  const checked = checkStyleDraft(r)
  if (!checked.ok) return null
  const { name, description, text, statusCard } = checked.draft
  return { id: r.id, name, description, text, statusCard }
}

/** The two keys of a markdown file's frontmatter this store reads, and the
 *  body after it. Parsed by hand: a line `key: value` between the `---`
 *  lines, the value's quotes dropped. */
function readMarkdown(source: string): { name?: string; description?: string; body: string } {
  const text = source.replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { body: text }
  const fields: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^(name|description)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    let value = pair[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1)
    if (value) fields[pair[1] as 'name' | 'description'] = value
  }
  return { ...fields, body: text.slice(match[0].length) }
}

/** The output style Claude Code is set to, when it is one of the person's
 *  own files: its name and that file's content. */
interface ClaudeOutputStyle {
  name: string
  description: string
  body: string
}

export interface WritingStylesStoreOptions {
  /** Claude Code's folder on this machine, where its settings and the
   *  person's output styles live. A test points it at a temp folder. */
  claudeHome?: () => string
}

export class WritingStylesStore implements WritingStylesSource {
  private readonly claudeHome: () => string

  constructor(
    private readonly ports: SettingsPorts = lazySettingsPorts,
    options: WritingStylesStoreOptions = {}
  ) {
    this.claudeHome = options.claudeHome ?? (() => path.join(os.homedir(), '.claude'))
  }

  private load(): StoredDocument {
    const raw = readJson(this.ports.storage, WRITING_STYLES_FILE)
    const r =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
    const styles: StoredStyle[] = []
    const ids = new Set<string>()
    const names = new Set(BUILT_IN_STYLES.map((style) => style.name.toLowerCase()))
    if (Array.isArray(r.styles))
      for (const entry of r.styles) {
        const style = readStyle(entry)
        // A second style of the same id or name is a damaged entry, as a
        // write could never have made it.
        if (!style || ids.has(style.id) || names.has(style.name.toLowerCase())) continue
        if (styles.length >= WRITING_STYLE_LIMITS.styles) break
        ids.add(style.id)
        names.add(style.name.toLowerCase())
        styles.push(style)
      }
    const defaultStyleId =
      typeof r.defaultStyleId === 'string' && r.defaultStyleId && r.defaultStyleId !== NO_STYLE
        ? r.defaultStyleId
        : null
    return { version: 1, defaultStyleId, styles }
  }

  private write(document: StoredDocument): WritingStylesView {
    this.setAsideDamaged()
    writeJson(this.ports.storage, WRITING_STYLES_FILE, document)
    return this.view()
  }

  /**
   * A document the read keeps less of than it holds reads as fewer styles
   * than the person made, and the next write would put a new document over
   * the rest. Its exact text is kept beside it first, as
   * `writing-styles.damaged-<n>.json`, the first number not taken. A missing
   * or an empty document holds nothing to lose.
   */
  private setAsideDamaged(): void {
    const storage = this.ports.storage
    const text = storage.read(WRITING_STYLES_FILE)
    if (text === null || text.trim() === '' || !this.readLoses(text)) return
    for (let n = 1; ; n++) {
      const name = damagedStylesFile(n)
      if (storage.read(name) !== null) continue
      storage.write(name, text)
      return
    }
  }

  /** Whether `load()` keeps less than the document holds: it does not parse
   *  (a hand edit that left a syntax error), it is not the object this store
   *  writes (a bare list of styles, `styles` keyed by id), or one of its
   *  styles is left out by the read (over the limits, a name already taken,
   *  a field of the wrong kind). Whatever the read discards, a write would
   *  erase for good. */
  private readLoses(text: string): boolean {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return true
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return true
    const styles = (raw as { styles?: unknown }).styles
    if (styles === undefined) return false
    if (!Array.isArray(styles)) return true
    return this.load().styles.length < styles.length
  }

  private allStyles(document: StoredDocument): WritingStyle[] {
    return [
      ...BUILT_IN_STYLES.map((style) => ({ ...style })),
      ...document.styles.map((style) => ({ ...style, builtIn: false }))
    ]
  }

  /** The output style Claude Code is set to on this machine, when it names
   *  one of the person's own files; null for none, `default`, one of Claude
   *  Code's built-in styles, or anything unreadable. Never a throw. */
  private claudeOutputStyle(): ClaudeOutputStyle | null {
    try {
      const home = this.claudeHome()
      const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf-8')) as {
        outputStyle?: unknown
      }
      const wanted = typeof settings?.outputStyle === 'string' ? settings.outputStyle.trim() : ''
      if (!wanted || wanted.toLowerCase() === 'default') return null
      const folder = path.join(home, 'output-styles')
      for (const file of fs.readdirSync(folder).sort()) {
        if (!file.toLowerCase().endsWith('.md')) continue
        let content: string
        try {
          content = fs.readFileSync(path.join(folder, file), 'utf-8')
        } catch {
          continue
        }
        const parsed = readMarkdown(content)
        const name = parsed.name ?? path.basename(file, path.extname(file))
        if (name.toLowerCase() !== wanted.toLowerCase()) continue
        return { name, description: parsed.description ?? '', body: parsed.body.trim() }
      }
      return null
    } catch {
      return null
    }
  }

  /** The machine's styles, its default and Claude Code's output style. */
  view(): WritingStylesView {
    const document = this.load()
    const styles = this.allStyles(document)
    const defaultStyleId =
      document.defaultStyleId && styles.some((style) => style.id === document.defaultStyleId)
        ? document.defaultStyleId
        : null
    const claude = this.claudeOutputStyle()
    return { styles, defaultStyleId, claudeOutputStyle: claude ? { name: claude.name } : null }
  }

  /** Make a style (a draft with no id) or rewrite one of the machine's own
   *  (its id unchanged whatever the new name), and answer the view. A
   *  refusal is a plain `Error` whose message is a sentence for the person
   *  (the settings handlers' refusal). */
  save(raw: unknown): WritingStylesView {
    const checked = checkStyleDraft(raw)
    if (!checked.ok) throw new Error(checked.reason)
    const draft = checked.draft
    const document = this.load()
    if (draft.id !== undefined) {
      if (BUILT_IN_STYLES.some((style) => style.id === draft.id))
        throw new Error('The built-in styles cannot be changed: duplicate one to make your own.')
      if (!document.styles.some((style) => style.id === draft.id))
        throw new Error('This style no longer exists.')
    }
    const clash = this.allStyles(document).find(
      (style) => style.id !== draft.id && style.name.toLowerCase() === draft.name.toLowerCase()
    )
    if (clash) throw new Error(`Another style is already named "${clash.name}".`)
    const fields = {
      name: draft.name,
      description: draft.description,
      text: draft.text,
      statusCard: draft.statusCard
    }
    if (draft.id !== undefined) {
      const id = draft.id
      document.styles = document.styles.map((style) =>
        style.id === id ? { id, ...fields } : style
      )
    } else {
      if (document.styles.length >= WRITING_STYLE_LIMITS.styles)
        throw new Error(
          `This machine keeps at most ${WRITING_STYLE_LIMITS.styles} styles of its own: delete one first.`
        )
      const taken = new Set(document.styles.map((style) => style.id))
      document.styles.push({ id: styleIdFor(draft.name, taken), ...fields })
    }
    return this.write(document)
  }

  /** Delete one of the machine's own styles; the default is cleared when
   *  it was that one. */
  remove(id: string): WritingStylesView {
    if (BUILT_IN_STYLES.some((style) => style.id === id))
      throw new Error('The built-in styles cannot be deleted.')
    const document = this.load()
    if (!document.styles.some((style) => style.id === id))
      throw new Error('This style no longer exists.')
    document.styles = document.styles.filter((style) => style.id !== id)
    if (document.defaultStyleId === id) document.defaultStyleId = null
    return this.write(document)
  }

  /** The style a tab starts with when its launch names none; null or
   *  `none` is no style. */
  setDefault(id: string | null): WritingStylesView {
    const document = this.load()
    if (id === null || id === NO_STYLE) document.defaultStyleId = null
    else if (typeof id === 'string' && this.allStyles(document).some((style) => style.id === id))
      document.defaultStyleId = id
    else throw new Error('This style no longer exists.')
    return this.write(document)
  }

  /** Save the output style Claude Code is set to on this machine as a style
   *  of the machine's own. */
  importClaudeOutputStyle(): WritingStylesView {
    const claude = this.claudeOutputStyle()
    if (!claude) throw new Error('Claude Code has no output style of yours to import.')
    if (claude.body.length > WRITING_STYLE_LIMITS.text)
      throw new Error(
        `Claude Code's output style is over ${WRITING_STYLE_LIMITS.text} characters: too long for a style.`
      )
    return this.save({
      name: claude.name,
      description: claude.description.slice(0, WRITING_STYLE_LIMITS.description),
      text: claude.body,
      statusCard: false
    })
  }
}

/** This process's store, on its own settings ports. */
export const writingStylesStore = new WritingStylesStore()

/** The entry's one call: a spawn and the agent tools read this machine's
 *  styles from now on. The owner makes it at boot: the standalone server,
 *  and main only when the server runs inside it. */
export function installWritingStyles(store: WritingStylesSource = writingStylesStore): void {
  setWritingStylesSource(store)
}
