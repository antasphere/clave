/**
 * A server's own name, kept (PRDCT-4241). A routine's `runsOn` field places
 * it by this name, so the person must be able to read it and set it from
 * Settings, and a name set there must outlive the install script's re-run
 * and the server's upgrade. The precedence, highest first: the name stored
 * in the server's own data (`server-name.json`, written by Settings), the
 * `--server-name` flag the install script carries, the `CLAVE_SERVER_NAME`
 * environment variable (the harness, the in-process server), the first
 * label of the machine's hostname. The flag and the variable seed the name
 * while nothing is stored; they never override a stored one.
 *
 * Plain node, no Electron and no Effect: the server entry reads it at boot.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isServerName } from '@clave/contract/server-name'

export const SERVER_NAME_FILE = 'server-name.json'

/** The machine's own name, the default a server answers to: the first label
 *  of its hostname, without the domain a network appends (`.local` on a Mac,
 *  `.home` or `.lan` from a router), lower-cased by whoever compares it. */
export function defaultServerName(hostname: string): string {
  const label = hostname.trim().split('.')[0]?.trim() ?? ''
  return label || 'clave-server'
}

export interface ServerNameSources {
  /** The name stored in the server's data, null when none is. */
  readonly stored: string | null
  /** `--server-name`, the install script's option. */
  readonly flag?: string | null
  /** `CLAVE_SERVER_NAME`. */
  readonly env?: string | null
  readonly hostname: string
}

/** The one name this server answers to, by the precedence above; a stored,
 *  flagged or environment value that is not a valid name is passed over. */
export function resolveServerName(sources: ServerNameSources): string {
  for (const candidate of [sources.stored, sources.flag, sources.env]) {
    const value = candidate?.trim()
    if (value && isServerName(value)) return value
  }
  return defaultServerName(sources.hostname)
}

/** The stored name under `dir`, null when there is none or it is unreadable. */
export function readStoredServerName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, SERVER_NAME_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const name = (parsed as { name?: unknown } | null)?.name
    return isServerName(name) ? name : null
  } catch {
    return null
  }
}

/** Store the name under `dir`, atomically; throws on a name the rule refuses. */
export function writeStoredServerName(dir: string, name: string): void {
  if (!isServerName(name)) throw new Error(`"${name}" cannot name a server`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, SERVER_NAME_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ name }), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** A server's own name as one object: read at each use (a Settings write
 *  lands between two reads), set from Settings, the sources fixed at boot. */
export interface OwnServerName {
  (): string
  set(name: string): string
}

export function ownServerName(
  dir: string,
  sources: Omit<ServerNameSources, 'stored'>
): OwnServerName {
  const read = (): string =>
    resolveServerName({ ...sources, stored: readStoredServerName(dir) })
  const own = read as OwnServerName
  own.set = (name: string): string => {
    writeStoredServerName(dir, name.trim())
    return read()
  }
  return own
}
