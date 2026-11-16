import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import { gunzipSync } from 'zlib'
import type { SlidelessState } from '@clave/contract/artefacts'

/**
 * The Slideless command line as Clave runs it (PRDCT-4262, Romain's call of
 * 9 November 2026): Clave's OWN copy, downloaded from npm into its data
 * folder and run with Electron's own Node, never a `slideless` found on the
 * person's PATH, never a copy of Slideless's code. The published package is a
 * single file (`dist/bin.js`, everything bundled), so installing it is: read
 * the registry's `latest`, download the tarball, check its sha512 integrity,
 * take two files out of it. No npm, no Node, no network but the registry.
 *
 * Layout under the data folder:
 *   <dir>/<version>/bin.js, package.json   one folder per installed version
 *   <dir>/current.json                      { version } — which one runs
 *
 * Pure over an injected fetch and clock: the whole flow runs under vitest
 * against a fixture registry, with no Electron.
 */

export const SLIDELESS_PACKAGE = '@antasphere/slideless'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** The first release whose dev server keeps local versions and answers the snapshot route. */
export const MIN_SLIDELESS_VERSION = '0.14.0'
/** A path to a `bin.js` to run instead of the managed copy (a teammate's checkout, the tests). */
export const CLI_OVERRIDE_ENV = 'CLAVE_SLIDELESS_CLI'
const MAX_TARBALL_BYTES = 50 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

export interface ResolvedCli {
  /** The script to run with Electron's Node. */
  cliPath: string
  version: string
  /** True when the CLI came from the override, not from Clave's own install. */
  override: boolean
}

/** `a` compared with `b` as dotted numbers (pre-release tags sort below the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core, pre] = v.trim().replace(/^v/, '').split('-', 2)
    return {
      nums: core!.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: pre !== undefined
    }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre !== y.pre) return x.pre ? -1 : 1
  return 0
}

/** The sha512 integrity of a buffer matches the registry's `dist.integrity`. */
export function integrityMatches(data: Buffer, integrity: string): boolean {
  const wanted = integrity
    .split(/\s+/)
    .filter((part) => part.startsWith('sha512-'))
    .map((part) => part.slice('sha512-'.length))
  if (wanted.length === 0) return false
  const actual = createHash('sha512').update(data).digest('base64')
  return wanted.includes(actual)
}

/**
 * The regular files of a tar archive (ustar, as npm packs them), by path.
 * Directory, link and extended-header entries are skipped; a path that would
 * leave the archive (absolute, `..`) is refused.
 */
export function readTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('Unreadable archive header')
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const start = offset + 512
    const end = start + size
    if (end > archive.length) throw new Error('Truncated archive')
    const data = archive.subarray(start, end)
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '\0' || type === '7') {
      const clean = normalize(name).replace(/\\/g, '/')
      if (isAbsolute(clean) || clean.split('/').includes('..'))
        throw new Error(`Refusing an archive entry outside the package: ${name}`)
      files.set(clean, Buffer.from(data))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

export interface InstallDeps {
  fetch: typeof globalThis.fetch
  registry?: string
  /** Every request to the registry, its body included (default one minute). */
  timeoutMs?: number
}

interface RegistryLatest {
  version: string
  tarball: string
  integrity: string
}

/** A JSON answer under one timeout that covers its body: a stalled answer fails. */
async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return { status: res.status, body: null }
    return { status: res.status, body: await res.json() }
  } catch (err) {
    if (controller.signal.aborted) throw new Error('The registry did not answer in time')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** The package file, under one timeout that covers the body too: a stalled download fails. */
async function download(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`The registry answered ${res.status} for the package file`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_TARBALL_BYTES) throw new Error('The package file is too large')
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_TARBALL_BYTES) throw new Error('The package file is too large')
    return body
  } catch (err) {
    if (controller.signal.aborted) throw new Error('The package download timed out')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function latest(deps: InstallDeps): Promise<RegistryLatest> {
  const registry = (deps.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const res = await fetchJson(
    deps.fetch,
    `${registry}/${SLIDELESS_PACKAGE.replace('/', '%2f')}/latest`,
    deps.timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  if (res.status !== 200 || res.body === null)
    throw new Error(`The registry answered ${res.status} for ${SLIDELESS_PACKAGE}`)
  const body = res.body as {
    version?: unknown
    dist?: { tarball?: unknown; integrity?: unknown }
  }
  if (
    typeof body.version !== 'string' ||
    typeof body.dist?.tarball !== 'string' ||
    typeof body.dist?.integrity !== 'string'
  )
    throw new Error('The registry answered an unexpected shape')
  return { version: body.version, tarball: body.dist.tarball, integrity: body.dist.integrity }
}

/** The version the registry offers now, without installing it. */
export async function latestSlidelessVersion(deps: InstallDeps): Promise<string> {
  return (await latest(deps)).version
}

/** The version recorded as installed in `dir`, when its files are there. */
export function installedVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as {
      version?: unknown
    }
    if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) return null
    return existsSync(join(dir, version, 'bin.js')) ? version : null
  } catch {
    return null
  }
}

/**
 * Download, verify and install the registry's latest release into `dir`, then
 * point `current.json` at it. A release older than MIN_SLIDELESS_VERSION is
 * refused (it has no local versions). The swap is a rename: a run in flight
 * keeps its file, and a failed install leaves the previous one in place.
 */
export async function installSlideless(dir: string, deps: InstallDeps): Promise<string> {
  const release = await latest(deps)
  if (compareVersions(release.version, MIN_SLIDELESS_VERSION) < 0)
    throw new Error(
      `The registry offers Slideless ${release.version}; Clave needs ${MIN_SLIDELESS_VERSION} or later`
    )
  if (!/^[0-9A-Za-z.+-]+$/.test(release.version))
    throw new Error(`Unexpected version string: ${release.version}`)
  const tarball = await download(deps.fetch, release.tarball, deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
  if (!integrityMatches(tarball, release.integrity))
    throw new Error('The downloaded package does not match its published integrity hash')
  const files = readTar(gunzipSync(tarball))
  const bin = files.get('package/dist/bin.js')
  const manifest = files.get('package/package.json')
  if (!bin || !manifest) throw new Error('The package does not carry dist/bin.js')
  const { version } = JSON.parse(manifest.toString('utf8')) as { version?: unknown }
  if (version !== release.version)
    throw new Error(`The package says ${String(version)}, the registry ${release.version}`)

  mkdirSync(dir, { recursive: true })
  const staging = join(dir, `.staging-${randomBytes(6).toString('hex')}`)
  const target = join(dir, release.version)
  try {
    mkdirSync(staging)
    writeFileSync(join(staging, 'bin.js'), bin)
    writeFileSync(join(staging, 'package.json'), manifest)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  const pointer = join(dir, `.current-${randomBytes(6).toString('hex')}.json`)
  writeFileSync(pointer, `${JSON.stringify({ version: release.version })}\n`)
  renameSync(pointer, join(dir, 'current.json'))
  return release.version
}

/**
 * Which CLI runs: the override when it names a file, else Clave's own install
 * when it is recent enough, else none (and why, for the install card).
 */
export function resolveCli(
  dir: string,
  env: NodeJS.ProcessEnv
): { cli: ResolvedCli } | { cli: null; reason: string } {
  const override = env[CLI_OVERRIDE_ENV]?.trim()
  if (override) {
    if (!existsSync(override)) return { cli: null, reason: `${CLI_OVERRIDE_ENV} names no file` }
    return { cli: { cliPath: override, version: 'override', override: true } }
  }
  const version = installedVersion(dir)
  if (!version) return { cli: null, reason: 'Slideless is not installed yet' }
  if (compareVersions(version, MIN_SLIDELESS_VERSION) < 0)
    return { cli: null, reason: `Slideless ${version} is older than ${MIN_SLIDELESS_VERSION}` }
  return { cli: { cliPath: join(dir, version, 'bin.js'), version, override: false } }
}

/** The state the renderer shows, from a resolution and what is running. */
export function describeState(
  resolved: ReturnType<typeof resolveCli>,
  installing: boolean,
  error: string | null
): SlidelessState {
  if (installing) return { phase: 'installing', version: null, error: null }
  if (resolved.cli)
    return {
      phase: 'ready',
      version: resolved.cli.version,
      error: null,
      override: resolved.cli.override
    }
  return { phase: error ? 'error' : 'missing', version: null, error: error ?? resolved.reason }
}
