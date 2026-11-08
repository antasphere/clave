import { protocol, session } from 'electron'
import { randomBytes } from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import { previewContentType } from './preview-content-type'
import { VIEW_PARTITION } from './view-guests'

/**
 * clave-preview:// — serves a registered HTML file and its sibling assets to
 * the pages the app shows from disk: the HTML file tabs and the group and
 * session views (web-view guests on the view session) and the linked
 * document panel's preview iframe (the default session).
 *
 * Agent-authored HTML is untrusted input, so the protocol is scoped hard:
 * each registered entry file maps to a random token whose root is the file's
 * own directory. `clave-preview://<token>/<relpath>` resolves inside that root
 * only — traversal and symlink escapes are refused, unknown tokens 404. The
 * token is the URL host (the scheme is "standard"), so the page's own relative
 * asset references resolve naturally within its directory.
 */

const ROOT_BY_TOKEN = new Map<string, string>()
const CSP_BY_TOKEN = new Map<string, string>()
const TOKEN_BY_FILE = new Map<string, string>()

/** MUST run before app ready — grants the scheme URL semantics (host + relative
 *  resolution) and fetch()-ability from the sandboxed preview frames. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'clave-preview',
      privileges: { standard: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/**
 * Register an HTML file for preview and return its clave-preview URL.
 * Idempotent per file path (same token across calls, so iframe reloads and
 * tab dedup keep one origin per file).
 */
export function registerPreviewFile(
  filePath: string,
  contentSecurityPolicy?: string
): { url: string } {
  const abs = path.resolve(filePath)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error(`Not a file: ${abs}`)
  let token = TOKEN_BY_FILE.get(abs)
  if (!token) {
    token = randomBytes(12).toString('hex')
    TOKEN_BY_FILE.set(abs, token)
    ROOT_BY_TOKEN.set(token, path.dirname(abs))
  }
  if (contentSecurityPolicy) CSP_BY_TOKEN.set(token, contentSecurityPolicy)
  return { url: `clave-preview://${token}/${encodeURIComponent(path.basename(abs))}` }
}

export function unregisterPreviewFile(filePath: string): void {
  const abs = path.resolve(filePath)
  const token = TOKEN_BY_FILE.get(abs)
  if (token) {
    ROOT_BY_TOKEN.delete(token)
    CSP_BY_TOKEN.delete(token)
    TOKEN_BY_FILE.delete(abs)
  }
}

function respond(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}

/** Install the request handler. Call after app ready. A session has a
 *  protocol table of its own, so the handler goes on the default session (the
 *  linked document panel's iframe) AND on the view session, where every
 *  web-view guest lives — without the second, a file page in a view is a
 *  blank frame with no error anywhere. */
export function installPreviewProtocol(): void {
  protocol.handle('clave-preview', handlePreviewRequest)
  session.fromPartition(VIEW_PARTITION).protocol.handle('clave-preview', handlePreviewRequest)
}

async function handlePreviewRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return respond(400, 'Bad preview URL')
  }
  const root = ROOT_BY_TOKEN.get(url.host)
  if (!root) return respond(404, 'Unknown preview')

  const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const target = path.normalize(path.join(root, relPath))
  if (target !== root && !target.startsWith(root + path.sep)) {
    return respond(403, 'Outside preview root')
  }
  try {
    // realpath both sides so a symlink inside the root can't read outside it.
    const [realTarget, realRoot] = await Promise.all([
      fs.promises.realpath(target),
      fs.promises.realpath(root)
    ])
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      return respond(403, 'Outside preview root')
    }
    const stat = await fs.promises.stat(realTarget)
    if (!stat.isFile()) return respond(404, 'Not found')
    const data = await fs.promises.readFile(realTarget)
    const ext = path.extname(realTarget).slice(1).toLowerCase()
    return new Response(data, {
      status: 200,
      headers: {
        // MIME by extension; text types get `charset=utf-8` unless the file
        // declares its own encoding or is not UTF-8 (preview-content-type.ts).
        'Content-Type': previewContentType(ext, data),
        // Opaque-origin frames (sandbox without allow-same-origin) fetch
        // their assets cross-origin; the wildcard keeps those requests alive.
        'Access-Control-Allow-Origin': '*',
        // Files under active edit must never go stale in the frame.
        'Cache-Control': 'no-cache',
        ...(CSP_BY_TOKEN.has(url.host)
          ? { 'Content-Security-Policy': CSP_BY_TOKEN.get(url.host)! }
          : {})
      }
    })
  } catch {
    return respond(404, 'Not found')
  }
}
