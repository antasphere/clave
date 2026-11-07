/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable runtime check */
// Run with the repo's Bun after npm run build. All failures exit non-zero.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { connectThroughNode } from '../packages/client/src/node.ts'

const root = resolve(import.meta.dirname, '..')
const scratch = '/tmp/clave-vps-b-impl'
mkdirSync(scratch, { recursive: true, mode: 0o700 })
const dataDir = mkdtempSync(join(scratch, 'daemon-check-'))
const cwd = join(dataDir, 'repo')
mkdirSync(cwd)
let child
let stderr = ''
let stdout = ''
let failure
const clients = []
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
function within(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000)
    })
  ]).finally(() => clearTimeout(timer))
}
async function until(check, message) {
  for (let i = 0; i < 1200; i++) {
    const value = await check()
    if (value) return value
    if (child && child.exitCode !== null)
      throw new Error(`Daemon exited before ${message}: ${stderr.slice(-2000)}`)
    await delay(50)
  }
  throw new Error(`Timed out: ${message}`)
}
async function start() {
  stdout = ''
  stderr = ''
  child = spawn(
    'node',
    [
      join(root, 'out/main/server-entry.js'),
      '--daemon',
      '--host',
      '127.0.0.1',
      '--data-dir',
      dataDir,
      '--terminal-process',
      join(root, 'out/main/terminal-process.js'),
      '--node',
      process.env.CLAVE_DAEMON_NODE ?? 'node',
      '--test-no-activate',
      '--dev-echo-adapter'
    ],
    {
      cwd: root,
      env: { ...process.env, SHELL: '/bin/sh', CLAVE_E2E_NS: 'clave-vps-b-impl' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', (bytes) => {
    stdout += bytes.toString()
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  const discovery = await until(() => {
    try {
      const value = JSON.parse(readFileSync(join(dataDir, 'clave-server.json'), 'utf8'))
      return value.pid === child.pid ? value : null
    } catch {
      return null
    }
  }, 'daemon readiness')
  assert.equal(discovery.daemon, true)
  assert.ok(discovery.serverId)
  assert.ok(!stdout.includes(discovery.token), 'daemon stdout must not expose its token')
  return discovery
}
async function connect(endpoint, name) {
  const client = await connectThroughNode(endpoint, { client: name })
  clients.push(client)
  return client
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const result = await Promise.race([exited, delay(15000).then(() => null)])
  if (!result) {
    child.kill('SIGKILL')
    throw new Error('Daemon did not stop within 15 seconds')
  }
  assert.equal(result[0], 0, `daemon shutdown: ${stderr.slice(-2000)}`)
}

try {
  const first = await start()
  const a = await connect(first, 'mac-a')
  const b = await connect(first, 'mac-b')
  const wrong = await connect({ ...first, token: 'wrong-token' }, 'unauthorized')
  await assert.rejects(wrong.api.sessions.list())
  const layoutBefore = await b.api.sidebar.getLayout('mac-b')
  const created = await a.api.sidebar.createGroup({
    windowKey: 'mac-a',
    group: { id: 'shared-group', name: 'Shared VPS' }
  })
  assert.equal(created.layout.windowKey, 'server')
  assert.equal((await b.api.sidebar.getLayout('mac-b')).groups[0].name, 'Shared VPS')
  await assert.rejects(
    b.api.sidebar.saveLayout({
      windowKey: 'mac-b',
      baseRevision: layoutBefore.revision,
      groups: [],
      displayOrder: []
    })
  )

  const session = await a.api.sessions.start({
    cwd,
    windowKey: 'mac-a',
    options: { claudeMode: false, tmuxMode: true }
  })
  await a.api.sessions.resize(session.id, 100, 30)
  let terminal = ''
  a.push.connect()
  const offA = a.push.subscribe(session.id, (stream) => {
    if (stream.kind === 'pty') terminal += Buffer.from(stream.data).toString()
  })
  await within(a.push.subscribed(session.id), 'client A subscription')
  await until(() => terminal.length > 0, 'initial terminal output')
  const marker = 'server-kept-running'
  await a.api.sessions.write(session.id, {
    type: 'bytes',
    data: Buffer.from(`printf '${marker}\\n'\r`)
  })
  await until(() => terminal.includes(marker), 'terminal write')
  const records = await a.api.sessions.listAdoptable()
  assert.equal(
    records.find((r) => r.id === session.id)?.tmuxName,
    undefined,
    'daemon owns ptys instead of surviving tmux shells'
  )
  await a.api.sidebar.moveItems({
    windowKey: 'mac-a',
    itemIds: [session.id],
    targetId: 'shared-group',
    position: 'inside'
  })
  const journalBefore = readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8')
  offA()
  a.push.close()
  assert.ok((await b.api.sessions.list('mac-b')).some((s) => s.id === session.id))
  let fromB = ''
  b.push.connect()
  b.push.subscribe(session.id, (stream) => {
    if (stream.kind === 'pty') fromB += Buffer.from(stream.data).toString()
  })
  await within(b.push.subscribed(session.id), 'client B subscription')
  await until(() => fromB.includes(marker), 'second client catch-up')
  b.push.close()
  await delay(150)
  assert.equal(child.exitCode, null, 'no attached clients must not end daemon')
  assert.equal(
    readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8'),
    journalBefore,
    'client switches do not spawn processes or write commands'
  )
  await stop()
  assert.ok(
    !existsSync(join(dataDir, 'clave-server.json')),
    'transient discovery removed at shutdown'
  )

  const second = await start()
  assert.equal(second.serverId, first.serverId)
  assert.equal(second.token, first.token)
  const c = await connect(second, 'mac-after-reboot')
  const stopped = (await c.api.sessions.list('new-mac-window')).find((s) => s.id === session.id)
  assert.equal(stopped?.state, 'ended')
  assert.equal(
    (await c.api.sidebar.getLayout('new-mac-window')).groups[0].sessionIds[0],
    session.id
  )
  const beforeSubscribe = readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8')
  let restoredBytes = ''
  c.push.connect()
  c.push.subscribe(session.id, (stream) => {
    if (stream.kind === 'pty') restoredBytes += Buffer.from(stream.data).toString()
  })
  assert.equal(
    (await within(c.push.subscribed(session.id), 'restored subscription')).state,
    'ended'
  )
  await c.api.sessions.resize(session.id, 90, 25)
  await c.api.sessions.history(session.id)
  assert.ok(restoredBytes.includes(marker), 'stopped terminal retains recent scrollback')
  assert.equal(
    readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8'),
    beforeSubscribe,
    'read/subscribe/resize cannot spawn or replay'
  )
  const resumed = await c.api.sessions.restart(session.id, {}, true)
  assert.equal(resumed.id, session.id)
  await c.api.sessions.resize(session.id, 90, 25)
  await until(
    () =>
      readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8').length > beforeSubscribe.length,
    'explicit Resume starts a new shell'
  )
  const afterResume = readFileSync(join(dataDir, 'terminal-journal.jsonl'), 'utf8').slice(
    beforeSubscribe.length
  )
  assert.ok(!afterResume.includes(marker), 'Resume never replays previous shell commands')
  await c.api.sessions.stop(session.id)
  assert.ok(!(await c.api.sessions.list()).some((s) => s.id === session.id))
  assert.ok(!(await c.api.sidebar.getLayout('mac-b')).groups[0].sessionIds.includes(session.id))
  await stop()
  writeFileSync(
    join(dataDir, 'proof.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'wrong token',
          'shared layouts',
          'stale revision',
          'client detach',
          'catch-up',
          'stable identity/token',
          'stopped restore',
          'no implicit spawn',
          'explicit Resume',
          'no shell replay',
          'shared close'
        ]
      },
      null,
      2
    )
  )
  console.log(`Daemon ownership check passed. Private retained fixture: ${dataDir}`)
} catch (error) {
  failure = error
  console.error(error)
  throw error
} finally {
  for (const client of clients) client.push.close()
  await stop().catch((error) => {
    if (!failure) throw error
  })
}
