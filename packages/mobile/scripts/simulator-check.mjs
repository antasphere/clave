#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by npm run check:simulator */
// The automated check on the iOS simulator: it can fail, and it did once on
// purpose (docs/mobile.md, "The simulator check"). It starts a standalone
// Clave server of its own with the Echo adapter (a fixture, not a real
// provider), seeds a workspace and an Echo chat holding a message with a
// nonce, boots the iPhone 17 Pro simulator, installs the development build
// `npx expo run:ios` made, starts Metro, and runs the Maestro flow
// `e2e/chat.yaml`, which reaches the chat, asserts the seeded text and the
// Echo's repeat of a reply typed on the phone. Exits with Maestro's code;
// stops only what it started.
//
//   node scripts/simulator-check.mjs [--device "iPhone 17 Pro"] [--metro-port 8081]
//                                    [--server-port 0] [--app <path to Clave.app>]
//
// Needs: Xcode with the iOS 26 simulator, Maestro on the PATH (or at
// /opt/homebrew/bin/maestro) with JAVA_HOME set to a JDK, and the app built
// once with `npx expo run:ios --device "iPhone 17 Pro"`.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { call, ensureWorkspace, startDevServer } from './dev-server.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NS = process.env.CLAVE_E2E_NS ?? 'clave-mobile-c'
const ROOT = `/tmp/${NS}/simulator-check`

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const log = (line) => process.stderr.write(`[simulator-check] ${line}\n`)
const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim()

/** The udid of the named simulator, booted. */
function bootSimulator(name) {
  const list = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'available', '--json']))
  const devices = Object.values(list.devices).flat()
  const device = devices.find((d) => d.name === name)
  if (!device)
    throw new Error(
      `no simulator named "${name}" (available: ${devices.map((d) => d.name).join(', ')})`
    )
  if (device.state !== 'Booted') {
    log(`booting ${name} (${device.udid})`)
    sh('xcrun', ['simctl', 'boot', device.udid])
  }
  sh('xcrun', ['simctl', 'bootstatus', device.udid, '-b'])
  return device.udid
}

/** Where `expo run:ios` left the development build: Xcode's DerivedData
 *  (`Clave-<hash>/Build/Products/Debug-iphonesimulator/Clave.app`, the newest
 *  when several), or `ios/build` for a build made with `-derivedDataPath`;
 *  null when neither holds one. */
function findApp() {
  const given = arg('app', null)
  if (given) return given
  const candidates = []
  const derived = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData')
  const roots = []
  if (existsSync(derived))
    for (const project of readdirSync(derived))
      if (project.startsWith('Clave-')) roots.push(path.join(derived, project, 'Build', 'Products'))
  roots.push(path.join(PKG, 'ios', 'build', 'Build', 'Products'))
  for (const products of roots) {
    if (!existsSync(products)) continue
    for (const dir of readdirSync(products))
      if (dir.endsWith('-iphonesimulator')) {
        const app = path.join(products, dir, 'Clave.app')
        if (existsSync(app)) candidates.push({ app, at: statSync(app).mtimeMs })
      }
  }
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]?.app ?? null
}

/** The copy already installed on the simulator, when no build is on disk. */
function installedApp(udid) {
  try {
    return sh('xcrun', ['simctl', 'get_app_container', udid, 'com.clave.app.mobile'])
  } catch {
    return null
  }
}

function findMaestro() {
  for (const candidate of ['maestro', '/opt/homebrew/bin/maestro'])
    try {
      sh(candidate, ['--version'], { env: metroEnv() })
      return candidate
    } catch {
      /* next */
    }
  throw new Error(
    'Maestro was not found: brew install mobile-dev-inc/tap/maestro, and set JAVA_HOME (docs/mobile.md)'
  )
}

/** The environment the tools run in: a JDK for Maestro, the Android SDK for nothing here. */
function metroEnv() {
  const env = { ...process.env, CI: '1' }
  if (!env.JAVA_HOME && existsSync('/opt/homebrew/opt/openjdk'))
    env.JAVA_HOME = '/opt/homebrew/opt/openjdk'
  if (env.JAVA_HOME) env.PATH = `${env.JAVA_HOME}/bin:${env.PATH}`
  return env
}

async function waitFor(check, { timeoutMs, everyMs = 500, what }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function main() {
  const device = arg('device', 'iPhone 17 Pro')
  const metroPort = Number(arg('metro-port', '8081'))
  const serverPort = Number(arg('server-port', '0'))
  const maestro = findMaestro()
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })

  // 1. A server of the check's own, with the Echo fixture on.
  const server = await startDevServer({
    port: serverPort,
    dataDir: path.join(ROOT, 'server'),
    echo: true,
    log
  })
  const stops = [server.stop]
  let metro = null
  try {
    const scratch = path.join(ROOT, 'scratch')
    const workspace = await ensureWorkspace(server.url, server.token, scratch, 'scratch')
    const nonce = randomBytes(4).toString('hex')
    const historyText = `seeded-${nonce}`
    const replyText = `reply-${nonce}`
    const session = await call(server.url, server.token, 'POST', '/sessions/start', {
      cwd: scratch,
      options: { claudeMode: true, launchProfileId: 'dev-echo-adapter', workspaceId: workspace.id }
    })
    await call(server.url, server.token, 'POST', '/sessions/write', {
      id: session.id,
      input: { type: 'user_message', text: historyText, clientMessageId: `m-check-${nonce}` }
    })
    log(`server ${server.url}, Echo chat ${session.id} seeded with "${historyText}"`)

    // 2. The simulator and the app: the build on disk, else the copy installed.
    const udid = bootSimulator(device)
    const app = findApp()
    if (app) {
      log(`installing ${app}`)
      sh('xcrun', ['simctl', 'install', udid, app])
    } else if (installedApp(udid)) log('no build on disk; using the copy installed on the simulator')
    else {
      log('no development build: run `npx expo run:ios --device "iPhone 17 Pro"` first (docs/mobile.md)')
      process.exit(2)
    }
    try {
      sh('xcrun', ['simctl', 'terminate', udid, 'com.clave.app.mobile'])
    } catch {
      /* not running */
    }

    // 3. Metro, for the development build.
    metro = spawn('npx', ['expo', 'start', '--port', String(metroPort)], {
      cwd: PKG,
      env: metroEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    metro.stdout.on('data', (d) => log(`metro: ${String(d).trim().split('\n')[0]}`))
    metro.stderr.on('data', (d) => log(`metro: ${String(d).trim().split('\n')[0]}`))
    await waitFor(
      async () =>
        (await (await fetch(`http://127.0.0.1:${metroPort}/status`)).text()).includes(
          'packager-status:running'
        ),
      { timeoutMs: 90_000, what: 'Metro' }
    )
    log(`Metro on ${metroPort}`)

    // 4. The flow. Maestro's exit code is the verdict.
    const started = Date.now()
    const result = spawn(
      maestro,
      [
        '--udid',
        udid,
        'test',
        path.join(PKG, 'e2e', 'chat.yaml'),
        '--env',
        `SERVER_URL=${server.url}`,
        '--env',
        `SERVER_TOKEN=${server.token}`,
        '--env',
        `HISTORY_TEXT=${historyText}`,
        '--env',
        `REPLY_TEXT=${replyText}`,
        '--debug-output',
        path.join(PKG, 'e2e', '.output')
      ],
      { cwd: PKG, env: metroEnv(), stdio: ['ignore', 'inherit', 'inherit'] }
    )
    const code = await new Promise((resolve) => result.once('exit', (c) => resolve(c ?? 1)))
    log(`maestro exited ${code} after ${((Date.now() - started) / 1000).toFixed(0)} s`)
    process.exitCode = code
  } finally {
    if (metro) metro.kill('SIGTERM')
    for (const stop of stops) await stop()
  }
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
