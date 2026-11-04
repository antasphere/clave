import { execFile } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { delimiter, join } from 'node:path'
import { renderPage, type Theme } from './html'
import type { PublishedDeck, Range, ScopeView, ViewRow } from './ledger'

/**
 * Publish: the page the plugin serves, as a deck of its own on Slideless, pushed with the
 * person's own CLI on their own login. The deck is one self-contained HTML file: the page's
 * template with its stylesheet and its script inlined, the scope's data in its
 * `slideless-data` block, the theme fixed at publish time (the page's live token values
 * written after the stylesheet), its live stream off. Nothing is pushed into anyone's
 * workspace templates and no data-bound document is made. The data pushed is the scope's
 * aggregated view, the session names and folders redacted unless asked for; never a prompt,
 * never a transcript line (a view never holds one). What was pushed is kept beside the
 * ledger, `published/<scope>-<n>.json`, the way the WAT report kept its usage file.
 */

export type CliResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; missing: boolean; code: number | null; stderr: string }
export type CliRunner = (args: string[]) => Promise<CliResult>

export interface PublishRequest {
  /** The scope key, `session:<id>`, `group:<id>` or `workspace:<ws|->`. */
  key: string
  range: Range
  /** Whether the session names and folders go with the deck. */
  names: boolean
  theme: Theme
  /** The page's live token values at publish time, `--name` to value, written into the deck. */
  tokens: Record<string, string>
  data: ScopeView
}

export type PublishOutcome =
  | { ok: true; deck: PublishedDeck }
  | {
      ok: false
      kind: 'missing' | 'auth' | 'failed' | 'busy'
      /** One sentence for the page, with the command to run when one applies. */
      message: string
      /** The deck on record no longer exists on Slideless: the next publish makes a new one. */
      gone?: boolean
    }

export type PublishFs = Pick<
  typeof nodeFs,
  'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'rmSync' | 'renameSync'
>

export interface PublishDeps {
  /** The plugin's data folder: the deck folders under `decks/`, the snapshots under `published/`. */
  dir: string
  /** Where the built page lives: `index.html`, `deck.css`, `deck.js`. */
  pageDir: string
  request: PublishRequest
  /** The deck this scope was published as before, or null for a first publish. */
  existing: PublishedDeck | null
  /** The CLI runner; the real one runs `slideless` on the login shell's path (`slidelessRunner`). */
  run?: CliRunner
  now?: () => Date
  fs?: PublishFs
}

export const CLI = 'slideless'
export const INSTALL_HINT = 'team tools install slideless'
export const LOGIN_HINT = 'slideless login'
const PUSH_TIMEOUT_MS = 120_000
const SHELL_TIMEOUT_MS = 15_000
const MAX_BUFFER = 16 * 1024 * 1024

/** The sentences the page says, one each. */
export const MESSAGES = {
  missing: `The Slideless CLI is not on the login shell's path: run ${INSTALL_HINT} in a terminal, then publish again.`,
  auth: `Slideless is not signed in: run ${LOGIN_HINT} in a terminal, then publish again.`,
  gone: 'The deck this page was published as is no longer on Slideless: publish again to make a new one.',
  unreadable: 'The Slideless CLI answered without a deck id; nothing was recorded.'
} as const

// ─── The login shell's environment ───────────────────────────────────────────

type ExecCallback = (
  error: (Error & { code?: string | number; killed?: boolean }) | null,
  stdout: string,
  stderr: string
) => void
export type ExecLike = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; encoding: 'utf8'; timeout: number; maxBuffer: number },
  callback: ExecCallback
) => unknown

const realExec = execFile as unknown as ExecLike

/** `env -0` output into a map; an entry without `=` is skipped. */
export function parseEnv0(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    env[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return env
}

/** The path lists joined in order, each folder once, the first list's folders first. */
export function mergePaths(...lists: (string | undefined)[]): string {
  const out: string[] = []
  for (const list of lists) {
    for (const folder of (list ?? '').split(delimiter)) {
      if (folder && !out.includes(folder)) out.push(folder)
    }
  }
  return out.join(delimiter)
}

function envOf(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value
  return env
}

/**
 * The environment the CLI runs in: the login shell's own (`/bin/zsh -lic env -0`, the way
 * the app finds `gh` for the GitHub panel), with the plugin's own path FIRST. The plugin
 * process is handed the path, the home and the temp folder by the host and nothing else,
 * so the shell is not the person's choice here but zsh, the one the app itself falls back
 * on; the plugin's own path comes first because the dev app and the test harness carry the
 * CLI (or its stand-in) there, while the packaged app's path is the system's four folders,
 * which the login shell lists too. A shell that fails leaves the plugin's own environment.
 */
export async function loginShellEnv(
  exec: ExecLike = realExec,
  base: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const own = envOf(base)
  const login = await new Promise<Record<string, string>>((resolve) => {
    try {
      exec(
        '/bin/zsh',
        ['-lic', 'env -0'],
        { env: own, encoding: 'utf8', timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout) => resolve(error ? {} : parseEnv0(stdout))
      )
    } catch {
      resolve({})
    }
  })
  const env = { ...login }
  env['PATH'] = mergePaths(own['PATH'], login['PATH'])
  for (const key of ['HOME', 'TMPDIR']) {
    const value = own[key]
    if (!env[key] && value) env[key] = value
  }
  return env
}

/** Runs the CLI with its arguments as an argument list, never a shell string: the folder
 *  and the deck id travel as they are. A binary not found is its own result. */
export function slidelessRunner(env: Record<string, string>, exec: ExecLike = realExec): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      exec(
        CLI,
        args,
        { env, encoding: 'utf8', timeout: PUSH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true, stdout, stderr })
          const code = error.code
          resolve({
            ok: false,
            missing: code === 'ENOENT',
            code: typeof code === 'number' ? code : null,
            stderr: (stderr || error.message || '').trim()
          })
        }
      )
    })
}

// ─── The deck ────────────────────────────────────────────────────────────────

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,64}$/
/** A token value as a stylesheet may carry it inline: no brace, no semicolon, no tag. */
const TOKEN_VALUE = /^[^;{}<>]{1,200}$/
const MAX_TOKENS = 600
const STYLE_LINK = '<link rel="stylesheet" href="{{base}}assets/deck.css" />'
const SCRIPT_TAG = '<script src="{{base}}assets/deck.js"></script>'

/** The token entries a deck may carry, the rest dropped. */
export function cleanTokens(tokens: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return out
  for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_TOKENS) break
    if (TOKEN_NAME.test(name) && typeof value === 'string' && TOKEN_VALUE.test(value.trim()))
      out[name] = value.trim()
  }
  return out
}

export interface DeckInput {
  /** The page template, `page/index.html` as built into `dist/`. */
  template: string
  /** The built stylesheet, `dist/deck.css`: the fonts, the tokens, the page's rules. */
  css: string
  /** The built page script, `dist/deck.js`. */
  js: string
  data: ScopeView
  theme: Theme
  tokens: Record<string, string>
  title: string
}

/**
 * One self-contained HTML file from the page's parts: the stylesheet and the script inlined
 * in place of their links, the page's live tokens written after the stylesheet so the deck
 * wears the app's theme as it was at publish time, the data in its block, the stream off
 * (`analytics-events` empty) and the page in `deck` mode. A `</style>` or a `</script>` inside
 * the inlined text is escaped so it cannot close its element early.
 */
export function assembleDeck(input: DeckInput): string {
  if (!input.template.includes(STYLE_LINK) || !input.template.includes(SCRIPT_TAG))
    throw new Error(
      'The page template changed: its stylesheet link or its script tag is not where the deck expects it'
    )
  const tokens = Object.entries(cleanTokens(input.tokens))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  const css = input.css.replace(/<\/style/gi, '<\\/style')
  const js = input.js.replace(/<\/script/gi, '<\\/script')
  const style = `<style>\n${css}\n${tokens ? `:root {\n${tokens}\n}\n` : ''}</style>`
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
      events: null,
      theme: input.theme,
      base: '/',
      mode: 'deck'
    }
  )
  return page.replace(STYLE_AT, () => style).replace(SCRIPT_AT, () => script)
}

/**
 * The view as a deck carries it. Without `names`, every session is `Session n` in the order
 * it appears and the folder is dropped; the group's name, the subagents' type and description
 * and every figure stay, as the spec says. The view is copied, never changed in place.
 */
export function redactView(view: ScopeView, names: boolean): ScopeView {
  const copy = JSON.parse(JSON.stringify(view)) as ScopeView
  if (names) return copy
  const aliases = new Map<string, string>()
  const alias = (id: string): string => {
    let name = aliases.get(id)
    if (!name) {
      name = `Session ${aliases.size + 1}`
      aliases.set(id, name)
    }
    return name
  }
  const walk = (rows: ViewRow[]): void => {
    for (const row of rows) {
      if (row.kind === 'session') row.name = alias(row.id)
      walk(row.children)
    }
  }
  walk(copy.rows)
  for (const s of copy.live) s.name = alias(s.id)
  copy.header.folder = null
  if (copy.kind === 'session') copy.name = copy.id ? alias(copy.id) : 'Session'
  return copy
}

/** The deck's title on Slideless at its first push: the page's name, then the plugin's. */
export function deckTitle(view: ScopeView): string {
  const name = view.name.trim() || 'Analytics'
  return `${name.length > 100 ? `${name.slice(0, 99)}…` : name} · Analytics`
}

/** The push's argument list: a new deck the first time (with its title), a new version of
 *  the deck on record after (its title left as the person may have edited it there). */
export function pushArgs(folder: string, title: string, existing: PublishedDeck | null): string[] {
  const args = ['push', folder, '--json', '--no-open']
  return existing ? [...args, '--id', existing.deckId] : [...args, '--title', title, '--new']
}

/** A scope key as a file or folder name. */
export function fileKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, '-')
}

export interface PushAnswer {
  deckId: string
  version: number
  url: string
  baseUrl: string
}

/** The deck id, the version and the URL out of `slideless push --json`, or null. */
export function parsePush(stdout: string): PushAnswer | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as {
    presentation?: { id?: unknown }
    version?: { version?: unknown }
    url?: unknown
  }
  const deckId = obj.presentation?.id
  const version = obj.version?.version
  const url = obj.url
  if (
    typeof deckId !== 'string' ||
    !deckId ||
    typeof version !== 'number' ||
    typeof url !== 'string'
  )
    return null
  let baseUrl: string
  try {
    baseUrl = new URL(url).origin
  } catch {
    return null
  }
  return { deckId, version, url, baseUrl }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.trim().slice(0, 300)
}

function looksLikeAuth(stderr: string): boolean {
  return /API key is required|not signed in|sign in|login|401|unauthori[sz]ed|invalid.*key/i.test(
    stderr
  )
}

function looksGone(stderr: string): boolean {
  return /not found|not_found|404|no such (deck|presentation)/i.test(stderr)
}

function writeAtomic(fs: PublishFs, file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * One publish, start to end: the CLI and the sign-in checked first (`whoami`, nothing written
 * or sent before it answers), the deck assembled and written under the data folder, pushed
 * as a new deck or a new version of the one on record, the answer read, and the data as
 * published written beside the ledger. Every failure is one sentence for the page.
 */
export async function publishDeck(deps: PublishDeps): Promise<PublishOutcome> {
  const fs = deps.fs ?? nodeFs
  const now = deps.now ?? ((): Date => new Date())
  const run = deps.run ?? slidelessRunner(await loginShellEnv())

  const who = await run(['whoami', '--json'])
  if (!who.ok) {
    if (who.missing) return { ok: false, kind: 'missing', message: MESSAGES.missing }
    if (looksLikeAuth(who.stderr)) return { ok: false, kind: 'auth', message: MESSAGES.auth }
    return {
      ok: false,
      kind: 'failed',
      message: `Slideless could not be reached: ${firstLine(who.stderr) || 'the CLI answered nothing'}.`
    }
  }

  const data = redactView(deps.request.data, deps.request.names)
  const title = deckTitle(data)
  const html = assembleDeck({
    template: fs.readFileSync(join(deps.pageDir, 'index.html'), 'utf8'),
    css: fs.readFileSync(join(deps.pageDir, 'deck.css'), 'utf8'),
    js: fs.readFileSync(join(deps.pageDir, 'deck.js'), 'utf8'),
    data,
    theme: deps.request.theme,
    tokens: deps.request.tokens,
    title
  })
  const folder = join(deps.dir, 'decks', fileKey(deps.request.key))
  fs.mkdirSync(folder, { recursive: true })
  // The ledger is the one record of the deck: the CLI's own link file is not consulted.
  fs.rmSync(join(folder, '.slideless.json'), { force: true })
  fs.writeFileSync(join(folder, 'index.html'), html)

  const pushed = await run(pushArgs(folder, title, deps.existing))
  if (!pushed.ok) {
    if (pushed.missing) return { ok: false, kind: 'missing', message: MESSAGES.missing }
    if (looksLikeAuth(pushed.stderr)) return { ok: false, kind: 'auth', message: MESSAGES.auth }
    if (deps.existing && looksGone(pushed.stderr))
      return { ok: false, kind: 'failed', message: MESSAGES.gone, gone: true }
    return {
      ok: false,
      kind: 'failed',
      message: `Slideless refused the push: ${firstLine(pushed.stderr) || 'no reason given'}.`
    }
  }
  const answer = parsePush(pushed.stdout)
  if (!answer) return { ok: false, kind: 'failed', message: MESSAGES.unreadable }

  const n = (deps.existing?.n ?? 0) + 1
  const at = now().toISOString()
  const deck: PublishedDeck = {
    deckId: answer.deckId,
    baseUrl: answer.baseUrl,
    url: answer.url,
    version: answer.version,
    n,
    at,
    title: deps.existing?.title ?? title,
    names: deps.request.names
  }
  const snapshot = {
    v: 1,
    scope: deps.request.key,
    deck: deck.deckId,
    version: deck.version,
    url: deck.url,
    at,
    names: deps.request.names,
    theme: deps.request.theme,
    range: deps.request.range,
    data
  }
  const published = join(deps.dir, 'published')
  fs.mkdirSync(published, { recursive: true })
  writeAtomic(
    fs,
    join(published, `${fileKey(deps.request.key)}-${n}.json`),
    JSON.stringify(snapshot)
  )
  return { ok: true, deck }
}
