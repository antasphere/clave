import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { PluginActionTargetKind } from './host'
import { pickTheme, renderPage } from './html'
import { groupView, sessionView, workspaceView, type Ledger, type ScopeView } from './ledger'
import { tableFromJson, type PriceTable } from './prices'
import {
  defaultRange,
  isRange,
  parseScopeParam,
  scopeParam,
  scopePath,
  type Range,
  type Scope
} from './scope'
import { GAP_MAX, GAP_MIN, parseGap } from './settings'
import type { ServerInfo } from './store'

/**
 * The pages, on loopback only. Every route lives under `/<token>/`, a random token minted
 * once and kept in `server.json` with the port, so a page URL survives a restart and no
 * other local page can guess one. Anything else answers 404 with an empty body. One route
 * takes a POST, under the token and JSON: `settings` (the gap and the price table); every
 * other method answers 404. The `open` routes are where the host's actions and the pages'
 * own links lead: each writes the scope's deck and answers a redirect to the Slideless
 * viewer's copy of it, or to the plugin's own page when there is no viewer. The stream and
 * the data routes answer any origin, so the viewer's copy follows the ledger live too.
 */

export type { Scope } from './scope'
export { defaultRange, parseScopeParam, scopeParam } from './scope'

export interface CollectorLike {
  readonly ledger: Ledger
  on(event: 'changed', listener: (ids: Set<string>) => void): unknown
  off(event: 'changed', listener: (ids: Set<string>) => void): unknown
}

export interface StoreLike {
  readServer(): ServerInfo | null
  writeServer(info: ServerInfo): void
}

/** What the settings page shows and edits. */
export interface SettingsData {
  gapMinutes: number
  gapBounds: { min: number; max: number }
  /** The table in force: the person's own copy when there is one, else the shipped one. */
  prices: PriceTable
  override: boolean
  shipped: { date: string; source: string }
}

export interface SettingsPatch {
  gapMinutes?: number
  prices?: PriceTable
  /** Drop the person's copy: the shipped table is in force again. */
  resetPrices?: boolean
}

export interface SettingsPort {
  get(): SettingsData
  /** Applies a validated patch and answers the state in force after it. */
  apply(patch: SettingsPatch): SettingsData
}

/** Where an open leads: the deck written and the viewer's URL for it, or null for the
 *  plugin's own page. The server hands it the scope and the range the route named. */
export type OpenPort = (scope: Scope, range: Range) => Promise<string | null> | string | null

export interface ServerOptions {
  store: StoreLike
  collector: CollectorLike
  prices: PriceTable | (() => PriceTable)
  pageDir: string
  host?: '127.0.0.1'
  now?: () => Date
  /** Where a page that could not be drawn is said, once per page. */
  log?: (level: 'warn' | 'error', message: string) => void
  /** The settings page and its data; without it the route answers 404. */
  settings?: SettingsPort
  /** The decks and the viewer; without it an open leads to the plugin's own page. */
  open?: OpenPort
  /** The footer's last line on the plugin's own page: what the viewer is doing. */
  note?: () => string
}

export interface AnalyticsServer {
  readonly port: number
  /** The token root, absolute: `http://127.0.0.1:<port>/<token>/`. */
  readonly base: string
  /** The page URL for an action target, through the open route. */
  url(kind: PluginActionTargetKind, id: string, workspaceId: string | null): string
  /** The plugin's own page URL for a scope, where an open without a viewer leads. */
  pageUrl(scope: Scope, range: Range | null): string
  close(): Promise<void>
}

const PING_MS = 25_000
const EVENT_DEBOUNCE_MS = 500
const BODY_LIMIT = 256 * 1024
/** Past this, the request is cut rather than drained: nothing honest is that large. */
const BODY_CUT = 4 * 1024 * 1024

export function scopeView(
  ledger: Ledger,
  prices: PriceTable,
  scope: Scope,
  range: Range = defaultRange(scope),
  now: Date = new Date()
): ScopeView | null {
  if (scope.kind === 'session') return sessionView(ledger, scope.id, prices)
  if (scope.kind === 'group') return groupView(ledger, scope.id, prices, range, now)
  return workspaceView(ledger, scope.ws, prices, range, now)
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' })
  res.end()
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'content-length': '0', 'cache-control': 'no-store' })
  res.end()
}

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  'font-src data:',
  'img-src data:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'content-security-policy': PAGE_CSP } : {})
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/** The read-only routes a deck follows from the viewer: the viewer's sandbox gives its pages
 *  an opaque origin, so the stream and the data answer any origin; the token in the path
 *  stays the guard, and nothing under it writes on a GET. */
const ANY_ORIGIN = { 'access-control-allow-origin': '*' }

function sendData(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...ANY_ORIGIN
  })
  res.end(body)
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The request's body as text; `tooLarge` when it went over the limit (the rest of the body
 *  is read and dropped so the 413 can be answered on an open socket), null when it broke off. */
function readBody(req: IncomingMessage): Promise<string | null | 'tooLarge'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    let over = false
    const finish = (value: string | null | 'tooLarge'): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > BODY_CUT) {
        finish(null)
        req.destroy()
        return
      }
      if (size > BODY_LIMIT) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(over ? 'tooLarge' : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A settings patch out of a request body, or the sentence that refuses it. */
export function parseSettingsPatch(raw: unknown): { patch: SettingsPatch } | { error: string } {
  if (!isObj(raw)) return { error: 'The body is not an object.' }
  const patch: SettingsPatch = {}
  if ('gapMinutes' in raw) {
    const gap = parseGap(raw['gapMinutes'])
    if (gap === null)
      return { error: `The gap is a whole number of minutes from ${GAP_MIN} to ${GAP_MAX}.` }
    patch.gapMinutes = gap
  }
  if (raw['resetPrices'] === true) {
    patch.resetPrices = true
  } else if ('prices' in raw) {
    const given = raw['prices']
    const table = tableFromJson(given)
    const wanted = isObj(given) && isObj(given['models']) ? Object.keys(given['models']).length : -1
    if (!table || Object.keys(table.models).length !== wanted)
      return { error: 'Every model needs a non-empty id and five prices, numbers of zero or more.' }
    patch.prices = table
  }
  return { patch }
}

/** The scope a route's path names, `session/<id>`, `group/<id>` or `workspace` with its
 *  `ws` query, or null for any other path. */
export function scopeOfPath(parts: string[], query: URLSearchParams): Scope | null {
  const [head, a] = parts
  if (parts.length === 2 && (head === 'session' || head === 'group') && a)
    return { kind: head, id: a }
  if (parts.length === 1 && head === 'workspace')
    return { kind: 'workspace', ws: query.get('ws') || null }
  return null
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function startServer(options: ServerOptions): Promise<AnalyticsServer> {
  const host = options.host ?? '127.0.0.1'
  const saved = options.store.readServer()
  const token = saved?.token ?? randomBytes(16).toString('hex')
  const prices = (): PriceTable =>
    typeof options.prices === 'function' ? options.prices() : options.prices
  const now = options.now ?? ((): Date => new Date())
  const streams = new Set<{ res: ServerResponse; stop: () => void }>()

  // A row the views cannot draw answers nothing, never a crash: the live push runs on a
  // timer where a throw would end the plugin's process. The cause is said once per page.
  const undrawn = new Set<string>()
  const view = (scope: Scope, range: Range): ScopeView | null => {
    try {
      return scopeView(options.collector.ledger, prices(), scope, range, now())
    } catch (error) {
      const key = scopeParam(scope)
      if (!undrawn.has(key)) {
        undrawn.add(key)
        options.log?.(
          'warn',
          `The ${scope.kind} page ${key} could not be drawn from the ledger: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
      return null
    }
  }

  const pagePath = (scope: Scope, range: Range | null, theme: string | null): string => {
    const path = scopePath(scope, range)
    if (!theme) return `/${token}/${path}`
    return `/${token}/${path}${path.includes('?') ? '&' : '?'}theme=${encodeURIComponent(theme)}`
  }

  const template = (name: string): string | null => {
    try {
      return readFileSync(join(options.pageDir, name), 'utf8')
    } catch {
      return null
    }
  }

  const servePage = (
    res: ServerResponse,
    scope: Scope,
    range: Range,
    theme: string | null
  ): void => {
    const data = view(scope, range)
    if (!data) return notFound(res)
    const page = template('index.html')
    if (page === null) return notFound(res)
    const events = `/${token}/events?${new URLSearchParams({ scope: scopeParam(scope), range })}`
    send(
      res,
      200,
      'text/html; charset=utf-8',
      renderPage(page, {
        title: data.name,
        data,
        events,
        theme: pickTheme(theme),
        base: `/${token}/`,
        mode: 'live',
        note: options.note?.() ?? ''
      })
    )
  }

  const serveSettingsPage = (res: ServerResponse, theme: string | null): void => {
    if (!options.settings) return notFound(res)
    const page = template('settings.html')
    if (page === null) return notFound(res)
    send(
      res,
      200,
      'text/html; charset=utf-8',
      renderPage(page, {
        title: 'Analytics settings',
        data: options.settings.get(),
        events: null,
        theme: pickTheme(theme),
        base: `/${token}/`,
        mode: 'live'
      })
    )
  }

  const serveEvents = (
    req: IncomingMessage,
    res: ServerResponse,
    scope: Scope,
    range: Range
  ): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...ANY_ORIGIN
    })
    const push = (): void => {
      const data = view(scope, range)
      if (data) res.write(`event: data\ndata: ${JSON.stringify(data)}\n\n`)
    }
    let pending: ReturnType<typeof setTimeout> | null = null
    const onChanged = (): void => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        push()
      }, EVENT_DEBOUNCE_MS)
    }
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    const entry = {
      res,
      stop: (): void => {
        clearInterval(ping)
        if (pending) clearTimeout(pending)
        options.collector.off('changed', onChanged)
        streams.delete(entry)
      }
    }
    streams.add(entry)
    options.collector.on('changed', onChanged)
    req.on('close', entry.stop)
    push()
  }

  const serveAsset = (res: ServerResponse, name: string): void => {
    const types: Record<string, string> = {
      'deck.css': 'text/css; charset=utf-8',
      'deck.js': 'text/javascript; charset=utf-8',
      'settings.js': 'text/javascript; charset=utf-8'
    }
    const type = types[name]
    if (!type) return notFound(res)
    const body = template(name)
    if (body === null) return notFound(res)
    send(res, 200, type, body)
  }

  const readJsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    const text = await readBody(req)
    if (text === 'tooLarge') {
      sendJson(res, 413, { error: 'The body is too large.' })
      return undefined
    }
    if (text === null) {
      sendJson(res, 400, { error: 'The body broke off.' })
      return undefined
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      sendJson(res, 400, { error: 'The body is not JSON.' })
      return undefined
    }
  }

  const handleSettings = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const settings = options.settings
    if (!settings) return notFound(res)
    const raw = await readJsonBody(req, res)
    if (raw === undefined) return
    const parsed = parseSettingsPatch(raw)
    if ('error' in parsed) return sendJson(res, 400, { error: parsed.error })
    try {
      sendJson(res, 200, settings.apply(parsed.patch))
    } catch (error) {
      sendJson(res, 500, {
        error: `The settings could not be saved: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  /** An open: the deck written and the viewer's URL answered, else the plugin's own page.
   *  A scope nothing is measured for answers 404, as its page would. */
  const handleOpen = async (
    res: ServerResponse,
    scope: Scope,
    range: Range,
    theme: string | null
  ): Promise<void> => {
    if (!view(scope, range)) return notFound(res)
    let target: string | null = null
    if (options.open) {
      try {
        target = await options.open(scope, range)
      } catch (error) {
        options.log?.(
          'warn',
          `The deck of ${scopeParam(scope)} could not be written: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    redirect(res, target ?? pagePath(scope, range, theme))
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let url: URL
    let parts: string[]
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
      parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    } catch {
      return notFound(res)
    }
    if (parts.length < 2 || !sameToken(parts[0]!, token)) return notFound(res)
    const rest = parts.slice(1)
    const [head, a, b] = rest
    if (req.method === 'POST') {
      if (rest.length === 1 && head === 'settings') return void handleSettings(req, res)
      return notFound(res)
    }
    if (req.method !== 'GET') return notFound(res)
    const q = url.searchParams
    const rangeParam = q.get('range')
    const rangeFor = (scope: Scope): Range =>
      isRange(rangeParam) ? rangeParam : defaultRange(scope)
    const theme = q.get('theme')

    const page = scopeOfPath(rest, q)
    if (page) return servePage(res, page, rangeFor(page), theme)
    if (head === 'open') {
      const scope = scopeOfPath(rest.slice(1), q)
      if (!scope) return notFound(res)
      return void handleOpen(res, scope, rangeFor(scope), theme)
    }
    if (rest.length === 1 && head === 'settings') return serveSettingsPage(res, theme)
    if (head === 'data') {
      if (rest.length === 2 && a === 'settings.json') {
        if (!options.settings) return notFound(res)
        return sendJson(res, 200, options.settings.get())
      }
      let scope: Scope | null = null
      if (rest.length === 3 && (a === 'session' || a === 'group') && b?.endsWith('.json')) {
        scope = { kind: a, id: b.slice(0, -'.json'.length) }
      } else if (rest.length === 2 && a === 'workspace.json') {
        scope = { kind: 'workspace', ws: q.get('ws') || null }
      }
      if (!scope || (scope.kind !== 'workspace' && !scope.id)) return notFound(res)
      const data = view(scope, rangeFor(scope))
      if (!data) return notFound(res)
      return sendData(res, 200, data)
    }
    if (rest.length === 1 && head === 'events') {
      const scope = parseScopeParam(q.get('scope'))
      if (!scope) return notFound(res)
      return serveEvents(req, res, scope, rangeFor(scope))
    }
    if (rest.length === 2 && head === 'assets' && a) return serveAsset(res, a)
    return notFound(res)
  }

  const server = createServer(handle)
  let port: number
  try {
    port = await listen(server, saved?.port ?? 0, host)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' && !saved) throw error
    port = await listen(server, 0, host)
  }
  if (!saved || saved.port !== port || saved.token !== token) {
    options.store.writeServer({ ...(saved ?? {}), port, token })
  }
  const base = `http://${host}:${port}/${token}/`

  return {
    port,
    base,
    url(kind, id, workspaceId): string {
      // `none` is what the renderer names the workspace when no workspace is open.
      const scope: Scope =
        kind === 'workspace'
          ? { kind, ws: workspaceId ?? (id && id !== 'none' ? id : null) }
          : { kind, id }
      return `${base}open/${scopePath(scope, null)}`
    },
    pageUrl(scope, range): string {
      return `http://${host}:${port}${pagePath(scope, range, null)}`
    },
    close(): Promise<void> {
      for (const s of [...streams]) {
        s.stop()
        s.res.end()
      }
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}
