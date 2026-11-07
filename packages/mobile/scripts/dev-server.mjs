#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by npm run dev:server */
// The standalone Clave server the phone is developed against: this
// repository's own server entry as a DAEMON (it owns its sessions, keeps
// 2000 events of history per session and serves the pending requests, the
// shape of a server at home), started from the checkout under the
// repository's Bun, with the Echo adapter on (`--dev-echo-adapter`: a
// deterministic chat that repeats what it is told, no agent login needed).
//
//   node scripts/dev-server.mjs [--port 43201] [--data /tmp/clave-mobile-c/server]
//                               [--workspace /tmp/clave-mobile-c/scratch]
//
// Prints CLAVE_SERVER_URL and CLAVE_SERVER_TOKEN for the developer screen
// of the app, registers the scratch folder as a workspace of the server
// when it is not one yet, and stops the server on Ctrl-C. The server's
// secrets go to a keychain FILE under its data folder (CLAVE_KEYCHAIN_FILE),
// never to the login keychain. Sessions started on it run the real agents
// of this Mac under the person's own logins: keep them on the scratch
// folder. The built terminal process (`npx electron-vite build` at the
// root) is passed when it exists, so terminals work too; chats and Echo
// need none.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

/** Starts the daemon and resolves `{url, token, serverId, stop}` once it
 *  announces itself in `<dataDir>/clave-server.json`. */
export async function startDevServer({
  port = 43201,
  dataDir = '/tmp/clave-mobile-c/server',
  echo = true,
  timeoutMs = 30_000,
  log = (line) => process.stderr.write(`${line}\n`)
} = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const bun = path.join(REPO, 'node_modules', '.bin', 'bun')
  if (!existsSync(bun))
    throw new Error(`bun not found at ${bun}: npm install at the repository root first`)
  const terminalProcess = path.join(REPO, 'out', 'main', 'terminal-process.js')
  const args = [
    path.join(REPO, 'src', 'main', 'server-entry.ts'),
    '--data-dir',
    dataDir,
    '--daemon',
    '--port',
    String(port),
    ...(echo ? ['--dev-echo-adapter'] : []),
    ...(existsSync(terminalProcess)
      ? ['--terminal-process', terminalProcess, '--node', process.execPath]
      : [])
  ]
  const child = spawn(bun, args, {
    cwd: REPO,
    env: {
      ...process.env,
      CLAVE_KEYCHAIN_FILE: path.join(dataDir, 'keychain.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-16_384)
    for (const line of String(d).split('\n')) if (line.trim()) log(`server: ${line}`)
  })
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) log(`server: ${line}`)
  })
  const discoveryFile = path.join(dataDir, 'clave-server.json')
  const deadline = Date.now() + timeoutMs
  let discovery = null
  while (!discovery) {
    if (child.exitCode !== null)
      throw new Error(`the server exited (${child.exitCode}) before announcing itself\n${stderr}`)
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`the server did not announce itself within ${timeoutMs} ms\n${stderr}`)
    }
    try {
      const value = JSON.parse(readFileSync(discoveryFile, 'utf8'))
      if (
        value.pid === child.pid &&
        typeof value.url === 'string' &&
        typeof value.token === 'string'
      )
        discovery = value
    } catch {
      /* not written yet */
    }
    if (!discovery) await new Promise((r) => setTimeout(r, 100))
  }
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const hard = setTimeout(() => child.kill('SIGKILL'), 8_000)
      child.once('exit', () => {
        clearTimeout(hard)
        resolve()
      })
      child.kill('SIGTERM')
    })
  return {
    url: discovery.url,
    token: discovery.token,
    serverId: discovery.serverId,
    pid: child.pid,
    stop,
    child
  }
}

/** A tiny client for the two calls the script needs. */
export async function call(url, token, method, route, body) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

/** Makes `rootDir` a workspace of the server, named `name`, when it is not one. */
export async function ensureWorkspace(url, token, rootDir, name) {
  mkdirSync(rootDir, { recursive: true })
  const state = await call(url, token, 'GET', '/workspaces')
  const existing = state.workspaces.find((w) => w.rootDir === rootDir)
  if (existing) return existing
  const workspace = { id: randomUUID(), name, rootDir, profileFile: null, createdAt: Date.now() }
  const written = await call(url, token, 'POST', '/workspaces/registry', {
    workspaces: [...state.workspaces, workspace],
    base: { revision: state.revision, instance: state.instance }
  })
  if (!written.ok) throw new Error(`the server refused the workspace: ${written.reason}`)
  return workspace
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const port = Number(arg('port', '43201'))
  const dataDir = arg('data', '/tmp/clave-mobile-c/server')
  const scratch = arg('workspace', '/tmp/clave-mobile-c/scratch')
  const server = await startDevServer({ port, dataDir })
  const workspace = await ensureWorkspace(server.url, server.token, scratch, path.basename(scratch))
  process.stdout.write(
    `clave-server: ${server.url} (data in ${dataDir}, workspace "${workspace.name}" at ${scratch})\n`
  )
  process.stdout.write(`CLAVE_SERVER_URL=${server.url}\nCLAVE_SERVER_TOKEN=${server.token}\n`)
  process.stdout.write(
    'clave-server: running; Ctrl-C stops it. Android emulator: adb reverse tcp:' +
      port +
      ' tcp:' +
      port +
      '\n'
  )
  const stop = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  server.child.once('exit', (code) => process.exit(code ?? 0))
}
