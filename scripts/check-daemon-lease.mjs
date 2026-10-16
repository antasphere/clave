/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable runtime check */
// Run with Node after npm run build. Holds only its own isolated daemon startups.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = '/tmp/clave-vps-b-impl'
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
const dataDir = fs.mkdtempSync(join(scratch, 'lease-check-'))
fs.mkdirSync(join(dataDir, 'daemon'), { mode: 0o700 })
const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
await once(dead, 'exit')
fs.writeFileSync(join(dataDir, 'daemon/process.json'), JSON.stringify({ pid: dead.pid }), {
  mode: 0o600
})
// A timing barrier at the stale-owner check; product source stays unchanged.
const preload = join(dataDir, 'barrier.mjs')
fs.writeFileSync(
  preload,
  `
import fs from 'node:fs'
const kill = process.kill.bind(process)
process.kill = (pid, signal) => {
  try { return kill(pid, signal) } catch (error) {
    if (pid === ${dead.pid} && signal === 0 && error.code === 'ESRCH') {
      fs.writeFileSync(${JSON.stringify(join(dataDir, 'held'))}, 'held')
      const deadline = Date.now() + 20000
      while (!fs.existsSync(${JSON.stringify(join(dataDir, 'release'))})) {
        if (Date.now() > deadline) throw new Error('Lease barrier timeout')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
    throw error
  }
}
`,
  { mode: 0o600 }
)
const children = []
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

function launch(held = false) {
  const child = spawn(
    process.execPath,
    [
      ...(held ? ['--import', preload] : []),
      join(root, 'out/main/server-entry.js'),
      '--daemon',
      '--data-dir',
      dataDir,
      '--test-no-activate'
    ],
    {
      cwd: root,
      env: { ...process.env, SHELL: '/bin/sh', CLAVE_E2E_NS: 'clave-vps-b-impl' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let errors = ''
  child.stderr.on('data', (data) => {
    errors += data.toString()
  })
  child.stdout.resume()
  const exited = once(child, 'exit')
  children.push({ child, exited })
  return { child, exited, errors: () => errors }
}
async function discovery(pid) {
  return until(() => {
    try {
      const value = JSON.parse(fs.readFileSync(join(dataDir, 'clave-server.json'), 'utf8'))
      return value.pid === pid ? value : null
    } catch {
      return null
    }
  }, 'daemon discovery')
}
try {
  const first = launch(true)
  await until(() => fs.existsSync(join(dataDir, 'held')), 'stale-owner barrier')
  const second = launch()
  const [code] = await within(second.exited, 'contending starter rejection')
  assert.notEqual(code, 0)
  assert.match(second.errors(), /lease transaction already in progress/)
  fs.writeFileSync(join(dataDir, 'release'), 'go')
  const endpoint = await discovery(first.child.pid)
  assert.equal((await fetch(endpoint.url + '/health/live')).status, 200)
  assert.equal(
    JSON.parse(fs.readFileSync(join(dataDir, 'daemon/process.json'), 'utf8')).pid,
    first.child.pid
  )
  // A normal serving crash has no transaction guard and remains recoverable.
  first.child.kill('SIGKILL')
  await within(first.exited, 'owned daemon crash')
  assert.equal(fs.existsSync(join(dataDir, 'daemon/process.guard')), false)
  const recovered = launch()
  const next = await discovery(recovered.child.pid)
  assert.equal(next.serverId, endpoint.serverId)
  assert.equal(next.token, endpoint.token)
  assert.equal((await fetch(next.url + '/health/live')).status, 200)
  fs.writeFileSync(
    join(dataDir, 'proof.json'),
    JSON.stringify(
      {
        passed: true,
        contendingStartupRejected: true,
        servingCrashRecovered: true,
        retainedIdentity: true
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  console.log(`Daemon lease check passed. Private retained fixture: ${dataDir}`)
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGTERM')
    try {
      await within(exited, 'owned daemon shutdown')
    } catch {
      child.kill('SIGKILL')
      await exited
    }
  }
}
