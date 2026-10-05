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

// The dev app, when there is one. Ctrl-C must end the app AND the server, in
// that order: the app first (it deregisters from the server on its way out),
// then the server. `electron-vite` is started from the checkout's own bin, not
// through `npx`, so the signal reaches the process that owns the app; through
// `npx` it did not, and Ctrl-C left the app running after the server had gone
// (found playing lane F's demo, 5 October 2026).
let dev = null
let devExited = null

let stopping = false
/** `forward`: pass the signal on to the app. Not for Ctrl-C: the terminal
 *  already sends SIGINT to the whole foreground group, the app included, and
 *  a second SIGINT on top left the app's quit unfinished (measured). */
async function stop(code, forward) {
  if (stopping) return
  stopping = true
  if (dev && dev.exitCode === null && dev.signalCode === null) {
    if (forward) {
      try {
        dev.kill(forward)
      } catch {
        /* already gone */
      }
    }
    // Bounded: an app that does not quit in 10 s is told again, then killed.
    const again = setTimeout(() => dev.kill('SIGTERM'), 10_000)
    const hard = setTimeout(() => dev.kill('SIGKILL'), 15_000)
    await devExited
    clearTimeout(again)
    clearTimeout(hard)
  }
  await server.stop()
  process.exit(code)
}
process.on('SIGINT', () => void stop(0, null))
process.on('SIGTERM', () => void stop(0, 'SIGTERM'))

if (serverOnly) {
  process.stdout.write('clave-server: running; Ctrl-C stops it\n')
} else {
  dev = spawn(path.join(REPO, 'node_modules', '.bin', 'electron-vite'), ['dev', ...extra], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, CLAVE_SERVER_URL: server.url, CLAVE_SERVER_TOKEN: server.token }
  })
  devExited = new Promise((resolve) => dev.once('exit', () => resolve()))
  // The app quit on its own (Cmd+Q, its last window): the server goes too.
  dev.once('exit', (code) => void stop(code ?? 0))
}
