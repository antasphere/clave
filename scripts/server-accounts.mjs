#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run on the server itself */
// The accounts of a Clave server, set from the server's own shell.
//
// A daemon's accounts live in its own data folder and are reachable through
// its HTTP API alone: there is no window on a server to paste a token into.
// This command reads the address and the bearer token the daemon writes into
// `<data-dir>/clave-server.json` (owner-only) and calls the same endpoints
// the app's settings use (`packages/contract/src/settings/api.ts`).
//
// A token or an API key is read from stdin in full and goes out in a
// request body only: never an argument (a process list shows those to every
// user of the machine), never printed, never echoed back in an error.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = `Usage: node scripts/server-accounts.mjs [--data-dir <dir>] <command>
  claude list                      the Claude accounts of this server
  claude add <label>               add a Claude account and store the setup token read from stdin
  claude set-token <account-id>    store a token read from stdin on an existing account
  codex list                       the Codex accounts
  codex add-key <label>            add a Codex API-key account with the key read from stdin

--data-dir defaults to ~/.local/share/clave-server, the install script's default.`

/** A failure the command explains in one line and exits on. */
class Refusal extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

export function parseArgs(argv) {
  const rest = []
  let dataDir = path.join(os.homedir(), '.local', 'share', 'clave-server')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--data-dir') {
      const value = argv[++i]
      if (!value) throw new Refusal(USAGE, 2)
      dataDir = path.resolve(value)
    } else if (arg.startsWith('--data-dir=')) dataDir = path.resolve(arg.slice(11))
    else if (arg.startsWith('-')) throw new Refusal(USAGE, 2)
    else rest.push(arg)
  }
  const [provider, command, value, ...extra] = rest
  const known = {
    'claude list': 0,
    'claude add': 1,
    'claude set-token': 1,
    'codex list': 0,
    'codex add-key': 1
  }
  const wanted = known[`${provider} ${command}`]
  const given = value === undefined ? 0 : 1 + extra.length
  if (wanted === undefined || given !== wanted) throw new Refusal(USAGE, 2)
  return { dataDir, provider, command, value }
}

function readDiscovery(dataDir) {
  const file = path.join(dataDir, 'clave-server.json')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Refusal(`No Clave server data at ${dataDir}: is the server installed and running?`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string')
    throw new Refusal(`${file} does not name a server address and token.`)
  return { url: parsed.url.replace(/\/+$/, ''), token: parsed.token }
}

async function readSecret(what) {
  if (process.stdin.isTTY) process.stderr.write(`Paste the ${what}, then press Ctrl-D\n`)
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const secret = Buffer.concat(chunks).toString('utf8').trim()
  if (!secret) throw new Refusal(`No ${what} on stdin.`)
  return secret
}

/** One call of the server's API. A refusal names the status and the
 *  problem's own sentence, never the body as it came. */
function client({ url, token }) {
  return async (method, route, body) => {
    let res
    try {
      res = await fetch(url + route, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined && { 'content-type': 'application/json' })
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    } catch (error) {
      const code = error?.cause?.code ?? error?.code
      throw new Refusal(`Could not reach the Clave server at ${url}${code ? ` (${code})` : ''}.`)
    }
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!res.ok) {
      const said =
        parsed && typeof parsed === 'object'
          ? [parsed.message, parsed.title].find((v) => typeof v === 'string' && v)
          : undefined
      throw new Refusal(`The server answered ${res.status}${said ? `: ${said}` : '.'}`)
    }
    return parsed
  }
}

const yesNo = (value) => (value ? 'yes' : 'no')

function printAccounts(list, has) {
  if (!Array.isArray(list) || list.length === 0) {
    process.stdout.write('No accounts.\n')
    return
  }
  for (const account of list)
    process.stdout.write(`${account.id}  ${account.label}  ${yesNo(has(account))}\n`)
}

/** A token stored still answers with its first usage read; a refusal there
 *  is worth saying, in the service's own words. */
function reportFirstRead(read) {
  if (read && typeof read === 'object' && typeof read.error === 'string')
    process.stderr.write(`The token is stored, but its first usage read failed: ${read.error}\n`)
}

export async function run(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const call = client(readDiscovery(args.dataDir))
  switch (`${args.provider} ${args.command}`) {
    case 'claude list':
      printAccounts(await call('GET', '/accounts/claude'), (a) => a.hasToken)
      return
    case 'claude add': {
      // The token first: an empty paste must not leave an account behind,
      // and neither must a refused one, so the account goes if the server
      // refuses its token.
      const token = await readSecret('token')
      const account = await call('POST', '/accounts/claude', { label: args.value })
      let read
      try {
        read = await call('POST', '/accounts/claude/token', { id: account.id, token })
      } catch (error) {
        await call('POST', '/accounts/claude/remove', { id: account.id }).catch(() => undefined)
        if (error instanceof Refusal)
          throw new Refusal(`${error.message} Nothing was added.`, error.code)
        throw error
      }
      reportFirstRead(read)
      process.stdout.write(`Added ${account.id}  ${account.label}, with its token.\n`)
      return
    }
    case 'claude set-token': {
      const token = await readSecret('token')
      reportFirstRead(await call('POST', '/accounts/claude/token', { id: args.value, token }))
      process.stdout.write(`Stored the token of ${args.value}.\n`)
      return
    }
    case 'codex list':
      printAccounts(await call('GET', '/accounts/codex'), (a) => a.hasCredential)
      return
    case 'codex add-key': {
      const apiKey = await readSecret('API key')
      const account = await call('POST', '/accounts/codex', { label: args.value, kind: 'apiKey' })
      let job
      try {
        job = await call('POST', '/accounts/login/api-key', { accountId: account.id, apiKey })
      } catch (error) {
        await call('POST', '/accounts/codex/remove', { id: account.id }).catch(() => undefined)
        if (error instanceof Refusal)
          throw new Refusal(`${error.message} Nothing was added.`, error.code)
        throw error
      }
      if (job?.status === 'failed') {
        await call('POST', '/accounts/codex/remove', { id: account.id }).catch(() => undefined)
        throw new Refusal(
          `The key was refused${job.message ? `: ${job.message}` : '.'} Nothing was added.`
        )
      }
      process.stdout.write(`Added ${account.id}  ${account.label}, with its API key.\n`)
      return
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    if (error instanceof Refusal) {
      process.stderr.write(`${error.message}\n`)
      process.exit(error.code)
    }
    process.stderr.write(`server-accounts: ${error?.message ?? 'failed'}\n`)
    process.exit(1)
  })
}
