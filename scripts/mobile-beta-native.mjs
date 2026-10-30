#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node verification driver */
// Native acceptance only. Requires a committed candidate, prebuilt app and running explicit device.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  rmSync,
  realpathSync,
  existsSync
} from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv) {
  const required = [
    'worktree',
    'candidate',
    'marker',
    'metro-port',
    'server-port',
    'relay-port',
    'data',
    'scratch',
    'app',
    'provider',
    'output'
  ]
  const allowed = new Set([...required, 'ios-udid', 'android-serial'])
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    assert.ok(argv[i].startsWith('--') && allowed.has(key), `Unknown option ${argv[i]}`)
    assert.ok(
      argv[i + 1] && !argv[i + 1].startsWith('--') && !(key in result),
      `Missing or repeated ${key}`
    )
    result[key] = argv[i + 1]
  }
  for (const key of required) assert.ok(result[key], `Required --${key}`)
  assert.ok(
    Boolean(result['ios-udid']) !== Boolean(result['android-serial']),
    'Choose exactly one explicit device'
  )
  assert.ok(['echo', 'codex'].includes(result.provider), 'Provider must be echo or codex')
  assert.match(result.candidate, /^[a-f0-9]{40}$/)
  assert.match(result.marker, /^[a-zA-Z0-9-]{8,64}$/)
  if (result['android-serial'])
    assert.ok(
      ['emulator-5562', 'emulator-5564', 'emulator-5566'].includes(result['android-serial']),
      'Only lane D, its verifier or the wave device is authorized'
    )
  if (result['ios-udid'])
    assert.ok(
      [
        '03E3DD24-8CAD-4A8D-A398-272FA2CAFB6D',
        'D31B48A1-7A95-4B18-9110-35244F9880BA',
        '756BEEB5-D739-43DD-B037-50AE0D43E4AB'
      ].includes(result['ios-udid']),
      'Only lane D, its verifier or the wave device is authorized'
    )
  const ports = ['metro-port', 'server-port', 'relay-port'].map((key) => {
    const port = Number(result[key])
    assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, `Invalid ${key}`)
    return port
  })
  assert.equal(new Set(ports).size, 3, 'Ports must differ')
  for (const key of ['worktree', 'data', 'scratch', 'app', 'output'])
    assert.ok(path.isAbsolute(result[key]), `${key} must be absolute`)
  return result
}
const sh = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  }).trim()
const sha = (data) => createHash('sha256').update(data).digest('hex')
function artifactHash(root) {
  const hash = createHash('sha256')
  const visit = (file, relative) => {
    const stat = lstatSync(file)
    hash.update(`${relative}\0`)
    if (stat.isSymbolicLink()) hash.update(readlinkSync(file))
    else if (stat.isDirectory())
      for (const entry of readdirSync(file).sort())
        visit(path.join(file, entry), `${relative}/${entry}`)
    else hash.update(readFileSync(file))
  }
  visit(root, '.')
  return hash.digest('hex')
}
async function freePort(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), '0.0.0.0', resolve)
  })
  await new Promise((resolve) => server.close(resolve))
}
async function wait(check, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out waiting for owned runtime')
}
function cleanHead(o) {
  assert.equal(
    sh('git', ['rev-parse', 'HEAD'], { cwd: o.worktree }),
    o.candidate,
    'Candidate differs from target HEAD'
  )
  assert.equal(
    sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: o.worktree }),
    '',
    'Target tree must be clean'
  )
}
function checkHistory(page, prompts, replies) {
  const events = page.items.map((item) => item.event)
  const users = events.filter((e) => e.type === 'user_message').map((e) => e.text)
  for (const prompt of prompts) assert.ok(users.includes(prompt), 'Missing exact phone prompt')
  const answers = []
  let current = ''
  for (const event of events)
    if (event.type === 'assistant_text') {
      current += event.delta
      if (event.final) {
        answers.push(current.trim())
        current = ''
      }
    }
  for (const reply of replies)
    assert.ok(answers.includes(reply), 'Missing exact completed provider response')
}
async function main(o) {
  o.worktree = realpathSync(o.worktree)
  cleanHead(o)
  // New directories are mandatory: no reuse of live data or another run's marker.
  for (const key of ['data', 'scratch', 'output']) {
    assert.ok(!existsSync(o[key]), `${key} must be a new run directory`)
    assert.ok(!o[key].startsWith(`${o.worktree}/`), `${key} must be outside the source tree`)
  }
  assert.ok(
    o['ios-udid'] ? o.app.endsWith('.app') : o.app.endsWith('.apk'),
    'Explicit matching native artifact required'
  )
  const receipt = {
    candidate: o.candidate,
    worktree: o.worktree,
    marker: o.marker,
    device: o['ios-udid'] ?? o['android-serial'],
    provider:
      o.provider === 'echo'
        ? 'echo fixture'
        : 'codex Mac login, default account; model verified from history',
    ports: {
      metro: Number(o['metro-port']),
      server: Number(o['server-port']),
      relay: Number(o['relay-port'])
    },
    relay: 'NOT RUN: developer connection does not prove relay or enrollment',
    status: 'NOT RUN',
    phone: 'NOT RUN',
    serverHistory: 'NOT RUN',
    desktop: 'NOT RUN',
    source: 'NOT RUN',
    screenshot: 'NOT RUN',
    lockfileSha256: sha(readFileSync(path.join(o.worktree, 'package-lock.json'))),
    artifactSha256: artifactHash(o.app)
  }
  for (const key of ['data', 'scratch', 'output'])
    mkdirSync(o[key], { recursive: true, mode: 0o700 })
  const save = () =>
    writeFileSync(path.join(o.output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  save()
  let server, metro, desktop
  const privateDir = path.join(o.output, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const interrupted = () => {
    metro?.kill('SIGTERM')
    server?.child.kill('SIGTERM')
    desktop?.app.process().kill('SIGTERM')
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  let phase = 'ports'
  try {
    for (const key of ['metro-port', 'server-port', 'relay-port']) await freePort(o[key])
    const load = (file) => import(pathToFileURL(path.join(o.worktree, file)).href)
    const { startDevServer, ensureWorkspace, call } = await load(
      'packages/mobile/scripts/dev-server.mjs'
    )
    const { proveNativeSource } = await load('packages/mobile/scripts/native-provenance.mjs')
    phase = 'server-workspace-profiles'
    server = await startDevServer({
      port: Number(o['server-port']),
      dataDir: o.data,
      echo: o.provider === 'echo',
      log: () => {}
    })
    const workspace = await ensureWorkspace(server.url, server.token, o.scratch, o.marker)
    const profile = o.provider === 'echo' ? 'dev-echo-adapter' : 'chat:codex:mobile-beta-codex'
    // Upsert the editable source. The host derives its reserved chat variant.
    if (o.provider === 'codex')
      await call(server.url, server.token, 'POST', '/launch-profiles', {
        profile: {
          id: 'mobile-beta-codex',
          name: 'Mobile beta Codex',
          family: 'codex',
          command: ['codex'],
          additionalArgs: ['-c', 'model="gpt-6.1-sol"']
        }
      })
    const prefs = await call(server.url, server.token, 'GET', '/launch-profiles')
    assert.ok(
      prefs.customProfiles.some((p) => p.id === profile),
      'Saved native launch profile missing'
    )
    assert.equal(
      (await call(server.url, server.token, 'GET', '/sessions')).length,
      0,
      'Fresh server must have no sessions'
    )
    const env = { ...process.env, CI: '1' }
    if (!env.JAVA_HOME && existsSync('/opt/homebrew/opt/openjdk@21'))
      env.JAVA_HOME = '/opt/homebrew/opt/openjdk@21'
    phase = 'metro'
    metro = spawn(
      process.execPath,
      [
        path.join(o.worktree, 'node_modules/.bin/expo'),
        'start',
        '--clear',
        '--port',
        o['metro-port']
      ],
      { cwd: path.join(o.worktree, 'packages/mobile'), env, stdio: 'ignore' }
    )
    await wait(async () =>
      (
        await (
          await fetch(`http://127.0.0.1:${o['metro-port']}/status`, {
            signal: AbortSignal.timeout(3000)
          })
        ).text()
      ).includes('packager-status:running')
    )
    phase = 'device-install-binding'
    let deviceName
    if (o['ios-udid']) {
      const devices = Object.values(
        JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '--json'])).devices
      ).flat()
      const device = devices.find((d) => d.udid === o['ios-udid'])
      assert.equal(device?.state, 'Booted', 'Explicit simulator must already be booted')
      deviceName = device.name
      sh('xcrun', ['simctl', 'install', o['ios-udid'], o.app])
    } else {
      assert.equal(sh('adb', ['-s', o['android-serial'], 'get-state']), 'device')
      deviceName = sh('adb', ['-s', o['android-serial'], 'shell', 'getprop', 'ro.product.model'])
      sh('adb', ['-s', o['android-serial'], 'install', '-r', o.app])
      for (const port of [o['metro-port'], o['server-port']])
        sh('adb', ['-s', o['android-serial'], 'reverse', `tcp:${port}`, `tcp:${port}`])
      sh('adb', ['-s', o['android-serial'], 'shell', 'pm', 'clear', 'com.clave.app.mobile'])
      // React Native's PackagerConnectionSettings reads this preference, no expo-dev-client needed.
      const preferences = `<map><string name="debug_http_host">127.0.0.1:${o['metro-port']}</string></map>`
      sh(
        'adb',
        [
          '-s',
          o['android-serial'],
          'shell',
          'run-as',
          'com.clave.app.mobile',
          'sh',
          '-c',
          "'mkdir -p shared_prefs && cat > shared_prefs/com.clave.app.mobile_preferences.xml'"
        ],
        { input: preferences }
      )
    }
    const replies = [1, 2].map((n) => `${o.marker}-reply-${n}`)
    const prompts = replies.map((reply) =>
      o.provider === 'echo' ? reply : `Reply with exactly ${reply}`
    )
    const values = {
      METRO_PORT: o['metro-port'],
      SERVER_URL: server.url,
      SERVER_TOKEN: server.token,
      WORKSPACE_ID: workspace.id,
      PROFILE_ID: profile,
      PROMPT_ONE: prompts[0],
      PROMPT_TWO: prompts[1],
      REPLY_ONE: replies[0],
      REPLY_TWO: replies[1],
      REPLY_INDEX: o.provider === 'echo' ? 1 : 0,
      CLEAR_STATE: o['ios-udid'] ? 'true' : 'false'
    }
    let flow = readFileSync(path.join(o.worktree, 'packages/mobile/e2e/beta-provider.yaml'), 'utf8')
    flow = flow.replace(
      'appId: com.clave.app.mobile',
      'appId: com.clave.app.mobile\nenv:\n' +
        Object.entries(values)
          .map(([key, value]) => `  ${key}: ${JSON.stringify(String(value))}`)
          .join('\n')
    )
    const flowFile = path.join(privateDir, 'flow.yaml')
    writeFileSync(flowFile, flow, { mode: 0o600 })
    // Suppress all Maestro output and remove its artifacts, including credential screenshots.
    phase = 'phone-maestro'
    sh(
      'maestro',
      [
        '--udid',
        receipt.device,
        'test',
        flowFile,
        '--debug-output',
        privateDir,
        '--test-output-dir',
        privateDir
      ],
      { env, timeout: 600000 }
    )
    receipt.phone = 'PASS: native saved-profile launch and two response assertions'
    phase = 'server-history'
    const sessions = await call(server.url, server.token, 'GET', '/sessions')
    assert.equal(sessions.length, 1, 'Phone must create exactly one session')
    const session = sessions[0]
    assert.equal(session.cwd, o.scratch)
    receipt.sessionId = session.id
    const history = await call(
      server.url,
      server.token,
      'GET',
      `/sessions/history?id=${encodeURIComponent(session.id)}&limit=2000`
    )
    checkHistory(history, prompts, replies)
    if (o.provider === 'codex')
      assert.ok(
        history.items.some(
          ({ event }) => event.type === 'session_meta' && event.model === 'gpt-6.1-sol'
        ),
        'Codex must report required gpt-6.1-sol model'
      )
    receipt.serverHistory = 'PASS'
    phase = 'desktop-history'
    const { launchApp } = await load('tests/e2e/harness.mjs')
    desktop = await launchApp(path.join(o.output, 'desktop'), {
      server: { url: server.url, token: server.token }
    })
    const visibleHistory = await desktop.win.evaluate(async (id) => {
      const session = await window.electronAPI.sessionsSubscribe(id)
      if (session.id !== id) throw new Error('Phone session absent from attached desktop')
      return window.electronAPI.sessionsHistory(id, undefined, 2000)
    }, session.id)
    checkHistory(visibleHistory, prompts, replies)
    receipt.desktop = 'PASS: hidden attached Electron sees same session and history'
    phase = 'native-source'
    receipt.source = await proveNativeSource({ port: Number(o['metro-port']), deviceName })
    assert.equal(receipt.source.candidate, o.candidate)
    assert.equal(realpathSync(receipt.source.worktree), path.join(o.worktree, 'packages/mobile'))
    cleanHead(o)
    phase = 'sanitized-screenshot'
    const screenshot = path.join(o.output, 'phone-pass.png')
    if (o['ios-udid']) sh('xcrun', ['simctl', 'io', o['ios-udid'], 'screenshot', screenshot])
    else
      writeFileSync(
        screenshot,
        execFileSync('adb', ['-s', o['android-serial'], 'exec-out', 'screencap', '-p'])
      )
    receipt.screenshot = screenshot
    receipt.status = 'PASS'
  } catch {
    receipt.status = `FAIL at ${phase}: acceptance incomplete; private runtime output suppressed`
    throw new Error(receipt.status)
  } finally {
    save()
    rmSync(privateDir, { recursive: true, force: true })
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    await desktop?.app.close().catch(() => {})
    if (metro) {
      metro.kill('SIGTERM')
      await new Promise((resolve) => {
        if (metro.exitCode !== null || metro.signalCode !== null) return resolve()
        const timer = setTimeout(() => metro.kill('SIGKILL'), 8000)
        metro.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await server?.stop()
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main(parseArgs(process.argv.slice(2))).catch(() => {
    console.error('Native acceptance failed; inspect sanitized receipt when created.')
    process.exitCode = 1
  })
