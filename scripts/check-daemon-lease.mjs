/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable runtime check */
// Run with Node after npm run build. Only isolated, exact owned processes are stopped.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = '/tmp/clave-vps-b-impl'
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
const run = fs.mkdtempSync(join(scratch, 'lease-check-'))
const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
await once(dead, 'exit')
const children = []
const passed = []
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function within(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(check, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await delay(20)
  }
  throw new Error(`Timed out: ${label}`)
}
function directory(name, stale = false) {
  const data = join(run, name)
  fs.mkdirSync(data, { mode: 0o700 })
  fs.mkdirSync(join(data, 'daemon'), { mode: 0o700 })
  if (stale)
    fs.writeFileSync(join(data, 'daemon/process.json'), JSON.stringify({ pid: dead.pid }), {
      mode: 0o600
    })
  return data
}
function launch(data, stage) {
  const preload = join(data, 'barrier.mjs')
  if (stage)
    fs.writeFileSync(
      preload,
      `
import fs from 'node:fs'
const stage = ${JSON.stringify(stage)}
let held = false
function hold() {
  if (held) return
  held = true
  fs.writeFileSync(${JSON.stringify(join(data, 'held'))}, 'held')
  const deadline = Date.now() + 30000
  while (!fs.existsSync(${JSON.stringify(join(data, 'release'))})) {
    if (Date.now() > deadline) throw new Error('Lease barrier timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
}
const write = fs.writeFileSync.bind(fs)
fs.writeFileSync = (path, ...args) => {
  const name = String(path)
  if (stage === 'partial-claim' && name.endsWith('.pending')) {
    write(path, '{partial', { mode: 0o600 })
    hold()
    return
  }
  const result = write(path, ...args)
  if (stage === 'intent' && (name.endsWith('/process.guard') || name.endsWith('.claim'))) hold()
  return result
}
const kill = process.kill.bind(process)
process.kill = (pid, signal) => {
  try { return kill(pid, signal) } catch (error) {
    if (stage === 'stale' && pid === ${dead.pid} && signal === 0 && error.code === 'ESRCH') hold()
    throw error
  }
}
const unlink = fs.unlinkSync.bind(fs)
fs.unlinkSync = (path) => {
  const lease = String(path).endsWith('/daemon/process.json')
  if (lease && stage === 'release-before') hold()
  const result = unlink(path)
  if (lease && stage === 'release-after') hold()
  return result
}
`,
      { mode: 0o600 }
    )
  const child = spawn(
    process.execPath,
    [
      ...(stage ? ['--import', preload] : []),
      join(root, 'out/main/server-entry.js'),
      '--daemon',
      '--data-dir',
      data,
      '--test-no-activate'
    ],
    {
      cwd: root,
      env: { ...process.env, SHELL: '/bin/sh', CLAVE_E2E_NS: 'clave-vps-b-impl' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let errors = ''
  child.stderr.on('data', (bytes) => {
    errors += bytes.toString()
  })
  child.stdout.resume()
  const exited = once(child, 'exit')
  const entry = { child, exited, errors: () => errors }
  children.push(entry)
  return entry
}
async function discovery(data, entry) {
  return until(() => {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null)
      throw new Error(`Daemon exited before readiness: ${entry.errors()}`)
    try {
      const value = JSON.parse(fs.readFileSync(join(data, 'clave-server.json'), 'utf8'))
      return value.pid === entry.child.pid ? value : null
    } catch {
      return null
    }
  }, 'daemon discovery')
}
async function healthy(endpoint) {
  assert.equal((await fetch(endpoint.url + '/health/live')).status, 200)
}
async function stop(entry, signal = 'SIGTERM') {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return
  entry.child.kill(signal)
  await within(entry.exited, 'owned daemon stop')
}
async function rejected(entry) {
  const [code] = await within(entry.exited, 'contending starter rejection')
  assert.notEqual(code, 0)
  assert.match(entry.errors(), /already owns|transaction already in progress/)
}
async function held(data) {
  await until(() => fs.existsSync(join(data, 'held')), 'timing barrier')
}
function identity(data) {
  return JSON.parse(fs.readFileSync(join(data, 'daemon/identity.json'), 'utf8'))
}
try {
  // This is intentionally first: the prior permanent guard fails this assertion.
  for (const stale of [false, true]) {
    const data = directory(stale ? 'crash-stale' : 'crash-fresh', stale)
    const first = launch(data, 'intent')
    await held(data)
    await rejected(launch(data))
    await stop(first, 'SIGKILL')
    const recovered = launch(data)
    const endpoint = await discovery(data, recovered)
    await healthy(endpoint)
    await stop(recovered)
    passed.push(stale ? 'stale acquisition crash' : 'fresh acquisition crash')
  }
  // Reproduce the original stale-PID scheduling window without killing either starter.
  {
    const data = directory('concurrent-stale', true)
    const first = launch(data, 'stale')
    await held(data)
    await rejected(launch(data))
    fs.writeFileSync(join(data, 'release'), 'go')
    const endpoint = await discovery(data, first)
    await healthy(endpoint)
    assert.equal(
      JSON.parse(fs.readFileSync(join(data, 'daemon/process.json'), 'utf8')).pid,
      first.child.pid
    )
    await stop(first)
    passed.push('concurrent stale recovery has one owner')
  }
  // A partial process-lease write must never become the published process.json.
  {
    const data = directory('partial-claim')
    const first = launch(data, 'partial-claim')
    await held(data)
    await rejected(launch(data))
    await stop(first, 'SIGKILL')
    const recovered = launch(data)
    await healthy(await discovery(data, recovered))
    await stop(recovered)
    passed.push('partial claim crash')
  }
  for (const stage of ['release-before', 'release-after']) {
    const data = directory(stage)
    const first = launch(data, stage)
    const endpoint = await discovery(data, first)
    await healthy(endpoint)
    const saved = identity(data)
    first.child.kill('SIGTERM')
    await held(data)
    await rejected(launch(data))
    await stop(first, 'SIGKILL')
    const recovered = launch(data)
    const next = await discovery(data, recovered)
    await healthy(next)
    assert.deepEqual(identity(data), saved)
    await stop(recovered)
    passed.push(stage + ' crash and live exclusion')
  }
  {
    const data = directory('serving-crash')
    const first = launch(data)
    const endpoint = await discovery(data, first)
    await stop(first, 'SIGKILL')
    const recovered = launch(data)
    const next = await discovery(data, recovered)
    assert.equal(next.serverId, endpoint.serverId)
    assert.equal(next.token, endpoint.token)
    await healthy(next)
    await stop(recovered)
    passed.push('serving crash retains identity')
  }
  {
    const data = directory('reboot-pid-reuse')
    const first = launch(data)
    const endpoint = await discovery(data, first)
    const lease = JSON.parse(fs.readFileSync(join(data, 'daemon/process.json'), 'utf8'))
    await stop(first)
    const claims = join(data, 'daemon/process-claims')
    const oldBoot = '00000000-0000-0000-0000-000000000000'
    assert.notEqual(oldBoot, lease.bootId)
    const attempt = '11111111-1111-4111-8111-111111111111'
    const stale = join(claims, `${oldBoot}_${process.pid}_${attempt}.claim`)
    fs.writeFileSync(stale, '', { mode: 0o600 })
    fs.writeFileSync(
      join(data, 'daemon/process.json'),
      JSON.stringify({ pid: process.pid, bootId: oldBoot, claimId: attempt }),
      { mode: 0o600 }
    )
    const recovered = launch(data)
    const next = await discovery(data, recovered)
    await healthy(next)
    assert.equal(next.serverId, endpoint.serverId)
    assert.equal(next.token, endpoint.token)
    assert.equal(fs.existsSync(stale), false)
    await stop(recovered)
    // Same boot and same actually live PID must stay conservative.
    const live = join(claims, `${lease.bootId}_${process.pid}_${attempt}.claim`)
    fs.writeFileSync(live, '', { mode: 0o600 })
    await rejected(launch(data))
    assert.equal(fs.existsSync(live), true)
    fs.unlinkSync(live)
    passed.push('previous boot with live reused PID recovers; same boot refuses')
  }
  fs.writeFileSync(
    join(run, 'proof.json'),
    JSON.stringify({ passed: true, checks: passed }, null, 2),
    { mode: 0o600 }
  )
  console.log(`Daemon lease check passed. Private retained fixture: ${run}`)
} finally {
  for (const entry of children) {
    try {
      await stop(entry)
    } catch {
      await stop(entry, 'SIGKILL')
    }
  }
}
