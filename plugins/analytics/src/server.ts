import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { PluginActionTargetKind } from './host'
import { pickTheme, renderPage, type Theme } from './html'
import {
  groupView,
  isRange,
  scopeKey,
  sessionView,
  workspaceView,
  type Ledger,
  type Range,
  type ScopeView
} from './ledger'
import { tableFromJson, type PriceTable } from './prices'
import { cleanTokens, type PublishOutcome, type PublishRequest } from './publish'
import { GAP_MAX, GAP_MIN, parseGap } from './settings'
import type { ServerInfo } from './store'

/**
 * The pages, on loopback only. Every route lives under `/<token>/`, a random token minted
 * once and kept in `server.json` with the port, so a page URL survives a restart and no
 * other local page can guess one. Anything else answers 404 with an empty body. Two routes
 * take a POST, both under the token and both JSON: `settings` (the gap and the price table)
 * and `publish` (a page pushed to Slideless); every other method answers 404.
 */

export type Scope =
  | { kind: 'session'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'workspace'; ws: string | null }

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
  /** One publish of a page; without it the route answers 404. */
  publish?: (request: PublishRequest) => Promise<PublishOutcome>
}

export interface AnalyticsServer {
  readonly port: number
  /** The page URL for an action target. */
  url(kind: PluginActionTargetKind, id: string, workspaceId: string | null): string
  close(): Promise<void>
}

const PING_MS = 25_000
const EVENT_DEBOUNCE_MS = 500
const BODY_LIMIT = 256 * 1024

export function defaultRange(scope: Scope): Range {
  return scope.kind === 'workspace' ? 'today' : 'all'
}

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

/** The scope's key: `session:<id>`, `group:<id>`, `workspace:<ws|->`. */
export function scopeParam(scope: Scope): string {
  return scopeKey(scope.kind, scope.kind === 'workspace' ? scope.ws : scope.id)
}

export function parseScopeParam(value: string | null): Scope | null {
  if (!value) return null
  const at = value.indexOf(':')
  if (at < 0) return null
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  if (kind === 'workspace') return { kind, ws: id === '-' || id === '' ? null : id }
  if ((kind === 'session' || kind === 'group') && id) return { kind, id }
  return null
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' })
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

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The request's body as text, or null when it is over the limit or broke off. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
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

interface PublishBody {
  scope: Scope
  range: Range
  names: boolean
  theme: Theme
  tokens: Record<string, string>
}

/** A publish request's body, or the sentence that refuses it. */
export function parsePublishBody(raw: unknown): { body: PublishBody } | { error: string } {
  if (!isObj(raw)) return { error: 'The body is not an object.' }
  const scope = parseScopeParam(typeof raw['scope'] === 'string' ? raw['scope'] : null)
  if (!scope) return { error: 'The body names no page to publish.' }
  const range = isRange(raw['range']) ? raw['range'] : defaultRange(scope)
  return {
    body: {
      scope,
      range,
      names: raw['names'] === true,
      theme: pickTheme(typeof raw['theme'] === 'string' ? raw['theme'] : null),
      tokens: cleanTokens(raw['tokens'])
    }
  }
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
    const query = new URLSearchParams()
    if (scope.kind === 'workspace' && scope.ws) query.set('ws', scope.ws)
    if (range) query.set('range', range)
    if (theme) query.set('theme', theme)
    const path =
      scope.kind === 'workspace' ? 'workspace' : `${scope.kind}/${encodeURIComponent(scope.id)}`
    const q = query.toString()
    return `/${token}/${path}${q ? `?${q}` : ''}`
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
        mode: 'live'
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
      'x-accel-buffering': 'no'
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
    if (text === null) {
      sendJson(res, 413, { error: 'The body is too large.' })
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

  const handlePublish = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const publish = options.publish
    if (!publish) return notFound(res)
    const raw = await readJsonBody(req, res)
    if (raw === undefined) return
    const parsed = parsePublishBody(raw)
    if ('error' in parsed) return sendJson(res, 400, { error: parsed.error })
    const { scope, range, names, theme, tokens } = parsed.body
    const data = view(scope, range)
    if (!data)
      return sendJson(res, 404, {
        ok: false,
        kind: 'failed',
        message: 'Nothing is measured for this page yet.'
      })
    let outcome: PublishOutcome
    try {
      outcome = await publish({ key: scopeParam(scope), range, names, theme, tokens, data })
    } catch (error) {
      outcome = {
        ok: false,
        kind: 'failed',
        message: `The publish failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    sendJson(res, 200, outcome)
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
      if (rest.length === 1 && head === 'publish') return void handlePublish(req, res)
      return notFound(res)
    }
    if (req.method !== 'GET') return notFound(res)
    const q = url.searchParams
    const rangeParam = q.get('range')
    const rangeFor = (scope: Scope): Range =>
      isRange(rangeParam) ? rangeParam : defaultRange(scope)
    const theme = q.get('theme')

    if (rest.length === 2 && (head === 'session' || head === 'group') && a) {
      const scope: Scope = { kind: head, id: a }
      return servePage(res, scope, rangeFor(scope), theme)
    }
    if (rest.length === 1 && head === 'workspace') {
      const scope: Scope = { kind: 'workspace', ws: q.get('ws') || null }
      return servePage(res, scope, rangeFor(scope), theme)
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
      return sendJson(res, 200, data)
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
    options.store.writeServer({ port, token })
  }

  return {
    port,
    url(kind, id, workspaceId): string {
      // `none` is what the renderer names the workspace when no workspace is open.
      const scope: Scope =
        kind === 'workspace'
          ? { kind, ws: workspaceId ?? (id && id !== 'none' ? id : null) }
          : { kind, id }
      return `http://${host}:${port}${pagePath(scope, null, null)}`
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
