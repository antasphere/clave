/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import {
  decodeIdentityRows,
  captureOwnedInventory,
  validateOwnershipRunner,
  verifyOwnershipFixture,
  OWNERSHIP_FIXTURE_SOURCES,
  unprovenIdentityEvidence,
  processIdentity,
  identifyOwnedProcess,
  captureResourceWorker,
  resourceWorkerExit,
  resourceWorkerForCleanup
} from './renderer-resource.mjs'

const uid = process.getuid()
const ok = (stdout) => ({
  status: 0,
  signal: null,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0)
})
const textRow = (
  pid = 200,
  ppid = 100,
  created = 'Tue Oct 20 22:08:08 2026',
  name = 'unit-child',
  realUid = uid
) => `${realUid} ${pid} ${ppid} ${created}     ${name.padEnd(16)}\n`
const row = (...args) => ok(textRow(...args))
const parent = {
  ...decodeIdentityRows(
    Buffer.from(textRow(100, 50, 'Tue Oct 20 22:08:07 2026', 'unit-node')),
    uid
  ).get(100),
  role: 'main'
}
const gone = () => ({ status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
function context(role = 'descendant') {
  const owned = new Map([[parent.pid, parent]]),
    receipts = []
  return {
    owned,
    receipts,
    own: (query, pid = 200, expectedParent = 100) =>
      identifyOwnedProcess(
        owned,
        pid,
        role,
        expectedParent,
        { site: 'unit.inventory.pgrep-child', discoveredParent: parent, discoveredChildren: [200] },
        (r) => receipts.push(r),
        query
      )
  }
}
describe('strict resource ownership evidence, no actual OS process or app', () => {
  for (const role of ['main', 'server', 'terminal-process', 'renderer', 'descendant', 'utility'])
    it(`never skips an unavailable ${role}; records attempted identity before throwing`, () => {
      const c = context(role)
      expect(() => c.own(gone)).toThrow('owned process is alive when identified')
      expect(c.owned.has(200)).toBe(false)
      expect(c.receipts).toHaveLength(1)
      expect(c.receipts[0]).toMatchObject({
        pid: 200,
        role,
        expectedParent: 100,
        expectedParentIdentity: parent,
        context: { site: 'unit.inventory.pgrep-child', discoveredParent: parent },
        query: { command: '/bin/ps', status: 1, signal: null, stdoutBytes: 0, stderrBytes: 0 },
        observedIdentity: null,
        later: 'NOTRUN'
      })
    })
  it('uses actual successful query bytes and keeps the existing role', () => {
    const c = context()
    c.own(() => row())
    c.own(() => row())
    expect(c.owned.get(200)).toMatchObject({
      pid: 200,
      parent: 100,
      creation: 'Tue Oct 20 22:08:08 2026',
      commandName: 'unit-child'.padEnd(16),
      commandSource: 'ps.ucomm',
      schema: 2,
      role: 'descendant'
    })
    expect(c.receipts).toEqual([])
  })
  it('refuses parent mismatch without overwriting the owned map', () => {
    const c = context()
    expect(() => c.own(() => row(200, 999))).toThrow('proven owned child')
    expect(c.owned.has(200)).toBe(false)
    expect(c.receipts[0].observedIdentity.parent).toBe(999)
  })
  it('refuses PID creation reuse without replacing its earlier record', () => {
    const c = context()
    c.own(() => row())
    const original = c.owned.get(200)
    expect(() => c.own(() => row(200, 100, 'Tue Oct 20 22:08:09 2026'))).toThrow('owned PID reused')
    expect(c.owned.get(200)).toBe(original)
    expect(c.receipts[0].previousIdentity).toBe(original)
  })
  for (const [name, query] of [
    ['malformed successful response', () => 'not a creation identity\n'],
    ['wrong returned PID', () => row(201)],
    [
      'permission error status1',
      () => {
        throw Object.assign(new Error('permission'), {
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'ps: permission denied\n'
        })
      }
    ],
    [
      'partial status1 response',
      () => {
        throw Object.assign(new Error('partial'), {
          status: 1,
          signal: null,
          stdout: row(),
          stderr: ''
        })
      }
    ],
    [
      'query timeout',
      () => {
        throw Object.assign(new Error('timeout'), {
          status: null,
          signal: 'SIGTERM',
          code: 'ETIMEDOUT',
          stdout: '',
          stderr: ''
        })
      }
    ],
    [
      'missing OS tool',
      () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    ]
  ])
    it(`keeps ${name} unknown/failing instead of absent or accepted`, () => {
      const c = context()
      expect(() => c.own(query)).toThrow()
      expect(c.owned.has(200)).toBe(false)
      expect(c.receipts).toHaveLength(1)
      expect(c.receipts[0].pid).toBe(200)
      expect(c.receipts[0].query).not.toBeNull()
    })
  it('captures parent-spawn identity synchronously and records exact numeric exit afterward', () => {
    const writes = []
    let queries = 0
    const worker = captureResourceWorker(
      200,
      100,
      { site: 'parent.spawn', side: 'control', index: 2 },
      (r) => writes.push(r),
      () => {
        queries++
        return row()
      }
    )
    expect(writes).toHaveLength(1)
    expect(queries).toBe(1)
    expect(worker.identity).toMatchObject({
      pid: 200,
      parent: 100,
      creation: 'Tue Oct 20 22:08:08 2026'
    })
    const exit = resourceWorkerExit(worker, 0, null, false)
    expect(exit).toMatchObject({ code: 0, signal: null, expired: false, accepted: true })
    expect(exit.identity).toBe(worker.identity)
  })
  it('never reconstructs a missing initial worker creation from an exit0 or a later lookup', () => {
    const writes = []
    let queries = 0
    const worker = captureResourceWorker(
      200,
      100,
      { site: 'parent.spawn' },
      (r) => writes.push(r),
      (...args) => {
        queries++
        return gone(...args)
      }
    )
    expect(worker.identity).toBeNull()
    expect(worker.failure).not.toBeNull()
    expect(writes).toHaveLength(1)
    expect(resourceWorkerExit(worker, 0, null, false).accepted).toBe(false)
    expect(
      resourceWorkerForCleanup(worker, {
        pid: 200,
        parent: 100,
        creation: 'Tue Oct 20 22:08:09 2026'
      })
    ).toBeNull()
    expect(queries).toBe(1)
  })
  it('accepts no nonzero, signaled, expired or nonnumeric child completion', () => {
    const worker = captureResourceWorker(
      200,
      100,
      { site: 'parent.spawn' },
      () => {},
      () => row()
    )
    for (const [code, signal, expired] of [
      [1, null, false],
      [null, 'SIGTERM', false],
      [0, null, true],
      [null, null, false],
      ['0', null, false]
    ])
      expect(resourceWorkerExit(worker, code, signal, expired).accepted).toBe(false)
  })
  it('deadline signaling eligibility never adopts a reused or reparented worker PID', () => {
    const worker = captureResourceWorker(
      200,
      100,
      { site: 'parent.spawn' },
      () => {},
      () => row()
    )
    expect(resourceWorkerForCleanup(worker, worker.identity)).toBe(worker.identity)
    expect(resourceWorkerForCleanup(worker, null)).toBeNull()
    expect(
      resourceWorkerForCleanup(worker, { ...worker.identity, creation: 'Tue Oct 20 22:08:09 2026' })
    ).toBeNull()
    expect(resourceWorkerForCleanup(worker, { ...worker.identity, parent: 999 })).toBeNull()
    expect(resourceWorkerForCleanup(worker, { ...worker.identity, pid: 201 })).toBeNull()
  })
  it('only the exact clean no-row query outcome is a null identity', () => {
    expect(processIdentity(200, { query: gone })).toBeNull()
    expect(() => processIdentity(200, { query: () => '' })).toThrow('identity query streams/bound')
  })
})

describe('schema2 truthful two-stream observability, no raw persistence', () => {
  it('uses ucomm only, absolute ps, query-local C, original bounds and BOTH streams', () => {
    const receipts = [],
      calls = []
    const identity = processIdentity(200, {
      query: (command, args, options) => {
        calls.push({ command, args, options })
        return row()
      },
      onQuery: (r) => receipts.push(r)
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/bin/ps')
    expect(calls[0].args).toEqual(['-p', '200', '-ww', '-o', 'ruid=,pid=,ppid=,lstart=,ucomm='])
    expect(calls[0].options).toMatchObject({
      timeout: 10000,
      maxBuffer: 1048576,
      shell: false,
      encoding: 'buffer',
      env: { LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(identity).toMatchObject({
      schema: 2,
      realUid: uid,
      commandName: 'unit-child'.padEnd(16),
      creationCodec: 'ps-lstart-C-seconds'
    })
    expect(receipts[0].observability).toEqual({ stdout: true, stderr: true })
    expect(receipts[0]).not.toHaveProperty('stdout')
    expect(receipts[0]).not.toHaveProperty('stderr')
  })
  it('status0 with actual stderr is fatal, sanitized rather than silently unobserved', () => {
    const receipts = []
    expect(() =>
      processIdentity(200, {
        query: () => ({ ...row(), stderr: Buffer.from('PRIVATE-UNRELATED') }),
        onQuery: (r) => receipts.push(r)
      })
    ).toThrow('identity query diagnostics')
    expect(JSON.stringify(receipts)).not.toContain('PRIVATE-UNRELATED')
    expect(receipts[0].stderrBytes).toBe(17)
  })
})

const actualSource = readFileSync(new URL('./renderer-resource.mjs', import.meta.url), 'utf8')
const actualTree = ts.createSourceFile(
  'renderer-resource.mjs',
  actualSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
)
function sourceNode(predicate) {
  const matches = []
  const visit = (node) => {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(actualTree)
  assert.equal(matches.length, 1, 'one actual production source body')
  return matches[0]
}
const actualInventory = sourceNode(
  (node) =>
    ts.isVariableDeclaration(node) &&
    node.name.getText(actualTree) === 'inventory' &&
    ts.isArrowFunction(node.initializer)
).initializer.getText(actualTree)
const actualParent = sourceNode(
  (node) =>
    ts.isNewExpression(node) &&
    node.expression.getText(actualTree) === 'Promise' &&
    node.arguments?.[0]?.getText(actualTree).includes('const child = spawn(')
).arguments[0].getText(actualTree)
const actualMain = sourceNode(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'main'
)
const runsStatement = actualMain.body.statements.find(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((d) => d.name.getText(actualTree) === 'runs')
)
assert.ok(runsStatement, 'actual main loop begins with runs')
const actualLoop = actualSource.slice(runsStatement.getStart(actualTree), actualMain.body.end - 1)
const plain = (value) => JSON.parse(JSON.stringify(value))

function parentHarness({
  initialGone = false,
  currentIdentity = 'same',
  currentName = 'unit-child',
  laterIdentityDespiteMissing = false,
  childPID = 200,
  autoExit = null,
  failWrites = []
} = {}) {
  const events = [],
    writes = [],
    spawns = [],
    cleanupCalls = [],
    children = [],
    timers = [],
    queries = [],
    rawLogs = [],
    comparisons = [],
    writeErrors = Object.fromEntries(
      failWrites.map((name) => [
        name,
        Object.assign(new Error('synthetic unavailable ' + name), { code: 'ENOSPC' })
      ])
    )
  const context = {
    assert,
    path,
    process: { execPath: '/unit/node', pid: 100, env: { UNIT_ONLY: 'yes' } },
    frozen: { control: { root: '/unit/control' }, candidate: { root: '/unit/candidate' } },
    values: { freeze: '/unit/freeze', go: '/unit/go', out: '/unit/out' },
    evidence: '/unit/evidence',
    log: [],
    side: 'control',
    index: 2,
    randomUUID: () => 'unit-only',
    spawn: (executable, args, options) => {
      const child = new EventEmitter()
      child.pid = childPID
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const on = child.on.bind(child)
      child.on = (name, fn) => {
        events.push('handler:' + name)
        return on(name, fn)
      }
      spawns.push({ executable, args: plain(args), options: plain(options) })
      children.push(child)
      events.push('spawn')
      if (autoExit !== null) queueMicrotask(() => child.emit('exit', autoExit, null))
      return child
    },
    setTimeout: (callback, ms) => {
      assert.equal(ms, 600000)
      const timer = { callback, ms }
      timers.push(timer)
      events.push('fence')
      return timer
    },
    clearTimeout: (timer) => {
      assert.ok(timers.includes(timer))
      events.push('clear-fence')
    },
    write: (file, value) => {
      events.push('write:' + path.basename(file))
      writes.push({ file, value: plain(value) })
      if (writeErrors[path.basename(file)]) throw writeErrors[path.basename(file)]
    },
    readdirSync: () => [],
    readJson: (file) => ({ syntheticFlowOnly: true, file }),
    mkdirSync: () => {},
    writeFileSync: (file, bytes) => {
      assert.equal(path.basename(file), 'raw.log')
      assert.ok(Buffer.isBuffer(bytes))
      events.push('write:raw.log')
      rawLogs.push(bytes.toString())
    },
    Buffer,
    compareResources: (runs) => {
      comparisons.push(runs)
      return { syntheticControlFlowOnly: true, runCount: runs.length }
    },
    forceOwnedCleanup: async (identities) => {
      cleanupCalls.push([...identities])
      return []
    },
    resourceWorkerExit,
    resourceWorkerForCleanup,
    unprovenIdentityEvidence
  }
  const query = (command, args, options) => {
    assert.equal(command, '/bin/ps')
    assert.deepEqual(plain(args), [
      '-p',
      String(childPID),
      '-ww',
      '-o',
      'ruid=,pid=,ppid=,lstart=,ucomm='
    ])
    assert.equal(options.timeout, 10000)
    assert.equal(options.maxBuffer, 1048576)
    assert.equal(options.shell, false)
    assert.equal(options.env.LC_ALL, 'C')
    queries.push(plain(args))
    events.push('identity-query')
    if (initialGone && (!laterIdentityDespiteMissing || queries.length === 1)) return gone()
    const later = queries.length > 1
    if (later && currentIdentity === 'absent') return gone()
    return row(
      childPID,
      later && currentIdentity === 'reparented' ? 999 : 100,
      later && currentIdentity === 'reused'
        ? 'Tue Oct 20 22:08:09 2026'
        : 'Tue Oct 20 22:08:08 2026',
      later ? currentName : 'unit-child'
    )
  }
  context.captureResourceWorker = (pid, ppid, site, write) =>
    captureResourceWorker(pid, ppid, site, write, query)
  context.processIdentity = (pid) => processIdentity(pid, { query })
  const sandbox = vm.createContext(context)
  return {
    events,
    writes,
    spawns,
    cleanupCalls,
    children,
    timers,
    queries,
    rawLogs,
    comparisons,
    writeErrors,
    log: context.log,
    startParent: () => vm.runInContext('new Promise(' + actualParent + ')', sandbox),
    startLoop: () => vm.runInContext('(async()=>{' + actualLoop + '})()', sandbox)
  }
}

describe('actual production parent spawn, handlers, fence and advance paths with in-memory children', () => {
  it('captures before handling a fast failed exit and records exact direct-spawn arguments', async () => {
    const h = parentHarness(),
      promise = h.startParent()
    expect(h.events.indexOf('handler:exit')).toBeLessThan(h.events.indexOf('identity-query'))
    expect(h.events.indexOf('fence')).toBeLessThan(h.events.indexOf('identity-query'))
    expect(h.writes[0].file).toBe('/unit/evidence/worker-spawn.json')
    expect(h.writes[0].value.identity).toMatchObject({
      pid: 200,
      parent: 100,
      creation: 'Tue Oct 20 22:08:08 2026',
      commandName: 'unit-child'.padEnd(16),
      commandSource: 'ps.ucomm',
      schema: 2
    })
    expect(h.spawns).toEqual([
      {
        executable: '/unit/node',
        args: [
          '/unit/control/scripts/performance/renderer-resource.mjs',
          '--freeze',
          '/unit/freeze',
          '--go',
          '/unit/go',
          '--out',
          '/unit/evidence',
          '--side',
          'control',
          '--index',
          '2'
        ],
        options: {
          cwd: '/unit/control',
          env: { UNIT_ONLY: 'yes', SHELL: '/bin/zsh', CLAVE_E2E_NS: 'renderer-resource-unit-only' },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      }
    ])
    h.children[0].emit('exit', 1, null)
    await expect(promise).rejects.toThrow('launch failed code=1 signal=null')
    expect(h.writes.at(-1).value).toMatchObject({ code: 1, signal: null, accepted: false })
  })
  it('accepts a captured clean numeric exit0 and saves that actual outcome', async () => {
    const h = parentHarness(),
      promise = h.startParent()
    h.children[0].emit('exit', 0, null)
    await expect(promise).resolves.toBeUndefined()
    expect(h.writes.at(-1).value).toMatchObject({
      code: 0,
      signal: null,
      expired: false,
      accepted: true
    })
  })
  it('records a spawn error with no invented PID/creation and rejects', async () => {
    const h = parentHarness({ childPID: null }),
      promise = h.startParent()
    const error = Object.assign(new Error('synthetic spawn error'), { code: 'ENOENT' })
    h.children[0].emit('error', error)
    await expect(promise).rejects.toBe(error)
    expect(h.writes.at(-1)).toMatchObject({
      file: '/unit/evidence/worker-error.json',
      value: { pid: null, identity: null, code: 'ENOENT', later: 'NOTRUN' }
    })
    expect(h.queries).toHaveLength(0)
  })
  for (const [code, signal] of [
    [1, null],
    [null, 'SIGTERM'],
    [null, null],
    ['0', null]
  ])
    it(`rejects actual completion code=${code} signal=${signal}`, async () => {
      const h = parentHarness(),
        promise = h.startParent()
      h.children[0].emit('exit', code, signal)
      await expect(promise).rejects.toThrow('launch failed')
      expect(h.writes.at(-1).value).toMatchObject({ code, signal, accepted: false })
    })
  it('keeps missing initial creation unknown and refuses exit0 without later lookup', async () => {
    const h = parentHarness({ initialGone: true }),
      promise = h.startParent()
    expect(h.writes[0].value.identity).toBeNull()
    h.children[0].emit('exit', 0, null)
    await expect(promise).rejects.toThrow('workerIdentity=false')
    expect(h.queries).toHaveLength(1)
    expect(h.writes.at(-1).value.accepted).toBe(false)
  })
  for (const currentIdentity of ['same', 'reused', 'reparented', 'absent'])
    it(`deadline uses original identity only when current worker is ${currentIdentity}`, async () => {
      const h = parentHarness({ currentIdentity }),
        promise = h.startParent()
      const stopped = expect(promise).rejects.toThrow('launch ceiling; late results fenced')
      await h.timers[0].callback()
      await stopped
      const deadline = h.writes.find((r) => r.file.endsWith('deadline-forced-cleanup.json')).value
      expect(deadline).toMatchObject({
        forced: true,
        timedOut: true,
        worker: { signalEligible: currentIdentity === 'same' }
      })
      expect(h.cleanupCalls[0]).toHaveLength(currentIdentity === 'same' ? 1 : 0)
      h.children[0].emit('exit', 0, null)
      expect(h.writes.at(-1).value).toMatchObject({ code: 0, expired: true, accepted: false })
    })
  it('never late-enrolls an uncaptured worker at deadline', async () => {
    const h = parentHarness({ initialGone: true }),
      promise = h.startParent()
    const stopped = expect(promise).rejects.toThrow('launch ceiling')
    await h.timers[0].callback()
    await stopped
    expect(h.cleanupCalls[0]).toHaveLength(0)
  })
  it('actual outer loop cannot advance or compare after missing capture plus exit0', async () => {
    const h = parentHarness({ initialGone: true, autoExit: 0 }),
      promise = h.startLoop()
    await expect(promise).rejects.toThrow('workerIdentity=false')
    expect(h.spawns).toHaveLength(1)
    expect(h.writes.at(-1)).toMatchObject({
      file: '/unit/out/first-failure.json',
      value: { side: 'control', index: 1, completeLaunches: 0, later: 'NOTRUN' }
    })
    expect(h.writes.some((r) => r.file.endsWith('comparison.json'))).toBe(false)
  })
  it('actual loop preserves original control1..3 then candidate1..3 order on synthetic clean completions', async () => {
    const h = parentHarness({ autoExit: 0 })
    await expect(h.startLoop()).resolves.toMatchObject({
      syntheticControlFlowOnly: true,
      runCount: 6
    })
    expect(h.spawns.map((r) => r.args.slice(-4))).toEqual([
      ['--side', 'control', '--index', '1'],
      ['--side', 'control', '--index', '2'],
      ['--side', 'control', '--index', '3'],
      ['--side', 'candidate', '--index', '1'],
      ['--side', 'candidate', '--index', '2'],
      ['--side', 'candidate', '--index', '3']
    ])
    expect(h.writes.filter((r) => r.file.endsWith('worker-spawn.json'))).toHaveLength(6)
    expect(h.writes.filter((r) => r.file.endsWith('worker-exit.json'))).toHaveLength(6)
  })
})

// Only microtasks are drained; the existing production fence is a manual fake callback.
async function pendingCustody(h) {
  let settled = false
  const result = h.startLoop().then(
    (value) => {
      settled = true
      return { value }
    },
    (error) => {
      settled = true
      return { error }
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(h.spawns).toHaveLength(1)
  expect(h.cleanupCalls).toHaveLength(0)
  expect(h.events).not.toContain('clear-fence')
  expect(h.rawLogs).toHaveLength(0)
  expect(h.comparisons).toHaveLength(0)
  return { result }
}
function refusedAfterCustody(h, outcome) {
  expect(outcome.error?.message).toEqual(expect.any(String))
  expect(outcome.error.message).toContain('synthetic unavailable worker-spawn.json')
  expect(h.spawns).toHaveLength(1)
  expect(h.comparisons).toHaveLength(0)
  expect(h.writes.find((r) => r.file.endsWith('first-failure.json')).value).toMatchObject({
    side: 'control',
    index: 1,
    completeLaunches: 0,
    later: 'NOTRUN'
  })
  expect(h.writes.some((r) => r.file.endsWith('comparison.json'))).toBe(false)
  expect(h.rawLogs).toHaveLength(1)
  expect(h.rawLogs[0]).toContain('synthetic unavailable worker-spawn.json')
}

describe('SD-A6-F1 actual parent custody when its new receipt cannot be written', () => {
  it('keeps proven identity and stays pending until exit, then rejects missing evidence even on exit0', async () => {
    const h = parentHarness({ failWrites: ['worker-spawn.json'] })
    const { result } = await pendingCustody(h)
    const initial = h.writes[0].value.identity
    expect(initial).toMatchObject({ pid: 200, parent: 100, creation: 'Tue Oct 20 22:08:08 2026' })
    h.children[0].emit('exit', 0, null)
    refusedAfterCustody(h, await result)
    const exit = h.writes.find((r) => r.file.endsWith('worker-exit.json')).value
    expect(exit).toMatchObject({
      identity: initial,
      accepted: false,
      code: 0,
      evidenceFailure: {
        site: 'worker-spawn.json',
        code: 'ENOSPC',
        message: 'synthetic unavailable worker-spawn.json'
      }
    })
    expect(h.queries).toHaveLength(1)
  })
  for (const currentIdentity of ['same', 'reused', 'reparented', 'absent'])
    it(`retains original identity through receipt failure until the existing fence, current=${currentIdentity}`, async () => {
      const h = parentHarness({ failWrites: ['worker-spawn.json'], currentIdentity })
      const { result } = await pendingCustody(h)
      await h.timers[0].callback()
      const outcome = await result
      refusedAfterCustody(h, outcome)
      expect(outcome.error.message).toContain('launch ceiling; late results fenced')
      const deadline = h.writes.find((r) => r.file.endsWith('deadline-forced-cleanup.json')).value
      expect(deadline.worker.initial).toEqual(h.writes[0].value.identity)
      expect(deadline.worker.evidenceFailure.message).toBe(
        'synthetic unavailable worker-spawn.json'
      )
      expect(deadline.worker.signalEligible).toBe(currentIdentity === 'same')
      expect(h.cleanupCalls[0]).toHaveLength(currentIdentity === 'same' ? 1 : 0)
      h.children[0].emit('exit', 0, null)
      expect(h.writes.at(-1).value).toMatchObject({ code: 0, expired: true, accepted: false })
    })
  for (const finish of ['exit', 'fence'])
    it(`keeps missing capture unknown through receipt failure and ${finish}, never enrolling a later PID`, async () => {
      const h = parentHarness({ initialGone: true, failWrites: ['worker-spawn.json'] })
      const { result } = await pendingCustody(h)
      expect(h.writes[0].value.identity).toBeNull()
      if (finish === 'exit') h.children[0].emit('exit', 0, null)
      else await h.timers[0].callback()
      refusedAfterCustody(h, await result)
      expect(h.cleanupCalls.flat()).toHaveLength(0)
      if (finish === 'exit') {
        const exit = h.writes.find((r) => r.file.endsWith('worker-exit.json')).value
        expect(exit.identity).toBeNull()
        expect(exit.failure.message).toContain('owned process is alive when identified')
        expect(exit.accepted).toBe(false)
      }
    })
  it('preserves the first spawn-receipt failure when the exit receipt also fails, without throwing from the event handler', async () => {
    const h = parentHarness({ failWrites: ['worker-spawn.json', 'worker-exit.json'] })
    const { result } = await pendingCustody(h)
    expect(() => h.children[0].emit('exit', 0, null)).not.toThrow()
    const outcome = await result
    refusedAfterCustody(h, outcome)
    expect(h.writes.find((r) => r.file.endsWith('first-failure.json')).value.error).toContain(
      'worker-spawn.json'
    )
    expect(h.rawLogs[0]).toContain(
      'worker exit receipt failed: synthetic unavailable worker-exit.json'
    )
  })
  it('rejects an otherwise clean exit when its completion receipt fails, with no next launch', async () => {
    const h = parentHarness({ failWrites: ['worker-exit.json'] })
    const { result } = await pendingCustody(h)
    expect(() => h.children[0].emit('exit', 0, null)).not.toThrow()
    expect((await result).error).toBe(h.writeErrors['worker-exit.json'])
    expect(h.spawns).toHaveLength(1)
    expect(h.comparisons).toHaveLength(0)
    expect(h.rawLogs[0]).toContain('worker exit receipt failed')
  })
  it('preserves a no-PID spawn error when its new error receipt also fails', async () => {
    const h = parentHarness({ childPID: null, failWrites: ['worker-error.json'] })
    const { result } = await pendingCustody(h)
    const error = Object.assign(new Error('synthetic original spawn error'), { code: 'ENOENT' })
    expect(() => h.children[0].emit('error', error)).not.toThrow()
    expect((await result).error).toBe(error)
    expect(h.queries).toHaveLength(0)
    expect(h.rawLogs[0]).toContain(
      'worker error receipt failed: synthetic unavailable worker-error.json'
    )
    expect(h.spawns).toHaveLength(1)
  })
  it('keeps an already spawned child under the same fence after an error, then rejects even exit0', async () => {
    const h = parentHarness({ failWrites: ['worker-error.json'] })
    const { result } = await pendingCustody(h)
    const error = Object.assign(new Error('synthetic live-child error'), { code: 'EIO' })
    expect(() => h.children[0].emit('error', error)).not.toThrow()
    await Promise.resolve()
    expect(h.rawLogs).toHaveLength(0)
    expect(h.events).not.toContain('clear-fence')
    h.children[0].emit('exit', 0, null)
    expect((await result).error.message).toContain(error.message)
    expect(h.writes.find((r) => r.file.endsWith('worker-exit.json')).value).toMatchObject({
      accepted: false,
      code: 0,
      error: { code: 'EIO', message: error.message }
    })
    expect(h.spawns).toHaveLength(1)
    expect(h.comparisons).toHaveLength(0)
  })
  it('retains live-child errors through the original fence without accepting or adding a worker', async () => {
    const h = parentHarness()
    const { result } = await pendingCustody(h)
    h.children[0].emit('error', new Error('synthetic live error before fence'))
    await Promise.resolve()
    expect(h.events).not.toContain('clear-fence')
    await h.timers[0].callback()
    expect((await result).error.message).toContain('launch ceiling')
    expect(
      h.writes.find((r) => r.file.endsWith('deadline-forced-cleanup.json')).value.worker
    ).toMatchObject({
      signalEligible: true,
      error: 'synthetic live error before fence'
    })
    expect(h.spawns).toHaveLength(1)
    expect(h.comparisons).toHaveLength(0)
  })
  it('retains the first receipt failure across a later live-child error until actual completion', async () => {
    const h = parentHarness({ failWrites: ['worker-spawn.json', 'worker-error.json'] })
    const { result } = await pendingCustody(h)
    expect(() =>
      h.children[0].emit('error', new Error('synthetic later child error'))
    ).not.toThrow()
    await Promise.resolve()
    expect(h.rawLogs).toHaveLength(0)
    expect(h.events).not.toContain('clear-fence')
    h.children[0].emit('exit', 1, null)
    refusedAfterCustody(h, await result)
    expect(h.rawLogs[0]).toContain('worker error receipt failed')
  })
  it('also rejects the fast queued exit0 after the failed initial receipt without losing captured identity', async () => {
    const h = parentHarness({ autoExit: 0, failWrites: ['worker-spawn.json'] })
    const outcome = await h.startLoop().then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    refusedAfterCustody(h, outcome)
    expect(h.writes.find((r) => r.file.endsWith('worker-exit.json')).value.identity).toEqual(
      h.writes[0].value.identity
    )
  })
})

async function inventoryHarness({ mode = 'none', queryError = null, change = null } = {}) {
  const initial = Object.freeze({
    ...decodeIdentityRows(Buffer.from(textRow(200, 100)), uid).get(200),
    role: 'main'
  })
  const owned = new Map([[200, initial]])
  const events = [],
    queries = []
  const query = (command, args, options) => {
    expect(command).toBe('/bin/ps')
    queries.push({ command, args: plain(args), timeout: options.timeout })
    if (args[0] === '-U') {
      expect(args).toEqual([
        '-U',
        String(uid),
        '-x',
        '-ww',
        '-o',
        'ruid=,pid=,ppid=,lstart=,ucomm='
      ])
      if (queryError) return queryError
      let text =
        textRow(600, 200) +
        textRow(400, 300) +
        textRow(300, 200) +
        textRow(200, 100) +
        textRow(900, 100, undefined, 'UNRELATED-NAME')
      if (mode === 'disappeared') text += textRow(500, 200)
      if (mode === 'malformed') text += `${uid} 500 200 missing\n`
      return ok(change ? change(text) : text)
    }
    const pid = Number(args[1])
    if (pid === 500) return gone()
    return row(pid, pid === 200 ? 100 : pid === 300 || pid === 600 ? 200 : 300)
  }
  const context = {
    owned,
    path,
    dir: '/unit',
    ownershipFixture: { fixture: 'chat/renderer-resource' },
    process: { getuid: () => uid, geteuid: () => uid },
    separateServerDataDir: () => '/unit/server',
    readJson: (file) =>
      file === '/unit/clave-server.json' ? { serverPid: 300 } : { terminalProcessPid: 400 },
    app: { process: () => ({ pid: 200 }), evaluate: async () => [{ pid: 600, type: 'Tab' }] },
    result: {},
    persist: (value) => events.push(plain(value)),
    captureOwnedInventory: (args) => captureOwnedInventory({ ...args, query })
  }
  const run = vm.runInContext('(' + actualInventory + ')', vm.createContext(context))
  let error
  try {
    await run('unit.inventory')
  } catch (caught) {
    error = caught
  }
  return { owned, initial, events, queries, error }
}
describe('actual production inventory with FIRST complete UID rows', () => {
  it('FIRST complete discovery survives a later child exit without late identity fill', async () => {
    const h = await inventoryHarness({ mode: 'disappeared' })
    expect(h.error).toBeUndefined()
    expect(h.owned.get(500)).toMatchObject({ pid: 500, parent: 200, role: 'descendant', schema: 2 })
    expect(h.queries.some((q) => q.args[0] === '-p' && q.args[1] === '500')).toBe(false)
    expect(processIdentity(500, { query: gone })).toBeNull()
    expect(h.owned.get(200)).toBe(h.initial)
    expect(h.owned.has(900)).toBe(false)
    expect(JSON.stringify(h.events)).not.toContain('UNRELATED-NAME')
  })
  it('accepts no-new-child snapshot and retains required server/terminal roles', async () => {
    const h = await inventoryHarness()
    expect(h.error).toBeUndefined()
    expect(h.owned.size).toBe(4)
    expect(h.owned.get(300).role).toBe('server')
    expect(h.owned.get(400).role).toBe('terminal-process')
    expect(h.events.at(-1).owned).toHaveLength(4)
  })
  for (const outcome of [
    { status: 1, signal: null, stdout: '', stderr: 'PRIVATE-UNRELATED' },
    { status: 1, signal: null, stdout: textRow(), stderr: '' },
    {
      status: null,
      signal: 'SIGTERM',
      error: { code: 'ETIMEDOUT', stdout: 'PRIVATE-UNRELATED' },
      stdout: '',
      stderr: ''
    },
    { status: 0, signal: null, stdout: textRow(), stderr: 'PRIVATE-UNRELATED' }
  ])
    it(
      'strict sanitized discovery error ' +
        JSON.stringify({
          status: outcome.status,
          signal: outcome.signal,
          warning: !!outcome.stderr
        }),
      async () => {
        const h = await inventoryHarness({
          queryError: {
            ...outcome,
            stdout: Buffer.from(outcome.stdout),
            stderr: Buffer.from(outcome.stderr)
          }
        })
        expect(h.error).toBeDefined()
        expect(h.owned.size).toBe(1)
        expect(h.owned.get(200)).toBe(h.initial)
        expect(h.events.some((r) => r.owned)).toBe(false)
        expect(h.events[0].ownershipDiscoveryFailure.later).toBe('NOTRUN')
        expect(JSON.stringify(h.events) + String(h.error.stack)).not.toContain('PRIVATE-UNRELATED')
      }
    )
  it('SAME exposed incomplete descendant is fatal, never skipped or late filled', async () => {
    const h = await inventoryHarness({ mode: 'malformed' })
    expect(h.error).toBeDefined()
    expect(h.error.message).toBe('identity complete row')
    expect(h.owned.size).toBe(1)
    expect(h.owned.has(500)).toBe(false)
    expect(h.events.some((r) => r.owned)).toBe(false)
  })
  it('original bare-PID then NULL is still fatal, never a discovery waiver', () => {
    const c = context()
    expect(() => c.own(gone, 500, 200)).toThrow('owned process is alive when identified')
    expect(c.owned.has(500)).toBe(false)
    expect(c.receipts[0].observedIdentity).toBeNull()
  })
})

function scan({
  text,
  known,
  refs,
  before,
  after,
  outcome,
  realUid = uid,
  effectiveUid = uid,
  fixtureBound = true
} = {}) {
  const root = Object.freeze({
    ...decodeIdentityRows(Buffer.from(textRow(200, 100)), uid).get(200),
    role: 'main'
  })
  const owned = known || new Map([[200, root]])
  const initial = [...owned.entries()]
  const required = refs || [
    { pid: 300, parent: 200, role: 'server' },
    { pid: 400, parent: 300, role: 'terminal-process' },
    { pid: 600, parent: 200, role: 'renderer' },
    { pid: 700, parent: 200, role: 'utility' }
  ]
  const whole =
    text ??
    textRow(800, 500) +
      textRow(500, 400) +
      textRow(700, 200) +
      textRow(400, 300) +
      textRow(600, 200) +
      textRow(300, 200) +
      textRow(200, 100) +
      textRow(900, 100, undefined, 'UNRELATED-NAME')
  const rows = whole.split('\n').filter(Boolean)
  let acquired = false
  const calls = [],
    failures = []
  const query = (command, args) => {
    calls.push({ command, args })
    if (args[0] === '-U') {
      acquired = true
      return outcome || ok(whole)
    }
    const pid = Number(args[1])
    const override = acquired ? after : before
    if (override) {
      const value = override(pid)
      if (value !== undefined) return value
    }
    const line = rows.find((r) => Number(r.split(' ')[1]) === pid)
    return line ? ok(line + '\n') : gone()
  }
  let result, error
  try {
    result = captureOwnedInventory({
      owned,
      rootPid: 200,
      required,
      realUid,
      effectiveUid,
      fixtureBound,
      context: { site: 'unit.scan' },
      query,
      recordFailure: (f) => failures.push(f)
    })
  } catch (caught) {
    error = caught
  }
  return { owned, initial, result, error, calls, failures }
}
function rolledBack(h, category) {
  expect(h.error?.message).toBe(category)
  expect([...h.owned.entries()]).toEqual(h.initial)
  for (const [pid, identity] of h.initial) expect(h.owned.get(pid)).toBe(identity)
  expect(h.result).toBeUndefined()
  expect(h.failures).toHaveLength(1)
  expect(h.failures[0].later).toBe('NOTRUN')
}
describe('schema2 decoder and complete transactional owned graph', () => {
  it('unsorted deep graph spans every role without PGID/session/name admission', () => {
    const h = scan()
    expect(h.error).toBeUndefined()
    expect([...h.owned.keys()].sort()).toEqual([200, 300, 400, 500, 600, 700, 800])
    for (const [pid, role] of [
      [200, 'main'],
      [300, 'server'],
      [400, 'terminal-process'],
      [600, 'renderer'],
      [700, 'utility'],
      [500, 'descendant'],
      [800, 'descendant']
    ])
      expect(h.owned.get(pid).role).toBe(role)
    expect(h.owned.get(200)).toBe(h.initial[0][1])
    expect(h.calls.filter((q) => q.args[0] === '-U')).toHaveLength(1)
    expect(h.result.observations).toHaveLength(1)
    for (const stage of ['before', 'after'])
      expect(h.result.fences.find((f) => f.pid === 200 && f.stage === stage)).toMatchObject({
        identity: { pid: 200, parent: 100, creation: h.initial[0][1].creation },
        query: { status: 0, signal: null }
      })
    expect(JSON.stringify(h.result)).not.toContain('UNRELATED-NAME')
    expect(h.owned.get(500)).not.toHaveProperty('executable')
    expect(Object.isFrozen(h.owned.get(500))).toBe(true)
    expect(Object.isFrozen(h.owned.get(500).provenance)).toBe(true)
  })
  it('later name changes are separate diagnostics; FIRST object, role, provenance stay unchanged', () => {
    const h = scan()
    const old = h.owned.get(500)
    const originalMap = new Map(h.owned)
    const next = scan({
      known: h.owned,
      text: [...h.owned.values()]
        .map((r) => textRow(r.pid, r.parent, r.creation, 'another-name'))
        .join('')
    })
    expect(next.error).toBeUndefined()
    for (const [pid, identity] of originalMap) expect(next.owned.get(pid)).toBe(identity)
    expect(old.commandName).toBe('unit-child'.padEnd(16))
    expect(next.result.observations.find((r) => r.initialPid === 500).current.commandName).toBe(
      'another-name'.padEnd(16)
    )
  })
  for (const [name, input, category] of [
    ['no root', textRow(300, 200), 'inventory missing main row'],
    [
      'missing server',
      textRow(200, 100) + textRow(400, 300) + textRow(600, 200) + textRow(700, 200),
      'inventory missing required role/edge'
    ],
    [
      'missing renderer',
      textRow(200, 100) + textRow(300, 200) + textRow(400, 300) + textRow(700, 200),
      'inventory missing required role/edge'
    ],
    [
      'missing utility',
      textRow(200, 100) + textRow(300, 200) + textRow(400, 300) + textRow(600, 200),
      'inventory missing required role/edge'
    ],
    [
      'unresolved terminal edge',
      textRow(200, 100) +
        textRow(300, 200) +
        textRow(400, 999) +
        textRow(600, 200) +
        textRow(700, 200),
      'inventory missing required role/edge'
    ],
    [
      'wrong terminal parent',
      textRow(200, 100) +
        textRow(300, 200) +
        textRow(400, 200) +
        textRow(600, 200) +
        textRow(700, 200),
      'inventory required parent'
    ],
    [
      'cycle',
      textRow(200, 100) + textRow(300, 400) + textRow(400, 300),
      'inventory ancestry cycle'
    ],
    ['duplicate', textRow(200, 100) + textRow(200, 100), 'identity duplicate PID'],
    [
      'other real UID',
      textRow(200, 100, undefined, 'unit-child', uid + 1),
      'identity selected real UID'
    ],
    ['root reuse', textRow(200, 100, 'Tue Oct 20 22:08:09 2026'), 'owned PID reused'],
    ['root reparent', textRow(200, 999), 'owned parent changed']
  ])
    it('rollback on ' + name, () => {
      // A root reuse/reparent change is introduced at census, after a valid pre-fence.
      rolledBack(
        scan({ text: input, before: (pid) => (pid === 200 ? row() : undefined) }),
        category
      )
    })
  for (const [name, data, category] of [
    ['missing field', `${uid} 500 200 missing\n`, 'identity complete row'],
    ['empty name', textRow().replace('unit-child', ' '.repeat(10)), 'identity kernel name field'],
    ['partial creation', textRow().replace('22:08:08', '22:08'), 'identity complete row'],
    ['bad calendar', textRow().replace('Oct 20', 'Feb 30'), 'identity C creation codec'],
    ['wrong weekday', textRow().replace('Tue', 'Mon'), 'identity C creation codec'],
    ['no final newline', textRow().slice(0, -1), 'identity whole framing'],
    ['extra blank row', textRow() + '\n', 'identity complete row'],
    ['trailing garbage', textRow() + 'garbage\n', 'identity complete row'],
    ['control name', textRow().replace('unit-child', 'unit\tchild'), 'identity whole framing'],
    [
      'unicode separator',
      textRow().replace('unit-child', 'unit\u00a0child'),
      'identity whole framing'
    ],
    ['overlong name', textRow(200, 100, undefined, 'x'.repeat(17)), 'identity complete row']
  ])
    it('WHOLE framing rejects ' + name + ' including unrelated suffix', () => {
      expect(() => decodeIdentityRows(Buffer.from(data), uid)).toThrow(category)
      rolledBack(
        scan({ text: textRow(200, 100) + data.replace(`${uid} 200 100`, `${uid} 950 100`) }),
        category
      )
    })
  it('UTF8 errors and overflow have no decoded-prefix success', () => {
    expect(() => decodeIdentityRows(Buffer.from([0xff, 0x0a]), uid)).toThrow('identity encoding')
    expect(() => decodeIdentityRows(Buffer.alloc(1048577), uid)).toThrow('identity buffer bound')
    expect(
      decodeIdentityRows(Buffer.from(textRow(200, 100, undefined, '1234567890123456')), uid).get(
        200
      ).commandName
    ).toBe('1234567890123456')
  })
  for (const [name, change, category] of [
    [
      'post missing root',
      (pid) => (pid === 200 ? gone() : undefined),
      'inventory missing post-fence'
    ],
    [
      'post root reuse',
      (pid) => (pid === 200 ? row(200, 100, 'Tue Oct 20 22:08:09 2026') : undefined),
      'owned PID reused'
    ],
    [
      'post new parent reparent',
      (pid) => (pid === 500 ? row(500, 200) : undefined),
      'owned parent changed'
    ]
  ])
    it('staging rolls back all additions after ' + name, () =>
      rolledBack(scan({ after: change }), category)
    )
  it('previously known child cannot evade changed-parent/creation or unresolved-chain checks', () => {
    const complete = scan()
    for (const [before, category] of [
      [(pid) => (pid === 500 ? row(500, 999) : undefined), 'owned parent changed'],
      [
        (pid) => (pid === 500 ? row(500, 400, 'Tue Oct 20 22:08:09 2026') : undefined),
        'owned PID reused'
      ],
      [(pid) => (pid === 500 ? gone() : undefined), 'inventory missing known pre-fence']
    ])
      rolledBack(scan({ known: new Map(complete.owned), before }), category)
    const detached = [...complete.owned.values()]
      .map((r) => textRow(r.pid, r.pid === 500 ? 999 : r.parent, r.creation))
      .join('')
    rolledBack(
      scan({
        known: new Map(complete.owned),
        text: detached,
        before: (pid) => (pid === 500 ? row(500, 400) : undefined)
      }),
      'owned parent changed'
    )
  })
  it('missing required pre-fence fails without a census or new identity', () => {
    const h = scan({ before: () => gone() })
    rolledBack(h, 'inventory missing required pre-fence')
    expect(h.calls.some((q) => q.args[0] === '-U')).toBe(false)
  })
  it('an already captured leaf may be cleanly absent in a later inventory without erasing evidence', () => {
    const first = scan()
    const known = new Map(first.owned)
    const text = [...known.values()]
      .filter((r) => r.pid !== 800)
      .map((r) => textRow(r.pid, r.parent, r.creation))
      .join('')
    const h = scan({ known, text })
    expect(h.error).toBeUndefined()
    expect(h.owned.get(800)).toBe(first.owned.get(800))
  })
  for (const overrides of [
    { realUid: 0, effectiveUid: 0 },
    { realUid: uid, effectiveUid: uid + 1 },
    { fixtureBound: false }
  ])
    it('rejects runner/fixture scope before any query ' + JSON.stringify(overrides), () => {
      const h = scan(overrides)
      expect(h.error).toBeDefined()
      expect(h.calls).toHaveLength(0)
      expect([...h.owned.entries()]).toEqual(h.initial)
    })
  it('required references cannot overwrite main or discard a mandatory role', () => {
    rolledBack(
      scan({ refs: [{ pid: 200, parent: 200, role: 'server' }] }),
      'inventory required role references'
    )
    rolledBack(scan({ refs: [] }), 'inventory mandatory role coverage')
  })
  for (const result of [
    { ...row(), status: 1 },
    { ...row(), signal: 'SIGTERM' },
    {
      ...row(),
      error: Object.assign(new Error('PRIVATE-UNRELATED'), {
        code: 'ETIMEDOUT',
        stdout: 'PRIVATE-UNRELATED'
      })
    },
    { ...row(), error: { code: 'ENOBUFS' } },
    { ...row(), stdout: Buffer.alloc(1048577) },
    { ...row(), stderr: null },
    { ...row(), status: null },
    { ...row(), stderr: Buffer.from('PRIVATE-UNRELATED') }
  ])
    it(
      'fatal query outcome preserves no raw table/error/cause ' +
        JSON.stringify({
          status: result.status,
          signal: result.signal,
          error: !!result.error,
          stderr: result.stderr?.length
        }),
      () => {
        const h = scan({ outcome: result })
        expect(h.error).toBeDefined()
        expect([...h.owned.entries()]).toEqual(h.initial)
        expect(h.error).not.toHaveProperty('cause')
        expect(JSON.stringify(h.failures) + h.error.stack).not.toContain('PRIVATE-UNRELATED')
        expect(JSON.stringify(h.failures)).not.toContain('UNRELATED-NAME')
        expect(h.failures[0].query).not.toHaveProperty('stdout')
      }
    )
  it('thrown backend Error with arbitrary raw stdout is replaced, not forwarded', () => {
    const receipts = [],
      privateError = Object.assign(new Error('PRIVATE-UNRELATED'), {
        stdout: 'PRIVATE-UNRELATED',
        cause: 'PRIVATE-UNRELATED'
      })
    let caught
    try {
      processIdentity(200, {
        query: () => {
          throw privateError
        },
        onQuery: (r) => receipts.push(r)
      })
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBe(privateError)
    expect(caught.message).toBe('identity query threw')
    expect(JSON.stringify(receipts) + caught.stack + JSON.stringify(caught)).not.toContain(
      'PRIVATE-UNRELATED'
    )
  })
})

describe('fixed source/artifact inheritance precondition before any app/worker', () => {
  const root = '/unit/root'
  const sourceFiles = { ...OWNERSHIP_FIXTURE_SOURCES }
  const frozen = {
    ownershipFixture: {
      schema: 2,
      fixture: 'chat/renderer-resource',
      provider: 'dev-echo-adapter',
      credentialScope: 'nonroot-inherited-real-equal-effective',
      credentialChangingActions: false
    },
    candidate: { root, sourceFiles },
    toolingFiles: {}
  }
  const read = (file) =>
    readFileSync(new URL('../../' + file.slice(root.length + 1), import.meta.url))
  const regular = { isFile: () => true, mode: 0o100755 }
  it('accepts exact reviewed sources and nonprivileged executable modes under matching nonroot runner', () => {
    const receipt = verifyOwnershipFixture(frozen, 'candidate', {
      read,
      stat: () => regular,
      execPath: '/unit/node',
      realUid: uid,
      effectiveUid: uid
    })
    expect(receipt).toMatchObject({
      schema: 2,
      realUid: uid,
      provider: 'dev-echo-adapter',
      executableModesChecked: 7
    })
    expect(receipt.limitation).toContain('not per-child EUID')
    expect(validateOwnershipRunner(uid, uid, true)).toBe(uid)
  })
  for (const stat of [
    () => ({ ...regular, mode: 0o104755 }),
    () => ({ ...regular, mode: 0o102755 }),
    () => ({ ...regular, mode: 0o100644 }),
    () => ({ ...regular, isFile: () => false })
  ])
    it('rejects credential-changing or unresolved artifact mode without querying OS processes', () => {
      expect(() => verifyOwnershipFixture(frozen, 'candidate', { read, stat })).toThrow(
        'ownership unprivileged executable mode'
      )
    })
  it('unknown inheritance/source changes and omitted source coverage stop', () => {
    expect(() =>
      verifyOwnershipFixture(frozen, 'candidate', {
        read: () => Buffer.from('changed-source'),
        stat: () => regular
      })
    ).toThrow('ownership fixture source changed')
    expect(() =>
      verifyOwnershipFixture(
        { ...frozen, candidate: { root, sourceFiles: {} }, toolingFiles: {} },
        'candidate',
        { read, stat: () => regular }
      )
    ).toThrow('ownership frozen fixture source coverage')
  })
  it('rejects the old session-manager pin after native control-request integration', () => {
    const stale = {
      ...frozen,
      candidate: {
        root,
        sourceFiles: {
          ...sourceFiles,
          'src/main/sessions/session-manager.ts':
            '28b58e07486d01f8a79a01eeaad2092bf31c33e8b7dbcd80b071eb4d1b2d5f02'
        }
      }
    }
    expect(() => verifyOwnershipFixture(stale, 'candidate', { read, stat: () => regular })).toThrow(
      'ownership frozen fixture source coverage'
    )
  })
})

describe('actual forced cleanup is bounded to initial schema2 tuples, with fake queries/signals', () => {
  const forceSource = sourceNode(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'forceOwnedCleanup'
  ).getText(actualTree)
  async function force(initial, current) {
    const signals = [],
      waits = []
    const run = vm.runInContext(
      '(' + forceSource + ')',
      vm.createContext({
        processIdentity: () => current,
        process: { kill: (pid, signal) => signals.push({ pid, signal }) },
        sleep: async (ms) => waits.push(ms)
      })
    )
    const receipts = await run(initial)
    return { signals, waits, receipts }
  }
  it('only matching initial tuple is eligible for the existing TERM/250ms/KILL sequence', async () => {
    const initial = { ...parent }
    const h = await force([initial], { ...initial, commandName: 'changed-name' })
    expect(h.signals).toEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGKILL' }
    ])
    expect(h.waits).toEqual([250])
  })
  for (const current of [
    null,
    { ...parent, creation: 'different' },
    { ...parent, parent: 999 },
    { ...parent, realUid: uid + 1 }
  ])
    it(
      'never signals absent/reused/reparented/foreign UID identity ' + JSON.stringify(current),
      async () => {
        expect((await force([parent], current)).signals).toEqual([])
      }
    )
})

// Fixed formatter bytes, independent of textRow's synthetic generator.
describe('declared Apple C column codec', () => {
  it('preserves the complete ucomm diagnostic field including all formatter spaces', () => {
    const bytes = Buffer.from('  501   200   100 Tue Oct 20 22:08:08 2026     node            \n')
    const identity = decodeIdentityRows(bytes, 501).get(200)
    expect(identity.commandName).toBe('node            ')
    expect(identity.commandNameCodec).toBe('ps-ucomm-field-width16-verbatim')
    expect(identity.creation).toBe('Tue Oct 20 22:08:08 2026')
    expect(() =>
      decodeIdentityRows(Buffer.from(bytes.toString().replace('     node', '      node')), 501)
    ).toThrow('identity complete row')
    expect(() =>
      decodeIdentityRows(
        Buffer.from(bytes.toString().replace('node            ', 'node           ')),
        501
      )
    ).toThrow('identity complete row')
  })
  it('retains single-digit day padding without locale normalization', () => {
    const identity = decodeIdentityRows(
      Buffer.from(textRow(200, 100, 'Thu Oct  1 00:00:00 2026')),
      uid
    ).get(200)
    expect(identity.creation).toBe('Thu Oct  1 00:00:00 2026')
  })
  it('requires explicit new freeze fixture scope rather than inheriting old13a/14c authority', () => {
    expect(() =>
      verifyOwnershipFixture(
        { candidate: { root: '/unit', sourceFiles: {} }, toolingFiles: {} },
        'candidate',
        {
          read: () => Buffer.alloc(0),
          stat: () => {
            throw new Error('MUST NOT reach artifact')
          }
        }
      )
    ).toThrow('ownership explicit frozen fixture scope')
  })
  it('captures the actual safe signal and timeout category without Error stdout/cause', () => {
    const receipts = []
    expect(() =>
      processIdentity(200, {
        query: () => ({
          ...row(),
          signal: 'SIGTERM',
          error: { code: 'ETIMEDOUT', stdout: 'PRIVATE-UNRELATED' }
        }),
        onQuery: (r) => receipts.push(r)
      })
    ).toThrow('identity query diagnostics')
    expect(receipts[0]).toMatchObject({ signal: 'SIGTERM', code: 'ETIMEDOUT', failed: true })
    expect(JSON.stringify(receipts)).not.toContain('PRIVATE-UNRELATED')
  })
})

describe('independent admission counterexamples for semantic mutants', () => {
  it('a new foreign-UID child is fatal before any first record is admitted', () => {
    const c = context()
    expect(() => c.own(() => row(200, 100, undefined, 'foreign', uid + 1))).toThrow(
      'identity selected real UID'
    )
    expect(c.owned.has(200)).toBe(false)
  })
  it('a complete but disconnected required reference cannot be ignored as unrelated', () => {
    const refs = [
      { pid: 300, parent: 200, role: 'server' },
      { pid: 400, parent: 300, role: 'terminal-process' },
      { pid: 600, parent: 200, role: 'renderer' },
      { pid: 700, parent: 900, role: 'utility' }
    ]
    const text =
      textRow(200, 100) +
      textRow(300, 200) +
      textRow(400, 300) +
      textRow(600, 200) +
      textRow(700, 900) +
      textRow(900, 100)
    rolledBack(scan({ refs, text }), 'inventory missing required role/edge')
  })
  it('matching later targeted capture preserves the FIRST object and its provenance/role/name', () => {
    const c = context()
    const initial = c.own(() => row())
    const next = identifyOwnedProcess(
      c.owned,
      200,
      'utility',
      100,
      { site: 'later-site' },
      (r) => c.receipts.push(r),
      () => row(200, 100, undefined, 'new-name')
    )
    expect(next).toBe(initial)
    expect(next.commandName).toBe('unit-child'.padEnd(16))
    expect(next.provenance.site).toBe('unit.inventory.pgrep-child')
    expect(next.role).toBe('descendant')
  })
  it('status1 with complete partial stdout remains an error, never absence/success', () => {
    expect(() => processIdentity(200, { query: () => ({ ...row(), status: 1 }) })).toThrow(
      'identity query status'
    )
  })
  it('status0 with a backend error remains fatal even with complete streams', () => {
    expect(() =>
      processIdentity(200, { query: () => ({ ...row(), error: { code: 'ENOBUFS' } }) })
    ).toThrow('identity query diagnostics')
  })
})

function absentKnownParentScan(suffix = '') {
  const root = Object.freeze({
    ...decodeIdentityRows(Buffer.from(textRow(200, 100)), uid).get(200),
    role: 'main'
  })
  const prior = Object.freeze({
    ...decodeIdentityRows(Buffer.from(textRow(500, 200)), uid).get(500),
    role: 'descendant'
  })
  const known = new Map([
    [200, root],
    [500, prior]
  ])
  return scan({
    known,
    text:
      textRow(400, 300) +
      textRow(600, 200) +
      textRow(700, 200) +
      textRow(300, 200) +
      textRow(200, 100) +
      suffix
  })
}
describe('C1/C2 repair regressions on actual source', () => {
  for (const mismatch of ['expected-parent', 'reuse', 'reparent'])
    it('C1 targeted rejected ' + mismatch + ' excludes unproven diagnostic metadata', () => {
      const c = context()
      if (mismatch !== 'expected-parent') c.own(() => row())
      const initial = c.owned.get(200)
      const query = () =>
        row(
          200,
          mismatch === 'reuse' ? 100 : 999,
          mismatch === 'reuse' ? 'Tue Oct 20 22:08:09 2026' : undefined,
          'FOREIGN-NAME'
        )
      expect(() => c.own(query)).toThrow(
        mismatch === 'reuse' ? 'owned PID reused' : 'proven owned child'
      )
      expect(JSON.stringify(c.receipts)).not.toContain('FOREIGN-NAME')
      expect(c.receipts[0].observedIdentity).toMatchObject({
        pid: 200,
        parent: mismatch === 'reuse' ? 100 : 999
      })
      expect(c.receipts[0].observedIdentity).not.toHaveProperty('commandName')
      expect(c.receipts[0].observedIdentity).not.toHaveProperty('schema')
      expect(c.receipts[0].observedIdentity.evidenceKind).toBe('unproven-comparison-tuple')
      expect(c.owned.get(200)).toBe(initial)
      expect(c.receipts[0].previousIdentity).toBe(initial ?? null)
      expect(c.receipts[0].query).toMatchObject({ status: 0, signal: null })
    })
  for (const stage of ['before', 'after'])
    for (const mismatch of ['reuse', 'reparent'])
      it(
        'C1 inventory ' +
          stage +
          ' rejected ' +
          mismatch +
          ' excludes unproven diagnostic metadata',
        () => {
          const changed = (pid) =>
            pid === 200
              ? row(
                  200,
                  mismatch === 'reuse' ? 100 : 999,
                  mismatch === 'reuse' ? 'Tue Oct 20 22:08:09 2026' : undefined,
                  'FOREIGN-NAME'
                )
              : undefined
          const h = scan({ [stage]: changed })
          rolledBack(h, mismatch === 'reuse' ? 'owned PID reused' : 'owned parent changed')
          expect(JSON.stringify(h.failures) + h.error.stack).not.toContain('FOREIGN-NAME')
          const fence = h.failures[0].fences.find((f) => f.stage === stage && f.pid === 200)
          expect(fence.identity).toMatchObject({
            pid: 200,
            parent: mismatch === 'reuse' ? 100 : 999
          })
          expect(fence.identity).not.toHaveProperty('commandName')
          expect(fence.identity).not.toHaveProperty('schema')
          expect(fence.initialIdentity).toBe(h.initial[0][1])
          expect(fence.query).toMatchObject({ status: 0, signal: null })
        }
      )
  for (const mismatch of ['reused', 'reparented', 'missing-initial'])
    it(
      'C1 actual deadline rejected ' + mismatch + ' worker excludes unproven diagnostic metadata',
      async () => {
        const h = parentHarness({
          currentIdentity: mismatch === 'missing-initial' ? 'same' : mismatch,
          currentName: 'FOREIGN-NAME',
          initialGone: mismatch === 'missing-initial',
          laterIdentityDespiteMissing: true
        })
        const promise = h.startParent()
        const rejected = expect(promise).rejects.toThrow('launch ceiling')
        await h.timers[0].callback()
        await rejected
        const receipt = h.writes.find((r) => r.file.endsWith('deadline-forced-cleanup.json')).value
        expect(receipt.worker.signalEligible).toBe(false)
        expect(JSON.stringify(h.writes) + JSON.stringify(h.rawLogs)).not.toContain('FOREIGN-NAME')
        expect(receipt.worker.current).toMatchObject({
          pid: 200,
          parent: mismatch === 'reparented' ? 999 : 100
        })
        expect(receipt.worker.current).not.toHaveProperty('commandName')
        expect(receipt.worker.current).not.toHaveProperty('schema')
        expect(h.cleanupCalls[0]).toHaveLength(0)
        expect(h.spawns).toHaveLength(1)
        expect(h.timers[0].ms).toBe(600000)
        expect(receipt.worker.initial).toEqual(h.writes[0].value.identity)
      }
    )
  it('C1 matching deadline diagnostic change remains proven, preserving original signal fence', async () => {
    const h = parentHarness({ currentName: 'MATCHED-NAME' })
    const promise = h.startParent()
    const rejected = expect(promise).rejects.toThrow('launch ceiling')
    await h.timers[0].callback()
    await rejected
    const receipt = h.writes.find((r) => r.file.endsWith('deadline-forced-cleanup.json')).value
    expect(receipt.worker.signalEligible).toBe(true)
    expect(receipt.worker.current.commandName).toBe('MATCHED-NAME'.padEnd(16))
    expect(receipt.worker.initial.commandName).toBe('unit-child'.padEnd(16))
    expect(h.cleanupCalls[0]).toHaveLength(1)
  })
  for (const [name, suffix] of [
    ['direct', textRow(800, 500, undefined, 'UNRESOLVED-ROW')],
    ['deep', textRow(810, 800, undefined, 'UNRESOLVED-ROW') + textRow(800, 750) + textRow(750, 500)]
  ])
    it('C2 exposed ' + name + ' chain through absent known parent STOPs transactionally', () => {
      const h = absentKnownParentScan(suffix)
      rolledBack(h, 'inventory unresolved absent known chain')
      expect(h.owned.size).toBe(2)
      expect(h.owned.has(800)).toBe(false)
      expect(h.calls.filter((q) => q.args[0] === '-U')).toHaveLength(1)
      expect(
        h.calls.some((q) => q.args[0] === '-p' && ['750', '800', '810'].includes(q.args[1]))
      ).toBe(false)
      expect(JSON.stringify(h.failures)).not.toContain('UNRESOLVED-ROW')
      expect(h.failures[0].unresolvedKnownAnchor).toBe(h.initial[1][1])
      expect(h.failures[0].unresolvedChain).toMatchObject({
        evidenceKind: 'unproven-ancestry-edges',
        absentKnownPid: 500
      })
      expect(h.failures[0].unresolvedChain.edges.at(-1)).toEqual({
        pid: name === 'direct' ? 800 : 750,
        parent: 500
      })
      expect(h.failures[0].unresolvedChain.edges).toHaveLength(name === 'direct' ? 1 : 3)
    })
  it('C2 absent known leaf without exposed child chain stays valid and retains first object', () => {
    const h = absentKnownParentScan(textRow(900, 100, undefined, 'UNRELATED-NAME'))
    expect(h.error).toBeUndefined()
    expect(h.owned.get(500)).toBe(h.initial[1][1])
    expect(h.owned.has(900)).toBe(false)
    expect(JSON.stringify(h.result)).not.toContain('UNRELATED-NAME')
  })
})
