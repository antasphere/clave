/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import {
  processIdentity,
  identifyOwnedProcess,
  captureResourceWorker,
  resourceWorkerExit,
  resourceWorkerForCleanup
} from './renderer-resource.mjs'

const parent = {
  pid: 100,
  parent: 50,
  creation: 'Tue Oct 20 22:08:07 2026',
  executable: '/unit/node',
  role: 'main'
}
const row = (pid = 200, ppid = 100, created = 'Tue Oct 20 22:08:08 2026') =>
  `${pid} ${ppid} ${created} /unit/child\n`
const gone = () => {
  throw Object.assign(new Error('synthetic clean no-row'), {
    status: 1,
    signal: null,
    stdout: '',
    stderr: ''
  })
}
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
        query: { command: 'ps', status: 1, signal: null, stdout: '', stderr: '' },
        observedIdentity: null,
        later: 'NOTRUN'
      })
    })
  it('uses actual successful query bytes and keeps the existing role', () => {
    const c = context()
    c.own(() => row())
    c.own(() => row())
    expect(c.owned.get(200)).toEqual({
      pid: 200,
      parent: 100,
      creation: 'Tue Oct 20 22:08:08 2026',
      executable: '/unit/child',
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
    expect(() => processIdentity(200, { query: () => '' })).toThrow(
      'known owned process creation identity'
    )
  })
})

describe('OWN-D1 truthful stdout-only success observability', () => {
  const backendWarning = 'SYNTHETIC backend stderr is not returned by execFileSync'
  it('records successful PS stderr as unobserved on the actual helper', () => {
    const receipts = []
    let calls = 0
    const backend = { stdout: row(), stderr: backendWarning }
    const identity = processIdentity(200, {
      query: (command, args, options) => {
        calls++
        expect(command).toBe('ps')
        expect(args).toEqual(['-p', '200', '-o', 'pid=,ppid=,lstart=,comm='])
        expect(options).toEqual({ encoding: 'utf8', timeout: 10000 })
        return backend.stdout
      },
      onQuery: (r) => receipts.push(r)
    })
    expect(identity.pid).toBe(200)
    expect(calls).toBe(1)
    expect(backend.stderr.length).toBeGreaterThan(0)
    expect(receipts[0].stdout).toBe(backend.stdout)
    expect(receipts[0].stderr).toBeNull()
    expect(receipts[0].observability).toEqual({ stdout: true, stderr: false })
  })
  it('records successful actual inventory pgrep-branch stderr as unobserved', () => {
    const execute = new Function(
      'execFileSync',
      'identity',
      'phase',
      'persist',
      'current',
      'let children, discoveryQuery;\n' + actualPGrepTry + '\nreturn {children,discoveryQuery}'
    )
    const backend = { stdout: '200\n', stderr: backendWarning }
    let calls = 0
    const result = execute(
      (command, args, options) => {
        calls++
        expect(command).toBe('pgrep')
        expect(args).toEqual(['-P', '100'])
        expect(options).toEqual({ encoding: 'utf8', timeout: 10000 })
        return backend.stdout
      },
      parent,
      'unit.inventory',
      () => {
        throw new Error('unexpected persistence on successful query')
      },
      parent
    )
    expect(calls).toBe(1)
    expect(result.children).toEqual([200])
    expect(backend.stderr.length).toBeGreaterThan(0)
    expect(result.discoveryQuery.stdout).toBe(backend.stdout)
    expect(result.discoveryQuery.stderr).toBeNull()
    expect(result.discoveryQuery.observability).toEqual({ stdout: true, stderr: false })
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
const actualPGrepTry = sourceNode(
  (node) =>
    ts.isTryStatement(node) && node.tryBlock.getText(actualTree).includes("execFileSync('pgrep'")
).getText(actualTree)
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
    resourceWorkerForCleanup
  }
  const query = (command, args, options) => {
    assert.equal(command, 'ps')
    assert.deepEqual(plain(args), ['-p', String(childPID), '-o', 'pid=,ppid=,lstart=,comm='])
    assert.deepEqual(plain(options), { encoding: 'utf8', timeout: 10000 })
    queries.push(plain(args))
    events.push('identity-query')
    if (initialGone) return gone()
    const later = queries.length > 1
    if (later && currentIdentity === 'absent') return gone()
    return row(
      childPID,
      later && currentIdentity === 'reparented' ? 999 : 100,
      later && currentIdentity === 'reused'
        ? 'Tue Oct 20 22:08:09 2026'
        : 'Tue Oct 20 22:08:08 2026'
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
      executable: '/unit/child'
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

async function inventoryHarness({ mode = 'none', queryError = null } = {}) {
  const owned = new Map([
    [
      200,
      {
        pid: 200,
        parent: 100,
        creation: 'Tue Oct 20 22:08:08 2026',
        executable: '/unit/main',
        role: 'main'
      }
    ]
  ])
  const events = [],
    queries = []
  const query = (command, args, options) => {
    queries.push({ command, args: plain(args), options: plain(options) })
    const pid = Number(args[1])
    if (command === 'ps') {
      if (pid === 500 && mode === 'disappeared') return gone()
      return row(pid, pid === 200 ? 100 : pid === 300 ? 200 : pid === 400 ? 300 : 200)
    }
    assert.equal(command, 'pgrep')
    if (queryError) throw queryError
    if (pid === 200 && mode === 'disappeared') return '500\n'
    if (mode === 'malformed') return 'not-a-PID\n'
    return gone()
  }
  const context = {
    owned,
    path,
    dir: '/unit',
    separateServerDataDir: () => '/unit/server',
    readJson: (file) =>
      file === '/unit/clave-server.json' ? { serverPid: 300 } : { terminalProcessPid: 400 },
    app: { process: () => ({ pid: 200 }), evaluate: async () => [] },
    persist: (value) => events.push(plain(value)),
    execFileSync: query,
    processIdentity: (pid) => processIdentity(pid, { query })
  }
  context.own = (pid, role, ppid, site) =>
    identifyOwnedProcess(
      owned,
      pid,
      role,
      ppid,
      site,
      (failure) => events.push({ ownershipFailure: plain(failure) }),
      query
    )
  const run = vm.runInContext('(' + actualInventory + ')', vm.createContext(context))
  let error
  try {
    await run('unit.inventory')
  } catch (caught) {
    error = caught
  }
  return { owned, events, queries, error }
}
describe('actual production inventory discovery/query branch with in-memory dependencies', () => {
  it('accepts clean no-child query without treating absent admission as optional', async () => {
    const h = await inventoryHarness()
    expect(h.error).toBeUndefined()
    expect(h.owned.size).toBe(3)
    expect(h.events.at(-1).owned).toHaveLength(3)
  })
  for (const fields of [
    { status: 1, signal: null, stdout: '', stderr: 'pgrep: permission denied\n' },
    { status: 1, signal: null, stdout: '500\n', stderr: '' },
    { status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', stdout: '', stderr: '' },
    { code: 'ENOENT' }
  ])
    it(
      'preserves the exact unknown discovery error and contextual receipt ' +
        JSON.stringify(fields),
      async () => {
        const error = Object.assign(new Error('synthetic discovery error'), fields)
        const h = await inventoryHarness({ queryError: error })
        expect(h.error).toBe(error)
        expect(h.events[0].ownershipDiscoveryFailure).toMatchObject({
          context: 'unit.inventory.pgrep-parent',
          parent: { pid: 200, creation: 'Tue Oct 20 22:08:08 2026' },
          query: { stdout: fields.stdout ?? '', stderr: fields.stderr ?? '' }
        })
        expect(h.events.some((r) => r.owned)).toBe(false)
      }
    )
  it('discovered child disappearance still STOPs with exact parent/site and observed query fields', async () => {
    const h = await inventoryHarness({ mode: 'disappeared' })
    expect(h.error.message).toBe('owned process is alive when identified')
    expect(h.owned.has(500)).toBe(false)
    expect(h.events[0].ownershipFailure).toMatchObject({
      pid: 500,
      role: 'descendant',
      expectedParent: 200,
      context: {
        site: 'unit.inventory.pgrep-child',
        discoveredParent: { pid: 200 },
        discoveryQuery: {
          stdout: '500\n',
          stderr: null,
          observability: { stdout: true, stderr: false }
        }
      },
      query: { status: 1, stdout: '', stderr: '' },
      later: 'NOTRUN'
    })
  })
  it('malformed discovered numeric PID is unknown and rejected without map admission', async () => {
    const h = await inventoryHarness({ mode: 'malformed' })
    expect(h.error.message).toBe('known owned PID')
    expect(h.owned.size).toBe(3)
    expect(h.events[0].ownershipFailure.observedIdentity).toBeNull()
  })
})
