#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node verification driver */
// Native acceptance only. Requires a committed candidate, development app and explicit device.
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
  existsSync,
  opendirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  constants as fsConstants
} from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { constants as osConstants } from 'node:os'
import { pathToFileURL } from 'node:url'
import { installedCodex, proveCodexProcess, proveSavedProfile } from './mobile-provider-proof.mjs'

/** Build the exact private Maestro file; control fields are serialized separately. */
export function renderNativeFlow(template, values) {
  assert.equal(typeof values.CLEAR_STATE, 'boolean', 'Maestro clearState must be Boolean')
  assert.ok([0, 1].includes(values.REPLY_INDEX), 'Maestro reply index must be zero or one')
  const typed = template
    .replaceAll('${CLEAR_STATE}', String(values.CLEAR_STATE))
    .replaceAll('${REPLY_INDEX}', String(values.REPLY_INDEX))
  return typed.replace(
    'appId: com.clave.app.mobile',
    'appId: com.clave.app.mobile\nenv:\n' +
      Object.entries(values)
        .map(([key, value]) => `  ${key}: ${JSON.stringify(String(value))}`)
        .join('\n')
  )
}

const NATIVE_GUARDS = [
  ['profile.record-count', 'Exactly one server launch record is required'],
  ['profile.session', 'Launch record must name the phone session'],
  ['profile.cwd', 'Launch record must name the selected scratch directory'],
  ['profile.workspace', 'Launch record must name the selected workspace'],
  ['profile.selected-id', 'Server must launch the selected saved profile'],
  ['profile.definition', 'Server must retain the selected profile definition'],
  ['provider.kind', 'Phone session must use Codex'],
  ['provider.adapter', 'Phone session must use the Codex chat adapter'],
  ['provider.transport', 'Phone session must use the events transport'],
  ['provider.cwd', 'Phone session must remain in the selected scratch directory'],
  ['provider.model', 'Provider metadata must match the requested Codex model'],
  ['provider.thread-count', 'All turns must retain one provider thread'],
  ['provider.thread-present', 'A real provider thread is required'],
  [
    'process.installed-executable',
    'Exactly one matching Codex executable must belong to this server'
  ],
  ['process.desktop-pid', 'Desktop must retain the same Codex process'],
  ['provider.desktop-thread', 'Desktop must retain the provider thread']
]

/** Copy only controlled labels and bounded exit metadata, never error/output values. */
export function nativeFailureDiagnostic(error) {
  const status = error?.status
  const signal = error?.signal
  const result = {
    kind: 'runtime',
    guardId: null,
    reason: 'Native verification failed.',
    exit: Number.isInteger(status) && status >= 0 && status <= 255 ? status : null,
    signal: typeof signal === 'string' && Object.hasOwn(osConstants.signals, signal) ? signal : null
  }
  if (error instanceof assert.AssertionError) {
    const guard = NATIVE_GUARDS.find(([, label]) => error.message.startsWith(label))
    return guard
      ? { ...result, kind: 'guard', guardId: guard[0], reason: guard[1] }
      : { ...result, kind: 'assertion', reason: 'Verification assertion failed.' }
  }
  const text = [error?.stdout, error?.stderr, error?.message, error?.code]
    .filter((value) => typeof value === 'string' || Buffer.isBuffer(value))
    .map((value) => String(value))
    .join('\n')
    .slice(-65536)
  const classes = [
    [
      'flow-format',
      /Incorrect Format:|Invalid.*[Ff]low|Unrecognized.*field/,
      'Maestro rejected the generated flow format.'
    ],
    [
      'java',
      /Unable to locate a Java|UnsupportedClassVersion|JAVA_HOME.*invalid/,
      'Maestro Java runtime is unavailable.'
    ],
    [
      'boot',
      /Data Migration Failed|MigrationFailed|Unable to boot|Failed to boot/,
      'Simulator boot or migration failed.'
    ],
    [
      'connect',
      /Connection refused|Failed to connect|Unable to connect|No.*[Dd]evices? found|[Dd]evice.*not.*found/,
      'Native driver could not connect.'
    ],
    ['timeout', /[Tt]imed? ?out|[Tt]imeout|ETIMEDOUT/, 'Native command timed out.'],
    ['ui-assertion', /Assertion is false|[Aa]ssertion.*fail/, 'Native UI assertion failed.'],
    ['http', /answered [45][0-9]{2}/, 'Server HTTP request failed.']
  ]
  const classification = classes.find(([, expression]) => expression.test(text))
  if (classification) return { ...result, kind: classification[0], reason: classification[2] }
  if (
    result.exit !== null ||
    result.signal !== null ||
    ['ENOENT', 'EACCES', 'ENOBUFS'].includes(error?.code)
  )
    return { ...result, kind: 'command', reason: 'Native command failed.' }
  return result
}

const NATIVE_COMMANDS = new Set([
  'launchAppCommand',
  'tapOnElement',
  'assertConditionCommand',
  'inputTextCommand',
  'hideKeyboardCommand'
])
const NATIVE_SELECTOR_IDS = new Set([
  'developer-connection',
  'developer-url',
  'developer-token',
  'developer-connect',
  'machine-row-dev:.*',
  'new-session',
  'composer-input',
  'composer-send'
])

/** Project only fixed command/selector names from bounded private status files. */
export function nativeFailedStep(directory) {
  const failures = []
  let visited = 0
  let bytes = 0
  let files = 0
  const visit = (dir, depth) => {
    const inventory = opendirSync(dir)
    try {
      for (let entry; (entry = inventory.readSync()) !== null; ) {
        if (++visited > 64) throw new Error('Status inventory exceeds bound')
        if (entry.isSymbolicLink()) continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory() && depth < 3) visit(file, depth + 1)
        if (!entry.isFile() || !/^commands(?:-[^/\\]{1,120})?\.json$/.test(entry.name)) continue
        if (++files > 8) throw new Error('Status file count exceeds bound')
        const fd = openSync(
          file,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
        )
        let body
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.size > 1024 * 1024 || (bytes += stat.size) > 2 * 1024 * 1024)
            throw new Error('Status data exceeds bound')
          const buffer = Buffer.alloc(stat.size + 1)
          let offset = 0
          while (offset < buffer.length) {
            const count = readSync(fd, buffer, offset, buffer.length - offset, null)
            if (count === 0) break
            offset += count
          }
          if (offset > stat.size) throw new Error('Status file grew during read')
          body = buffer.toString('utf8', 0, offset)
        } finally {
          closeSync(fd)
        }
        let entries
        try {
          entries = JSON.parse(body)
        } catch {
          continue
        }
        if (!Array.isArray(entries) || entries.length > 512) continue
        for (const entry of entries) {
          const sequence = entry?.metadata?.sequenceNumber
          if (
            entry?.metadata?.status !== 'FAILED' ||
            !Number.isInteger(sequence) ||
            sequence < 0 ||
            sequence >= 512
          )
            continue
          const command = entry.command
          if (!command || typeof command !== 'object' || Array.isArray(command)) continue
          const kinds = Object.keys(command).filter(
            (kind) =>
              NATIVE_COMMANDS.has(kind) &&
              command[kind] !== null &&
              typeof command[kind] === 'object' &&
              !Array.isArray(command[kind])
          )
          if (kinds.length !== 1) continue
          const kind = kinds[0]
          const id =
            command[kind]?.selector?.idRegex ??
            command[kind]?.condition?.visible?.idRegex ??
            command[kind]?.condition?.notVisible?.idRegex
          failures.push({
            ordinal: sequence + 1,
            kind,
            selectorId: NATIVE_SELECTOR_IDS.has(id) ? id : null
          })
        }
      }
    } finally {
      inventory.closeSync()
    }
  }
  try {
    if (lstatSync(directory).isSymbolicLink()) return null
    visit(directory, 0)
    return failures.sort((a, b) => a.ordinal - b.ordinal)[0] ?? null
  } catch {
    return null
  }
}

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
    tree: sh('git', ['rev-parse', 'HEAD^{tree}'], { cwd: o.worktree }),
    worktree: o.worktree,
    marker: o.marker,
    device: o['ios-udid'] ?? o['android-serial'],
    provider:
      o.provider === 'echo'
        ? 'echo fixture'
        : 'codex Mac login, default account; adapter, live executable and provider thread required',
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
    providerProcess: 'NOT RUN',
    launchRecord: 'NOT RUN',
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
    const codex = o.provider === 'codex' ? installedCodex() : null
    const profile = o.provider === 'echo' ? 'dev-echo-adapter' : 'chat:codex:mobile-beta-codex'
    // Upsert the editable source. The host derives its reserved chat variant.
    if (o.provider === 'codex')
      await call(server.url, server.token, 'POST', '/launch-profiles', {
        profile: {
          id: 'mobile-beta-codex',
          name: 'Mobile beta Codex',
          family: 'codex',
          command: [codex.executable],
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
      CLEAR_STATE: Boolean(o['ios-udid'])
    }
    let flow = readFileSync(path.join(o.worktree, 'packages/mobile/e2e/beta-provider.yaml'), 'utf8')
    flow = renderNativeFlow(flow, values)
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
    phase = 'server-launch-record'
    receipt.launchRecord = proveSavedProfile({
      records: await call(
        server.url,
        server.token,
        'GET',
        `/sessions/records?ids=${encodeURIComponent(session.id)}`
      ),
      sessionId: session.id,
      selected: prefs.customProfiles.find((p) => p.id === profile),
      workspaceId: workspace.id,
      scratch: o.scratch,
      requireDefinition: o.provider === 'codex'
    })
    const history = await call(
      server.url,
      server.token,
      'GET',
      `/sessions/history?id=${encodeURIComponent(session.id)}&limit=2000`
    )
    checkHistory(history, prompts, replies)
    if (o.provider === 'codex') {
      phase = 'provider-process'
      receipt.providerProcess = proveCodexProcess({
        serverPid: server.pid,
        scratch: o.scratch,
        expected: codex,
        session,
        history
      })
    }
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
    if (o.provider === 'codex') {
      const after = proveCodexProcess({
        serverPid: server.pid,
        scratch: o.scratch,
        expected: codex,
        session,
        history: visibleHistory
      })
      assert.equal(
        after.pid,
        receipt.providerProcess.pid,
        'Desktop must retain the same Codex process'
      )
      assert.equal(
        after.threadId,
        receipt.providerProcess.threadId,
        'Desktop must retain the provider thread'
      )
    }
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
  } catch (error) {
    receipt.failure = { phase, ...nativeFailureDiagnostic(error) }
    if (phase === 'phone-maestro') receipt.failure.step = nativeFailedStep(privateDir)
    receipt.status = `FAIL at ${phase}: ${receipt.failure.reason}`
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
