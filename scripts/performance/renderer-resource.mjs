/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync
} from 'node:fs'
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

// Kernel ucomm is bounded diagnostic metadata, NOT a path or ownership credential.
// Queries acquire neither argv nor environment. All raw query data is transient.
export const OWNERSHIP_QUERY = Object.freeze({ timeout: 10000, maxBuffer: 1024 * 1024 })
const identityFields = 'ruid=,pid=,ppid=,lstart=,ucomm='
const positivePid = (n) => Number.isSafeInteger(n) && n > 0
const validUid = (n) => Number.isSafeInteger(n) && n > 0
const ownershipCheck = (ok, category) => {
  // Never attach raw output, a parser input or a child-process Error/cause.
  if (!ok) throw new Error(category)
}

export function validateOwnershipRunner(realUid, effectiveUid, fixtureBound) {
  ownershipCheck(validUid(realUid) && realUid === effectiveUid, 'ownership runner UID scope')
  ownershipCheck(fixtureBound === true, 'ownership fixture inheritance bound')
  return realUid
}

// Exact reviewed fixture/spawn sources: these paths must enter the NEW freeze.
// Source inheritance is conditional on this fixed echo fixture, never child EUID proof.
export const OWNERSHIP_FIXTURE_SOURCES = Object.freeze({
  'tests/e2e/harness.mjs': '5e78f11a6f3169f54e09dd206d919817d12d47363698395b868ff22fb25a8b4d',
  'tests/e2e/renderer-resource-workload.mjs':
    '21c4a6817652fe4b8f3e90a6ba71fcf4deb5d883fd48f005d02fcd00d89ce9ff',
  'tests/e2e/renderer-resource-fixture.mjs':
    '7afa9ed987c9fbae0e4dca5083ddfa24d33893bf804c83cf7ccf7fcf2d908614',
  'src/main/sessions/adapters/echo-adapter.ts':
    '98f5fde28f2169de6e51b35a17849f24930be150a27629ba0f75853313d231df',
  'src/main/sessions/session-manager.ts':
    '3b2e9422dbcfcffbdc99140efbb280ccead5b2bcbc81a7ac02fd35558e0a8949',
  'src/main/server-child.ts': 'a52bcbe2fbac42a3a145b6eb7481eade568346dd71b8bbf3f4628f7de1f5a246',
  'src/main/server-entry.ts': 'ab1cf87cce428942fa655dd116b9c8dba63c841d34e734c39de8c692d7989000',
  'src/main/terminal-process/supervisor.ts':
    '91638099f61e11cee25ffcc4da233574cb96f4af85b3ce1d21b30fe7c0880ed7',
  'src/main/terminal-process/announcing.ts':
    '95fbd39229f836c9ff17c0b31d9314cfc1ab6194af74fd0f83c87d67e84ff938'
})
export function verifyOwnershipFixture(
  frozen,
  side,
  {
    realUid = process.getuid(),
    effectiveUid = process.geteuid(),
    read = readFileSync,
    stat = statSync,
    execPath = process.execPath
  } = {}
) {
  validateOwnershipRunner(realUid, effectiveUid, true)
  const item = frozen[side]
  ownershipCheck(
    frozen.ownershipFixture?.schema === 2 &&
      frozen.ownershipFixture.fixture === 'chat/renderer-resource' &&
      frozen.ownershipFixture.provider === 'dev-echo-adapter' &&
      frozen.ownershipFixture.credentialScope === 'nonroot-inherited-real-equal-effective' &&
      frozen.ownershipFixture.credentialChangingActions === false,
    'ownership explicit frozen fixture scope'
  )
  for (const [file, sha] of Object.entries(OWNERSHIP_FIXTURE_SOURCES)) {
    ownershipCheck(
      item.sourceFiles[file] === sha || frozen.toolingFiles[file] === sha,
      'ownership frozen fixture source coverage'
    )
    ownershipCheck(
      hash(read(contained(item.root, file))) === sha,
      'ownership fixture source changed'
    )
  }
  const app = 'node_modules/electron/dist/Electron.app/Contents/'
  const executables = [
    execPath,
    '/bin/zsh',
    path.join(item.root, app + 'MacOS/Electron'),
    ...[
      'Electron Helper',
      'Electron Helper (Renderer)',
      'Electron Helper (GPU)',
      'Electron Helper (Plugin)'
    ].map((name) =>
      path.join(item.root, app + 'Frameworks/' + name + '.app/Contents/MacOS/' + name)
    )
  ]
  for (const file of executables) {
    const mode = stat(file)
    ownershipCheck(
      mode.isFile() && (mode.mode & 0o6000) === 0 && (mode.mode & 0o111) !== 0,
      'ownership unprivileged executable mode'
    )
  }
  return {
    schema: 2,
    realUid,
    effectiveUid,
    fixture: 'chat/renderer-resource',
    provider: 'dev-echo-adapter',
    sourceFiles: OWNERSHIP_FIXTURE_SOURCES,
    executableModesChecked: executables.length,
    limitation:
      'fixed unprivileged fixture inheritance; RUID is not per-child EUID; no arbitrary privileged/provider coverage'
  }
}

export function decodeIdentityRows(bytes, realUid) {
  ownershipCheck(
    Buffer.isBuffer(bytes) && bytes.length <= OWNERSHIP_QUERY.maxBuffer,
    'identity buffer bound'
  )
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('identity encoding')
  }
  ownershipCheck(
    text.length > 0 && text.endsWith('\n') && !/[\p{C}\p{Z}]/u.test(text.replace(/[ \n]/g, '')),
    'identity whole framing'
  )
  const rows = new Map()
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  for (const line of text.slice(0, -1).split('\n')) {
    // Apple's formatter prints lstart width28 (C %c is24 bytes), then
    // ONE separator and ucomm minimum width16. Preserve that last field
    // verbatim: padding and a kernel-name trailing space cannot be told apart.
    // It is diagnostic text, never a normalized name or an ownership key.
    const encoded = Buffer.from(line)
    ownershipCheck(encoded.length >= 16, 'identity complete row')
    const commandField = encoded.subarray(-16).toString('utf8')
    const m = encoded
      .subarray(0, -16)
      .toString('utf8')
      .match(
        /^ *([0-9]+) +([0-9]+) +([0-9]+) +((Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ([ 0-9][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})) {5}$/u
      )
    ownershipCheck(m !== null, 'identity complete row')
    const uid = Number(m[1]),
      pid = Number(m[2]),
      parent = Number(m[3])
    const month = months.indexOf(m[6]),
      date = Number(m[7]),
      hour = Number(m[8]),
      minute = Number(m[9]),
      second = Number(m[10]),
      year = Number(m[11])
    const calendar = new Date(Date.UTC(year, month, date, hour, minute, second))
    ownershipCheck(
      month >= 0 &&
        year >= 1970 &&
        calendar.getUTCFullYear() === year &&
        calendar.getUTCMonth() === month &&
        calendar.getUTCDate() === date &&
        hour < 24 &&
        minute < 60 &&
        second < 60 &&
        days[calendar.getUTCDay()] === m[5],
      'identity C creation codec'
    )
    ownershipCheck(validUid(uid) && uid === realUid, 'identity selected real UID')
    ownershipCheck(
      positivePid(pid) && Number.isSafeInteger(parent) && parent >= 0 && parent !== pid,
      'identity PID parent'
    )
    ownershipCheck(
      Buffer.byteLength(commandField) === 16 &&
        /[^ ]/u.test(commandField) &&
        !commandField.includes('\ufffd'),
      'identity kernel name field'
    )
    ownershipCheck(!rows.has(pid), 'identity duplicate PID')
    rows.set(pid, {
      schema: 2,
      realUid: uid,
      pid,
      parent,
      creation: m[4],
      creationCodec: 'ps-lstart-C-seconds',
      commandName: commandField,
      commandNameCodec: 'ps-ucomm-field-width16-verbatim',
      commandSource: 'ps.ucomm'
    })
  }
  return rows
}

function identityQuery(args, realUid, query, onQuery, allowAbsent = false) {
  // spawnSync exposes BOTH streams even on status0. Its default buffer ceiling
  // (1MiB) and original ten-second deadline are explicit, unchanged bounds.
  let result
  try {
    result = query('/bin/ps', args, {
      ...OWNERSHIP_QUERY,
      shell: false,
      encoding: 'buffer',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    onQuery({
      command: '/bin/ps',
      args,
      category: 'query-threw',
      observability: { stdout: false, stderr: false }
    })
    throw new Error('identity query threw')
  }
  const stdout = result?.stdout,
    stderr = result?.stderr
  const streams = Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr)
  const status = Number.isInteger(result?.status) ? result.status : null
  const signal =
    result?.signal === null
      ? null
      : /^SIG[A-Z0-9]{1,12}$/.test(result?.signal)
        ? result.signal
        : 'invalid-or-unobserved'
  const code = ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EIO'].includes(
    result?.error?.code
  )
    ? result.error.code
    : result?.error
      ? 'OTHER'
      : null
  const outcome = {
    command: '/bin/ps',
    args,
    status,
    signal,
    failed: !!result?.error,
    code,
    stdoutBytes: Buffer.isBuffer(stdout) ? stdout.length : null,
    stderrBytes: Buffer.isBuffer(stderr) ? stderr.length : null,
    observability: { stdout: Buffer.isBuffer(stdout), stderr: Buffer.isBuffer(stderr) },
    ...OWNERSHIP_QUERY
  }
  onQuery(outcome)
  ownershipCheck(
    streams &&
      stdout.length <= OWNERSHIP_QUERY.maxBuffer &&
      stderr.length <= OWNERSHIP_QUERY.maxBuffer,
    'identity query streams/bound'
  )
  ownershipCheck(
    !result.error && signal === null && stderr.length === 0,
    'identity query diagnostics'
  )
  if (allowAbsent && status === 1 && stdout.length === 0) return null
  ownershipCheck(status === 0, 'identity query status')
  return decodeIdentityRows(stdout, realUid)
}

export function processIdentity(
  pid,
  { query = spawnSync, onQuery = () => {}, realUid = process.getuid() } = {}
) {
  ownershipCheck(positivePid(pid), 'known owned PID')
  ownershipCheck(validUid(realUid), 'identity selected real UID')
  const rows = identityQuery(
    ['-p', String(pid), '-ww', '-o', identityFields],
    realUid,
    query,
    onQuery,
    true
  )
  if (rows === null) return null
  ownershipCheck(rows.size === 1 && rows.has(pid), 'queried owned PID matches result')
  return rows.get(pid)
}

function sameOwnedInstance(initial, current) {
  ownershipCheck(initial?.schema === 2 && current?.schema === 2, 'identity schema2 required')
  ownershipCheck(
    initial.pid === current.pid &&
      initial.creation === current.creation &&
      initial.creationCodec === current.creationCodec,
    'owned PID reused'
  )
  ownershipCheck(initial.parent === current.parent, 'owned parent changed')
  ownershipCheck(initial.realUid === current.realUid, 'owned UID changed')
}

function firstOwnedIdentity(identity, role, context, acquisition) {
  return Object.freeze({
    ...identity,
    role,
    provenance: Object.freeze({ site: context.site, acquisition, expectedParent: identity.parent })
  })
}

// Rejected current rows are not proven owned. Retain only the comparison
// tuple, never their diagnostic name/source/provenance or arbitrary fields.
export function unprovenIdentityEvidence(identity) {
  if (identity === null) return null
  return {
    evidenceKind: 'unproven-comparison-tuple',
    pid: identity.pid,
    parent: identity.parent,
    creation: identity.creation,
    creationCodec: identity.creationCodec,
    realUid: identity.realUid,
    diagnosticMetadataOmitted: true
  }
}

export function identifyOwnedProcess(
  owned,
  pid,
  role,
  expectedParent,
  context,
  recordFailure,
  query = spawnSync
) {
  const attempt = {
    pid,
    role,
    expectedParent,
    context,
    expectedParentIdentity: owned.get(expectedParent) || null,
    previousIdentity: owned.get(pid) || null,
    query: null,
    observedIdentity: null
  }
  try {
    const identity = processIdentity(pid, {
      query,
      onQuery: (outcome) => {
        attempt.query = outcome
      }
    })
    attempt.observedIdentity = identity
    ownershipCheck(identity !== null, 'owned process is alive when identified')
    ownershipCheck(
      expectedParent === null || identity.parent === expectedParent,
      'proven owned child'
    )
    if (owned.has(pid)) {
      sameOwnedInstance(owned.get(pid), identity)
      return owned.get(pid)
    }
    const initial = firstOwnedIdentity(identity, role, context, 'targeted-ucomm')
    owned.set(pid, initial)
    return initial
  } catch (error) {
    recordFailure({
      ...attempt,
      observedIdentity: unprovenIdentityEvidence(attempt.observedIdentity),
      message: error.message,
      later: 'NOTRUN'
    })
    throw error
  }
}

export function captureOwnedInventory({
  owned,
  rootPid,
  required,
  realUid,
  effectiveUid,
  fixtureBound,
  context,
  query = spawnSync,
  recordFailure = () => {}
}) {
  let queryReceipt = null,
    unresolvedKnownAnchor = null,
    unresolvedChain = null
  const fences = []
  const observe = (pid, stage) => {
    const fence = { pid, stage, query: null, identity: null }
    fences.push(fence)
    fence.identity = processIdentity(pid, {
      query,
      realUid,
      onQuery: (receipt) => {
        fence.query = receipt
      }
    })
    return fence.identity
  }
  try {
    validateOwnershipRunner(realUid, effectiveUid, fixtureBound)
    const root = owned.get(rootPid)
    ownershipCheck(root?.role === 'main', 'inventory known main anchor')
    const needed = new Map(required.map((r) => [r.pid, r]))
    ownershipCheck(
      needed.size === required.length &&
        required.every(
          (r) =>
            positivePid(r.pid) &&
            r.pid !== rootPid &&
            positivePid(r.parent) &&
            ['server', 'terminal-process', 'renderer', 'utility'].includes(r.role)
        ),
      'inventory required role references'
    )
    ownershipCheck(
      ['server', 'terminal-process'].every((role) => required.some((r) => r.role === role)) &&
        [...owned.values(), ...required].some((r) => r.role === 'renderer'),
      'inventory mandatory role coverage'
    )
    needed.set(rootPid, { pid: rootPid, parent: root.parent, role: 'main' })
    for (const initial of owned.values()) {
      ownershipCheck(
        initial.schema === 2 && initial.realUid === realUid,
        'inventory initial schema/UID'
      )
      if (['main', 'server', 'terminal-process', 'renderer'].includes(initial.role)) {
        const ref = needed.get(initial.pid)
        ownershipCheck(
          !ref || (ref.parent === initial.parent && ref.role === initial.role),
          'inventory required reference changed'
        )
        needed.set(initial.pid, { pid: initial.pid, parent: initial.parent, role: initial.role })
      }
    }
    const pre = new Map()
    for (const initial of owned.values()) {
      const current = observe(initial.pid, 'before')
      if (current) {
        sameOwnedInstance(initial, current)
        pre.set(initial.pid, current)
      } else ownershipCheck(!needed.has(initial.pid), 'inventory missing required pre-fence')
    }
    const rows = identityQuery(
      ['-U', String(realUid), '-x', '-ww', '-o', identityFields],
      realUid,
      query,
      (r) => {
        queryReceipt = r
      }
    )
    // Linear indexed validation: output order, PGID, session and names play no role.
    const checked = new Set(),
      terminalParents = new Map()
    for (const row of rows.values()) {
      const chain = new Set()
      let pid = row.pid
      while (rows.has(pid) && !checked.has(pid)) {
        ownershipCheck(!chain.has(pid), 'inventory ancestry cycle')
        chain.add(pid)
        pid = rows.get(pid).parent
      }
      const terminal = terminalParents.get(pid) ?? pid
      for (const member of chain) {
        checked.add(member)
        terminalParents.set(member, terminal)
      }
    }
    const children = new Map()
    for (const r of rows.values()) {
      if (!children.has(r.parent)) children.set(r.parent, [])
      children.get(r.parent).push(r.pid)
    }
    ownershipCheck(rows.has(rootPid), 'inventory missing main row')
    sameOwnedInstance(root, rows.get(rootPid))
    const reachable = new Set(),
      queue = [rootPid]
    for (let i = 0; i < queue.length; i++) {
      const pid = queue[i]
      ownershipCheck(!reachable.has(pid), 'inventory duplicate owned edge')
      reachable.add(pid)
      queue.push(...(children.get(pid) || []))
    }
    for (const ref of needed.values()) {
      ownershipCheck(
        rows.has(ref.pid) && reachable.has(ref.pid),
        'inventory missing required role/edge'
      )
      ownershipCheck(rows.get(ref.pid).parent === ref.parent, 'inventory required parent')
    }
    for (const initial of owned.values()) {
      if (rows.has(initial.pid)) {
        ownershipCheck(pre.has(initial.pid), 'inventory missing known pre-fence')
        sameOwnedInstance(initial, rows.get(initial.pid))
        ownershipCheck(reachable.has(initial.pid), 'inventory unresolved known chain')
      } else
        ownershipCheck(
          !pre.has(initial.pid) && !needed.has(initial.pid),
          'inventory missing known row'
        )
    }
    // Unmatched rows are not owned, but a chain ending at an absent known
    // PID is unresolved evidence, not grounds to silently filter that chain.
    // The terminal index reuses the linear, cycle-checked whole-table walk.
    for (const pid of rows.keys()) {
      if (reachable.has(pid)) continue
      unresolvedKnownAnchor = owned.get(terminalParents.get(pid)) || null
      if (unresolvedKnownAnchor !== null) {
        const edges = []
        let cursor = pid
        while (rows.has(cursor)) {
          const row = rows.get(cursor)
          edges.push({ pid: row.pid, parent: row.parent })
          cursor = row.parent
        }
        unresolvedChain = {
          evidenceKind: 'unproven-ancestry-edges',
          edges,
          absentKnownPid: unresolvedKnownAnchor.pid
        }
      }
      ownershipCheck(unresolvedKnownAnchor === null, 'inventory unresolved absent known chain')
    }
    const staged = new Map(owned),
      observations = []
    const parents = new Set([rootPid])
    for (const pid of reachable) {
      const current = rows.get(pid)
      if (pid !== rootPid) parents.add(current.parent)
      if (owned.has(pid)) observations.push({ initialPid: pid, current })
      else
        staged.set(
          pid,
          firstOwnedIdentity(
            current,
            needed.get(pid)?.role || 'descendant',
            context,
            'real-uid-first-row'
          )
        )
    }
    // Known pre-fenced instances and every parent anchoring a new edge must
    // still match AFTER acquisition. No unknown child's identity is late-filled.
    for (const pid of new Set([...pre.keys(), ...parents])) {
      const current = observe(pid, 'after')
      ownershipCheck(current !== null, 'inventory missing post-fence')
      sameOwnedInstance(rows.get(pid), current)
    }
    const receipt = {
      schema: 2,
      context,
      query: queryReceipt,
      selectedRows: rows.size,
      required: [...needed.values()],
      fences,
      owned: [...staged.values()],
      observations
    }
    // Commit only after every guard; initial objects/roles remain the originals.
    for (const [pid, initial] of staged) if (!owned.has(pid)) owned.set(pid, initial)
    return receipt
  } catch (error) {
    recordFailure({
      context,
      query: queryReceipt,
      fences: fences.map((fence) => ({
        ...fence,
        initialIdentity: owned.get(fence.pid) || null,
        identity: unprovenIdentityEvidence(fence.identity)
      })),
      unresolvedKnownAnchor,
      unresolvedChain,
      category: error.message,
      later: 'NOTRUN'
    })
    throw error
  }
}

export function captureResourceWorker(pid, parent, context, writeReceipt, query = spawnSync) {
  const row = { pid: pid ?? null, expectedParent: parent, context, identity: null, failure: null }
  try {
    row.identity = identifyOwnedProcess(
      new Map(),
      pid,
      'collector-worker',
      parent,
      context,
      (failure) => {
        row.failure = failure
      },
      query
    )
  } catch (error) {
    if (!row.failure) row.failure = { message: error.message, later: 'NOTRUN' }
  }
  try {
    writeReceipt(row)
  } catch (error) {
    // Return the captured identity to its parent even when the new receipt is unavailable.
    row.evidenceFailure = {
      site: 'worker-spawn.json',
      code: error.code ?? null,
      message: error.message
    }
  }
  return row
}

export function resourceWorkerExit(row, code, signal, expired, workerError = null) {
  return {
    pid: row.pid,
    identity: row.identity,
    failure: row.failure,
    evidenceFailure: row.evidenceFailure ?? null,
    error: workerError ? { code: workerError.code ?? null, message: workerError.message } : null,
    code,
    signal,
    expired,
    accepted:
      row.identity?.schema === 2 &&
      row.failure === null &&
      !row.evidenceFailure &&
      workerError === null &&
      code === 0 &&
      signal === null &&
      !expired
  }
}

export function resourceWorkerForCleanup(row, current) {
  const initial = row?.identity
  return initial?.schema === 2 &&
    current?.schema === 2 &&
    initial.realUid === current.realUid &&
    initial.pid === current.pid &&
    initial.creation === current.creation &&
    current.parent === row.expectedParent
    ? initial
    : null
}

async function forceOwnedCleanup(identities) {
  const receipt = []
  for (const identity of [...identities].reverse()) {
    const current = processIdentity(identity.pid)
    if (
      !current ||
      current.creation !== identity.creation ||
      current.parent !== identity.parent ||
      current.realUid !== identity.realUid ||
      identity.schema !== 2
    )
      continue
    process.kill(identity.pid, 'SIGTERM')
    receipt.push({ ...identity, signal: 'SIGTERM' })
  }
  await sleep(250)
  for (const identity of receipt) {
    const current = processIdentity(identity.pid)
    if (
      current?.creation === identity.creation &&
      current.parent === identity.parent &&
      current.realUid === identity.realUid &&
      identity.schema === 2
    ) {
      process.kill(identity.pid, 'SIGKILL')
      identity.signal = 'SIGKILL'
    }
  }
  return receipt
}

async function launch(frozen, side, index, evidence) {
  const item = verifyFrozenSide(frozen, side)
  const ownershipFixture = verifyOwnershipFixture(frozen, side)
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
    ownershipSchema: 2,
    ownershipFixture,
    startedAt: Date.now(),
    observations: controller.samples,
    errors: [],
    originalLongIds: [],
    closures: 0
  }
  const owned = new Map()
  const own = (pid, role, expectedParent = null, context = { site: 'unspecified' }) =>
    identifyOwnedProcess(owned, pid, role, expectedParent, context, (failure) => {
      result.ownershipFailures ||= []
      result.ownershipFailures.push(failure)
      persist({ ownershipFailure: failure, later: 'NOTRUN' })
    })
  const inventory = async (phase) => {
    const discovery = readJson(path.join(dir, 'clave-server.json'))
    const terminal = readJson(path.join(separateServerDataDir(dir), 'clave-server.json'))
    const metrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type }))
    )
    const references = [
      { pid: discovery.serverPid, parent: app.process().pid, role: 'server' },
      { pid: terminal.terminalProcessPid, parent: discovery.serverPid, role: 'terminal-process' },
      ...metrics
        .filter(
          (m) =>
            m.pid !== app.process().pid &&
            m.pid !== discovery.serverPid &&
            m.pid !== terminal.terminalProcessPid
        )
        .map((m) => ({
          pid: m.pid,
          parent: app.process().pid,
          role: m.type === 'Tab' ? 'renderer' : 'utility'
        }))
    ]
    persist(
      captureOwnedInventory({
        owned,
        rootPid: app.process().pid,
        required: references,
        realUid: process.getuid(),
        effectiveUid: process.geteuid(),
        fixtureBound: ownershipFixture.fixture === 'chat/renderer-resource',
        context: { site: phase + '.real-uid-inventory' },
        recordFailure: (failure) => {
          result.ownershipFailures ||= []
          result.ownershipFailures.push(failure)
          persist({ ownershipDiscoveryFailure: failure, later: 'NOTRUN' })
        }
      })
    )
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
    own(app.process().pid, 'main', process.pid, { site: 'boot.main' })
    win.on('pageerror', (error) =>
      result.errors.push({ kind: 'pageerror', message: error.message })
    )
    win.on('console', (message) => {
      if (message.type() === 'error')
        result.errors.push({ kind: 'console', message: message.text() })
    })
    result.target = await target()
    own(result.target.pid, 'renderer', app.process().pid, { site: 'boot.target-renderer' })
    assert.equal(result.target.hidden, true)
    assert.equal(result.target.backgroundThrottling, false)
    await inventory('boot.inventory')
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
      await inventory('sample.' + label)
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
        await inventory('cleanup.inventory')
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
        for (const pid of liveAppPids())
          own(pid, 'main', process.pid, { site: 'cleanup.boot-incomplete' })
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
  for (const side of ['control', 'candidate']) {
    verifyFrozenSide(frozen, side)
    verifyOwnershipFixture(frozen, side)
  }
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
              const currentWorker = processIdentity(child.pid)
              const cleanupWorker = resourceWorkerForCleanup(worker, currentWorker)
              if (cleanupWorker) identities.set(cleanupWorker.pid, cleanupWorker)
              write(path.join(evidence, 'deadline-forced-cleanup.json'), {
                forced: true,
                timedOut: true,
                worker: {
                  initial: worker?.identity ?? null,
                  evidenceFailure: worker?.evidenceFailure ?? null,
                  error: workerError?.message ?? null,
                  current: cleanupWorker ? currentWorker : unprovenIdentityEvidence(currentWorker),
                  signalEligible: cleanupWorker !== null
                },
                actions: await forceOwnedCleanup(identities.values()),
                later: 'NOTRUN'
              })
            } catch (error) {
              log.push(Buffer.from('deadline cleanup failed: ' + error.message + '\n'))
            }
            reject(
              new Error(
                'launch ceiling; late results fenced, all later NOTRUN' +
                  (worker?.evidenceFailure
                    ? '; worker spawn receipt failed: ' + worker.evidenceFailure.message
                    : '')
              )
            )
          }, 600000)
          child.stdout.on('data', (b) => log.push(b))
          child.stderr.on('data', (b) => log.push(b))
          let worker,
            workerError = null
          child.on('error', (error) => {
            workerError ||= error
            try {
              write(path.join(evidence, 'worker-error.json'), {
                pid: child.pid ?? null,
                identity: worker?.identity ?? null,
                code: error.code ?? null,
                message: error.message,
                later: 'NOTRUN'
              })
            } catch (receiptError) {
              log.push(Buffer.from('worker error receipt failed: ' + receiptError.message + '\n'))
            }
            // A failed spawn has no PID. An existing child keeps the original exit/fence custody.
            if (!Number.isInteger(child.pid) || child.pid <= 0) {
              clearTimeout(timer)
              reject(workerError)
            }
          })
          child.on('exit', (code, signal) => {
            clearTimeout(timer)
            const exit = resourceWorkerExit(worker, code, signal, expired, workerError)
            const failure = exit.accepted
              ? null
              : new Error(
                  `launch failed code=${code} signal=${signal}; workerIdentity=${worker.identity !== null}` +
                    (worker.failure ? '; ownership: ' + worker.failure.message : '') +
                    (worker.evidenceFailure
                      ? '; worker spawn receipt failed: ' + worker.evidenceFailure.message
                      : '') +
                    (workerError ? '; worker error: ' + workerError.message : '')
                )
            try {
              write(path.join(evidence, 'worker-exit.json'), exit)
            } catch (receiptError) {
              log.push(Buffer.from('worker exit receipt failed: ' + receiptError.message + '\n'))
              reject(failure || receiptError)
              return
            }
            failure ? reject(failure) : resolve()
          })
          // Same direct spawn; capture synchronously before yielding back to the event loop.
          // A capture failure never advances another launch or accepts this child's samples.
          // Keep the existing current-child cleanup/600000ms fence; never kill an unproven PID.
          worker = captureResourceWorker(
            child.pid,
            process.pid,
            { site: 'parent.spawn', side, index },
            (receipt) => write(path.join(evidence, 'worker-spawn.json'), receipt)
          )
          if (worker.evidenceFailure)
            log.push(
              Buffer.from('worker spawn receipt failed: ' + worker.evidenceFailure.message + '\n')
            )
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
