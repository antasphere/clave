#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by npm run dev:attached */
// `npm run dev:attached`: the dev app ATTACHED to a server that is its own
// process (ADR 0003). Starts the server on a free loopback port, then
// `electron-vite dev` with `CLAVE_SERVER_URL` and `CLAVE_SERVER_TOKEN` set,
// and stops the server when the dev app ends. Ctrl-C ends both.
//
// `npm run dev:server` (`--server-only`) starts the server alone and prints
// the two variables, for a dev app started by hand in another terminal:
//
//   CLAVE_SERVER_URL=... CLAVE_SERVER_TOKEN=... npm run dev
//
// The server keeps its data under `~/.clave/server-dev` (`CLAVE_SERVER_DATA`
// to move it); the dev app shares the installed app's user data as `npm run
// dev` does, so pass `-- --user-data-dir=<dir>` for a throwaway one.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServerProcess } from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverOnly = process.argv.includes('--server-only')
const extra = process.argv.slice(2).filter((a) => a !== '--server-only')
const dataDir = process.env.CLAVE_SERVER_DATA ?? path.join(os.homedir(), '.clave', 'server-dev')

const server = await startServerProcess({ repo: REPO, dataDir })
process.stdout.write(`clave-server: ${server.url} (data in ${dataDir})\n`)
process.stdout.write(`CLAVE_SERVER_URL=${server.url}\nCLAVE_SERVER_TOKEN=${server.token}\n`)

let stopping = false
async function stop(code) {
  if (stopping) return
  stopping = true
  await server.stop()
  process.exit(code)
}
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

if (serverOnly) {
  process.stdout.write('clave-server: running; Ctrl-C stops it\n')
} else {
  const dev = spawn('npx', ['electron-vite', 'dev', ...extra], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, CLAVE_SERVER_URL: server.url, CLAVE_SERVER_TOKEN: server.token }
  })
  dev.on('exit', (code) => void stop(code ?? 0))
}
