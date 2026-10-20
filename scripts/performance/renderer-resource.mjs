/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  RESOURCE_CONFIG,
  MILESTONES,
  ResourceController,
  compareResources,
  validateLaunch,
  validateToolingInventory
} from './renderer-resource-data.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const canonical = (map) =>
  JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const write = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForMinimum(ms, { now = () => performance.now(), wait = sleep } = {}) {
  const started = now()
  let elapsed = 0
  // Recheck the monotonic minimum after each scheduled delay.
  while (elapsed < ms) {
    await wait(ms - elapsed)
    elapsed = now() - started
  }
}

export function configureResourcePage(win) {
  win.setDefaultTimeout(RESOURCE_CONFIG.locatorMs)
}

async function cleanupBounded(label, action) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' cleanup timeout')), 10000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim()
const contained = (root, file) => {
  assert.ok(
    file && !path.isAbsolute(file) && !file.split('/').includes('..'),
    'contained frozen file'
  )
  return path.join(root, file)
}

export function verifyFrozenSide(frozen, side) {
  validateToolingInventory(frozen.toolingFiles)
  const item = frozen[side],
    root = item.root
  assert.equal(git(root, 'rev-parse', 'HEAD'), item.binding.commit)
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), item.binding.tree)
  for (const [name, files] of [
    ['source', item.sourceFiles],
    ['build', item.buildFiles],
    ['product', item.productFiles]
  ]) {
    assert.ok(Object.keys(files).length > 0, 'nonempty frozen ' + name)
    const actual = Object.fromEntries(
      Object.keys(files).map((file) => [file, hash(readFileSync(contained(root, file)))])
    )
    assert.deepEqual(actual, files, 'changed frozen ' + name)
    assert.equal(hash(canonical(files)), item.binding[name])
  }
  // The baseline product files must be the raw committed dev blobs. Tooling
  // overlays cannot replace optimized product files on the control side.
  for (const [file, sha] of Object.entries(item.productFiles))
    assert.equal(
      hash(
        execFileSync('git', ['show', `${item.binding.commit}:${file}`], {
          cwd: root,
          timeout: 10000
        })
      ),
      sha,
      'product differs from its frozen committed source'
    )
  const inventory = git(root, 'ls-files', 'src', 'plugins', 'packages')
    .split('\n')
    .filter(
      (p) => /\.(?:ts|tsx|mjs|js|css|json)$/.test(p) && !/\.test\.|\/fixtures\/|\/scripts\//.test(p)
    )
  assert.deepEqual(
    Object.keys(item.productFiles).sort(),
    inventory.sort(),
    'complete product inventory'
  )
  for (const [file, sha] of Object.entries(frozen.toolingFiles))
    assert.equal(hash(readFileSync(contained(root, file))), sha, 'identical tooling overlay')
  assert.equal(hash(canonical(frozen.toolingFiles)), item.binding.tooling)
  assert.equal(hash(readFileSync(path.join(root, 'package-lock.json'))), item.binding.lock)
  const runtime = {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    ...Object.fromEntries(
      [
        'electron',
        'react',
        'react-dom',
        'react-markdown',
        'remark-gfm',
        'playwright-core',
        '@structure-ai/fixtures',
        '@structure-ai/cqrs',
        'effect',
        'esbuild',
        'bun'
      ].map((name) => [
        name,
        readJson(path.join(root, 'node_modules', name, 'package.json')).version
      ])
    )
  }
  assert.deepEqual(runtime, frozen.runtime, 'actual installed/runtime identities')
  assert.equal(hash(canonical(runtime)), item.binding.runtime)
  const settings = {
    shell: '/bin/zsh',
    server: 'separate',
    hidden: true,
    machineUsage: false,
    profiling: false,
    backgroundThrottling: false
  }
  assert.deepEqual(frozen.settings, settings, 'fixed isolated settings')
  assert.equal(hash(canonical(settings)), item.binding.settings)
  const workload = {}
  for (const [file, sha] of Object.entries(frozen.workloadFiles)) {
    workload[file] = hash(readFileSync(contained(root, file)))
    assert.equal(workload[file], sha, 'unchanged workload dependency')
  }
  for (const file of [
    'tests/e2e/renderer-workload.mjs',
    'tests/e2e/renderer-resource-workload.mjs',
    'tests/e2e/renderer-resource-fixture.mjs',
    'tests/e2e/harness.mjs',
    'tests/e2e/namespace.mjs',
    'tests/e2e/bounds.mjs',
    'scripts/server-process.mjs'
  ])
    assert.ok(
      workload[file] && frozen.toolingFiles[file],
      'complete transitive tool/workload overlay'
    )
  assert.equal(hash(canonical(workload)), item.binding.workload)

  const output = []
  const visit = (dir) => {
    for (const ent of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = dir + '/' + ent.name
      if (ent.isDirectory()) visit(p)
      else output.push(p)
    }
  }
  visit('out')
  assert.deepEqual(
    output.sort(),
    Object.keys(item.buildFiles).sort(),
    'complete actual output inventory'
  )
  return item
}

// Only proven descendants of this owned application are inspected. `comm`
// avoids reading arguments or environment. Creation identity fences PID reuse.
export function processIdentity(pid) {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 10000
    }).trim()
    const match = value.match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)
    assert.ok(match, 'known owned process creation identity')
    return {
      pid: Number(match[1]),
      parent: Number(match[2]),
      creation: match[3],
      executable: match[4]
    }
  } catch (error) {
    if (error.status === 1) return null
    throw error
  }
}

async function forceOwnedCleanup(identities) {
  const receipt = []
  for (const identity of [...identities].reverse()) {
    const current = processIdentity(identity.pid)
    if (!current || current.creation !== identity.creation) continue
    process.kill(identity.pid, 'SIGTERM')
    receipt.push({ ...identity, signal: 'SIGTERM' })
  }
  await sleep(250)
  for (const identity of receipt) {
    const current = processIdentity(identity.pid)
    if (current?.creation === identity.creation) {
      process.kill(identity.pid, 'SIGKILL')
      identity.signal = 'SIGKILL'
    }
  }
  return receipt
}

async function launch(frozen, side, index, evidence) {
  const item = verifyFrozenSide(frozen, side)
  assert.equal(
    path.resolve(process.cwd()),
    path.resolve(item.root),
    'side runs from its own tooling overlay'
  )
  const {
    launchApp,
    seedWorkspaces,
    seedTrustedRoots,
    fixturePath,
    separateServerDataDir,
    liveAppPids
  } = await import('../../tests/e2e/harness.mjs')
  const { frames } = await import('../../tests/e2e/renderer-workload.mjs')
  const {
    loadResourceScenario,
    warmResource,
    replaceResource,
    assertPopulation,
    disposeResourceWork
  } = await import('../../tests/e2e/renderer-resource-workload.mjs')
  const dir = fixturePath('renderer-resource-' + side + '-' + index + '-' + randomUUID())
  const root = path.join(dir, 'workspace')
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [
      { id: 'resource', name: 'Resource', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'resource',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  let eventSequence = 0,
    app,
    win,
    fixture
  const persist = (value) => write(path.join(evidence, `event-${++eventSequence}.json`), value)
  const controller = new ResourceController(persist)
  const result = {
    side,
    index,
    status: 'RUNNING',
    binding: item.binding,
    config: RESOURCE_CONFIG,
    startedAt: Date.now(),
    observations: controller.samples,
    errors: [],
    originalLongIds: [],
    closures: 0
  }
  const owned = new Map()
  const own = (pid, role, expectedParent = null) => {
    assert.ok(Number.isInteger(pid) && pid > 0, 'known owned PID')
    const identity = processIdentity(pid)
    assert.ok(identity, 'owned process is alive when identified')
    if (expectedParent !== null) assert.equal(identity.parent, expectedParent, 'proven owned child')
    if (owned.has(pid)) assert.equal(owned.get(pid).creation, identity.creation, 'owned PID reused')
    owned.set(pid, { ...identity, role: owned.get(pid)?.role || role })
  }
  const inventory = async () => {
    const discovery = readJson(path.join(dir, 'clave-server.json'))
    own(discovery.serverPid, 'server', app.process().pid)
    const terminal = readJson(path.join(separateServerDataDir(dir), 'clave-server.json'))
    own(terminal.terminalProcessPid, 'terminal-process', discovery.serverPid)
    const queue = [...owned.values()],
      visited = new Set()
    while (queue.length) {
      const identity = queue.shift()
      if (visited.has(identity.pid)) continue
      visited.add(identity.pid)
      const current = processIdentity(identity.pid)
      if (!current || current.creation !== identity.creation) continue
      let children
      try {
        children = execFileSync('pgrep', ['-P', String(identity.pid)], {
          encoding: 'utf8',
          timeout: 10000
        })
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number)
      } catch (e) {
        if (e.status !== 1) throw e
        children = []
      }
      for (const pid of children) {
        own(pid, 'descendant', identity.pid)
        queue.push(owned.get(pid))
      }
    }
    for (const metric of await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type }))
    ))
      if (!owned.has(metric.pid))
        own(metric.pid, metric.type === 'Tab' ? 'renderer' : 'utility', app.process().pid)
    persist({ owned: [...owned.values()] })
  }
  const target = () =>
    app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length !== 1) throw new Error('one owned renderer target required')
      const win = windows[0]
      return {
        id: String(win.webContents.id),
        pid: win.webContents.getOSProcessId(),
        hidden: !win.isVisible(),
        backgroundThrottling: win.webContents.getBackgroundThrottling()
      }
    })
  try {
    ;({ app, win, fixture } = await controller.bounded(
      'boot',
      () =>
        launchApp(dir, {
          server: 'separate',
          env: { SHELL: '/bin/zsh' },
          args: ['--dev-echo-adapter', '--test-no-machine-usage']
        }),
      60000
    ))
    configureResourcePage(win)
    own(app.process().pid, 'main')
    win.on('pageerror', (error) =>
      result.errors.push({ kind: 'pageerror', message: error.message })
    )
    win.on('console', (message) => {
      if (message.type() === 'error')
        result.errors.push({ kind: 'console', message: message.text() })
    })
    result.target = await target()
    own(result.target.pid, 'renderer', app.process().pid)
    assert.equal(result.target.hidden, true)
    assert.equal(result.target.backgroundThrottling, false)
    await inventory()
    const scenario = await controller.bounded(
      'fixture readiness',
      () => loadResourceScenario(app, win, fixture, root, path.join(evidence, 'scenario.mjs')),
      120000
    )
    assert.deepEqual(scenario.completed, ['chat/renderer-resource'])
    result.runId = scenario.runId
    result.scenario = {
      name: 'chat/renderer-resource',
      runId: scenario.runId,
      completed: scenario.completed
    }
    persist({ scenario })
    const { records, groups } = scenario.values.workload
    result.originalLongIds = records.slice(0, 20)
    const measure = async (label, content = null) => {
      const population = await assertPopulation(
        win,
        records,
        groups,
        result.originalLongIds,
        label.endsWith('closed')
      )
      await inventory()
      assert.deepEqual(await target(), result.target, 'same intended renderer')
      assert.deepEqual(result.errors, [])
      const disposed = await disposeResourceWork(win, fixture)
      assert.deepEqual(
        disposed,
        { renderer: { absent: true, found: false }, producer: { absent: true, found: false } },
        'unexpected retained waiter/producer blocks sample'
      )
      const disposal = controller.quiescence()
      const startedAt = Date.now()
      await frames(win)
      const elapsedStart = performance.now()
      await waitForMinimum(1000)
      const elapsedMs = performance.now() - elapsedStart
      await frames(win)
      const settle = {
        startedAt,
        endedAt: Date.now(),
        configuredMs: 1000,
        elapsedMs,
        beforeFrames: 2,
        afterFrames: 2
      }
      // Same Playwright page target; no evaluate, handle acquisition, debugger,
      // snapshot or other command may enter this measurement transaction.
      const cdp = await controller.bounded(
        'CDP attach',
        () => win.context().newCDPSession(win),
        10000
      )
      const sessionToken = randomUUID()
      controller.own('measurement-CDP-session', sessionToken)
      const commands = []
      let usage,
        detached = false
      try {
        for (const method of [
          'Runtime.releaseObjectGroup',
          'HeapProfiler.collectGarbage',
          'HeapProfiler.collectGarbage',
          'Runtime.getHeapUsage'
        ]) {
          const began = Date.now()
          const response = await controller.bounded(
            method,
            () =>
              cdp.send(
                method,
                method === 'Runtime.releaseObjectGroup' ? { objectGroup: 'renderer-resource' } : {}
              ),
            10000
          )
          commands.push({
            method,
            startedAt: began,
            endedAt: Date.now(),
            acknowledged: true,
            result: response
          })
          if (method === 'Runtime.getHeapUsage') {
            usage = response
            persist({ rawHeapUsage: response, label, target: result.target })
          }
        }
      } finally {
        await cleanupBounded('CDP detach', () => cdp.detach())
        detached = true
        controller.disposed(sessionToken, true)
      }
      controller.accept({
        label,
        origin: 'Runtime.getHeapUsage',
        synthetic: false,
        rawId: randomUUID(),
        at: Date.now(),
        target: result.target,
        usage,
        disposal,
        settle,
        commands,
        detached,
        population,
        content
      })
    }
    await measure('warm', await warmResource({ app, win, fixture, records, cycle: 0, controller }))
    persist({
      replacement: await replaceResource({ app, win, fixture, root, records, groups }),
      sampled: false
    })
    result.closures++
    for (let cycle = 1; cycle <= 5; cycle++) {
      await measure(
        `cycle-${cycle}-warm`,
        await warmResource({ app, win, fixture, records, cycle, controller })
      )
      persist({ replacement: await replaceResource({ app, win, fixture, root, records, groups }) })
      result.closures++
      await measure(`cycle-${cycle}-closed`)
    }
    await measure('final-closed')
    assert.deepEqual(
      controller.samples.map((s) => s.label),
      MILESTONES
    )
    result.status = 'SAMPLED_PENDING_CLEANUP'
  } catch (error) {
    controller.fail(error)
    result.status = 'FAIL'
    result.failure = controller.failure
  } finally {
    const cleanup = {
      complete: false,
      forced: false,
      timedOut: false,
      unknown: [],
      processes: [],
      profileRemoved: false
    }
    try {
      if (win && fixture) persist({ cleanupDisposal: await disposeResourceWork(win, fixture) })
      if (app) {
        await inventory()
        writeFileSync(
          path.join(dir, 'resource-empty.html'),
          '<!doctype html><html><body></body></html>'
        )
        await win.goto(pathToFileURL(path.join(dir, 'resource-empty.html')).href)
        const child = app.process()
        await app.close()
        cleanup.forced = child.signalCode !== null || child.exitCode !== 0
        const end = Date.now() + 10000
        do {
          cleanup.processes = [...owned.values()].map((p) => {
            const now = processIdentity(p.pid)
            return { ...p, exited: now === null || now.creation !== p.creation }
          })
          if (cleanup.processes.every((p) => p.exited)) break
          await sleep(100)
        } while (Date.now() < end)
        cleanup.timedOut = cleanup.processes.some((p) => !p.exited)
        assert.ok(
          !cleanup.forced && !cleanup.timedOut,
          'forced/timeout teardown is not a clean resource launch'
        )
      } else {
        cleanup.unknown.push('boot did not return a complete owned application identity')
        for (const pid of liveAppPids()) own(pid, 'main')
        cleanup.forced = true
        cleanup.forcedActions = await forceOwnedCleanup(owned.values())
      }
      rmSync(dir, { recursive: true, force: false })
      cleanup.profileRemoved = !existsSync(dir)
      cleanup.complete =
        !!app &&
        !cleanup.forced &&
        !cleanup.timedOut &&
        cleanup.unknown.length === 0 &&
        cleanup.profileRemoved
    } catch (error) {
      cleanup.unknown.push(error.message)
      controller.fail(error)
      result.status = 'FAIL'
      cleanup.forced = true
      try {
        cleanup.forcedActions = await forceOwnedCleanup(owned.values())
      } catch (forcedError) {
        cleanup.unknown.push(forcedError.message)
      }
    }
    result.cleanup = cleanup
    result.endedAt = Date.now()
    if (result.errors.length) result.status = 'FAIL'
    if (result.status === 'SAMPLED_PENDING_CLEANUP' && cleanup.complete) result.status = 'COMPLETE'
    write(path.join(evidence, 'launch.json'), result)
  }
  validateLaunch(result, frozen, side, index)
  return result
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      freeze: { type: 'string' },
      go: { type: 'string' },
      out: { type: 'string' },
      side: { type: 'string' },
      index: { type: 'string' }
    },
    allowPositionals: false
  })
  assert.ok(
    values.freeze && values.go && values.out,
    'explicit future root freeze, qualification GO and evidence directory required'
  )
  const frozen = readJson(values.freeze),
    go = readJson(values.go)
  assert.equal(go.purpose, 'whole-renderer-resource-collection')
  assert.equal(go.authorized, true)
  assert.equal(go.freezeSha256, hash(readFileSync(values.freeze)), 'GO binds exact freeze')
  assert.equal(
    go.qualificationVerdict,
    'PASS',
    'real isolated negative/cleanup qualification must precede collection'
  )
  assert.equal(frozen.schema, 1)
  for (const side of ['control', 'candidate']) verifyFrozenSide(frozen, side)
  assert.ok(
    frozen.control.rawCurrentDev === true &&
      frozen.control.binding.product !== frozen.candidate.binding.product
  )
  assert.equal(
    git(frozen.control.root, 'ls-remote', 'origin', 'refs/heads/dev').split(/\s/)[0],
    frozen.control.binding.commit,
    'raw dev moved since freeze'
  )
  if (values.side) {
    assert.ok(
      ['control', 'candidate'].includes(values.side) && ['1', '2', '3'].includes(values.index)
    )
    return launch(frozen, values.side, Number(values.index), values.out)
  }
  mkdirSync(values.out, { recursive: false })
  const runs = []
  for (const side of ['control', 'candidate'])
    for (let index = 1; index <= 3; index++) {
      const evidence = path.join(values.out, `${side}-${index}`)
      mkdirSync(evidence)
      const log = []
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              path.join(frozen[side].root, 'scripts/performance/renderer-resource.mjs'),
              '--freeze',
              path.resolve(values.freeze),
              '--go',
              path.resolve(values.go),
              '--out',
              path.resolve(evidence),
              '--side',
              side,
              '--index',
              String(index)
            ],
            {
              cwd: frozen[side].root,
              env: {
                ...process.env,
                SHELL: '/bin/zsh',
                CLAVE_E2E_NS: 'renderer-resource-' + randomUUID()
              },
              stdio: ['ignore', 'pipe', 'pipe']
            }
          )
          let expired = false
          const timer = setTimeout(async () => {
            expired = true
            try {
              const snapshots = readdirSync(evidence)
                .filter((p) => /^event-\d+\.json$/.test(p))
                .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
                .map((p) => readJson(path.join(evidence, p)))
              const identities = new Map(
                snapshots.flatMap((s) => s.owned || []).map((p) => [p.pid, p])
              )
              const worker = processIdentity(child.pid)
              if (worker) identities.set(worker.pid, worker)
              write(path.join(evidence, 'deadline-forced-cleanup.json'), {
                forced: true,
                timedOut: true,
                actions: await forceOwnedCleanup(identities.values()),
                later: 'NOTRUN'
              })
            } catch (error) {
              log.push(Buffer.from('deadline cleanup failed: ' + error.message + '\n'))
            }
            reject(new Error('launch ceiling; late results fenced, all later NOTRUN'))
          }, 600000)
          child.stdout.on('data', (b) => log.push(b))
          child.stderr.on('data', (b) => log.push(b))
          child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.on('exit', (code, signal) => {
            clearTimeout(timer)
            code === 0 && !signal && !expired
              ? resolve()
              : reject(new Error(`launch failed code=${code} signal=${signal}`))
          })
        })
        runs.push(readJson(path.join(evidence, 'launch.json')))
      } catch (error) {
        write(path.join(values.out, 'first-failure.json'), {
          side,
          index,
          error: error.message,
          completeLaunches: runs.length,
          later: 'NOTRUN'
        })
        throw error
      } finally {
        writeFileSync(path.join(evidence, 'raw.log'), Buffer.concat(log))
      }
    }
  const verdict = compareResources(runs, frozen)
  write(path.join(values.out, 'comparison.json'), verdict)
  return verdict
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2))
