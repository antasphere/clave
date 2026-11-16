#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by the owner with node */
/**
 * The owner's word on a phone, on this Mac, without the owner's token ever
 * leaving it (PRDCT-4448). The desktop has no pairing page on this branch:
 * a phone asks through the server's open pairing route, and the owner
 * approves, refuses or revokes it here, with the server's own token read from
 * the local discovery file into a request header and never printed.
 *
 *   node scripts/phone-pairing.mjs --list
 *   node scripts/phone-pairing.mjs --approve <pairing-id> [--expect-name <name>]
 *   node scripts/phone-pairing.mjs --refuse <pairing-id>
 *   node scripts/phone-pairing.mjs --revoke <device-id>
 *   [--discovery <path to clave-server.json>]   (default: the app's own)
 *
 * The checks, each one a refusal (exit 2) before anything is sent:
 * - the discovery file is a regular file of this user's, mode 0600, saying
 *   `ok: true`, with a token and a loopback address (`http://127.0.0.1:<port>`
 *   or `http://localhost:<port>`): the owner's token goes to the local server
 *   and nowhere else, never to the private network address a phone uses;
 * - an approval names ONE pairing by its id, read again from the owner's list
 *   (`GET /devices`) right before: it must be there, pending, more than 30 s
 *   from lapsing, and named as `--expect-name` says when that is given. A name
 *   alone approves nothing, and nothing approves every pending phone.
 * The script never reads `GET /devices/pair`: that read hands the phone its
 * device session exactly once, and it is the phone's to make. Every request is
 * bounded (10 s) and never retried; exit 1 is any other failure.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_DISCOVERY = join(
  homedir(),
  'Library',
  'Application Support',
  'Clave',
  'clave-server.json'
)
/** How close to its lapse a pairing may be and still be approved. */
export const APPROVAL_MARGIN_MS = 30_000
const TIMEOUT_MS = 10_000
const LOOPBACK = new Set(['127.0.0.1', 'localhost'])

/** A refusal by one of the checks: exit 2, nothing sent. */
export class Refused extends Error {}

/** The local server's address and token, after the file's checks. */
export function readDiscovery(file, { uid = process.getuid?.() } = {}) {
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    throw new Refused(`No discovery file at ${file}: is Clave running?`)
  }
  if (!stat.isFile()) throw new Refused(`${file} is not a regular file.`)
  if (uid !== undefined && stat.uid !== uid) throw new Refused(`${file} is not this user's.`)
  if ((stat.mode & 0o777) !== 0o600) throw new Refused(`${file} must be owner-only (0600).`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Refused(`${file} is not readable JSON.`)
  }
  if (parsed?.ok !== true) throw new Refused('The discovery file says the server is not up.')
  if (typeof parsed.token !== 'string' || parsed.token.length < 32)
    throw new Refused('The discovery file carries no server token.')
  let url
  try {
    url = new URL(parsed.url)
  } catch {
    throw new Refused('The discovery file carries no server address.')
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.pathname !== '/')
    throw new Refused(
      'The server address is not this Mac’s loopback; the owner’s token stays here.'
    )
  return { url: url.origin, token: parsed.token }
}

/** One request to the local server, as its owner. Never echoes the token. */
async function call(server, method, path, body, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(`${server.url}${path}`, {
      method,
      signal: controller.signal,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${server.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch {
    throw new Error(`The local server did not answer ${method} ${path}.`)
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (response.status < 200 || response.status > 299) {
    const said = json && typeof json.message === 'string' ? `: ${json.message}` : ''
    throw new Error(`The server answered ${response.status} to ${method} ${path}${said}`)
  }
  return json
}

const when = (ms) => new Date(ms).toISOString()

/** The owner's list: the phones asking and the phones paired. */
export async function list(server, fetchImpl) {
  return call(server, 'GET', '/devices', undefined, fetchImpl)
}

/** Approve one pairing, named by its id, after reading it again from the list. */
export async function approve(server, pairingId, { expectName, now = Date.now(), fetchImpl } = {}) {
  if (typeof pairingId !== 'string' || pairingId === '') throw new Refused('Name the pairing id.')
  const view = await list(server, fetchImpl)
  const matching = (view?.pending ?? []).filter((p) => p.id === pairingId)
  if (matching.length !== 1)
    throw new Refused(`No pending pairing ${pairingId}: run --list and use the id it shows.`)
  const pairing = matching[0]
  if (pairing.expiresAt - now <= APPROVAL_MARGIN_MS)
    throw new Refused(
      `Pairing ${pairingId} lapses at ${when(pairing.expiresAt)}; ask again from the phone.`
    )
  if (expectName !== undefined && pairing.name !== expectName)
    throw new Refused(`Pairing ${pairingId} is named “${pairing.name}”, not “${expectName}”.`)
  const device = await call(server, 'POST', '/devices/approve', { pairingId }, fetchImpl)
  return { pairing, device }
}

export async function refuse(server, pairingId, fetchImpl) {
  if (typeof pairingId !== 'string' || pairingId === '') throw new Refused('Name the pairing id.')
  await call(server, 'POST', '/devices/refuse', { pairingId }, fetchImpl)
}

export async function revoke(server, deviceId, fetchImpl) {
  if (typeof deviceId !== 'string' || deviceId === '') throw new Refused('Name the device id.')
  await call(server, 'POST', '/devices/revoke', { deviceId }, fetchImpl)
}

function parseArgs(argv) {
  const args = { discovery: DEFAULT_DISCOVERY }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) throw new Refused(`${flag} needs a value.`)
      return next
    }
    if (flag === '--list') args.action = 'list'
    else if (flag === '--approve') [args.action, args.id] = ['approve', value()]
    else if (flag === '--refuse') [args.action, args.id] = ['refuse', value()]
    else if (flag === '--revoke') [args.action, args.id] = ['revoke', value()]
    else if (flag === '--expect-name') args.expectName = value()
    else if (flag === '--discovery') args.discovery = value()
    else throw new Refused(`Unknown argument ${flag}.`)
  }
  if (!args.action) throw new Refused('Say --list, --approve <id>, --refuse <id> or --revoke <id>.')
  return args
}

export async function main(argv = process.argv.slice(2), out = console.log) {
  const args = parseArgs(argv)
  const server = readDiscovery(args.discovery)
  if (args.action === 'list') {
    const view = await list(server)
    out(`Phones asking to pair (${view.pending.length}):`)
    for (const p of view.pending)
      out(
        `  ${p.id}  ${p.name}  ${p.platform} ${p.appVersion}  asked ${when(p.requestedAt)}  lapses ${when(p.expiresAt)}`
      )
    out(`Phones paired (${view.devices.length}):`)
    for (const d of view.devices)
      out(
        `  ${d.id}  ${d.name}  ${d.platform} ${d.appVersion}  last seen ${d.lastSeenAt === null ? 'never' : when(d.lastSeenAt)}`
      )
    return
  }
  if (args.action === 'approve') {
    const { device } = await approve(server, args.id, { expectName: args.expectName })
    out(
      `Approved: ${device.name} (${device.platform} ${device.appVersion}), device ${device.id}. The phone collects its session itself.`
    )
    return
  }
  if (args.action === 'refuse') {
    await refuse(server, args.id)
    out(`Refused pairing ${args.id}.`)
    return
  }
  await revoke(server, args.id)
  out(`Revoked device ${args.id}: its next call is refused and its socket closed.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    () => {
      process.exitCode = 0
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = error instanceof Refused ? 2 : 1
    }
  )
}
