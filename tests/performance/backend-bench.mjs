#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS that drives the built app from node */
// The backend benchmarks (lane B of clave-perf-20261015, issue #188): how
// long the Electron main process and the server take to start, how busy they
// are at rest, how long the window's representative queries take, and where
// their CPU goes, as V8 profiles and flamegraphs.
//
//   node tests/performance/backend-bench.mjs --variant installed-separate --scale S135
//
// One invocation is one CONFIGURATION (a variant on a scale), launched
// `--launches` times on fresh data, plus `--profiled-launches` more with the
// profilers on. Profiled launches are kept apart from the plain figures. Their
// profilers start AFTER the boot (idle and query windows), so their startup
// marks are not a measure of profiling overhead and are not reported as one.
//
// Variants:
//   installed-separate  /Applications/Clave.app as installed, its separate
//                       server (the packaged default on macOS)
//   dev-separate        this checkout's `out/` under its node_modules
//                       Electron, `--server=separate`
//   dev-in-process      the same, the server inside Electron main
// Scales (synthetic, nothing read from a real profile):
//   S0    one workspace, no session
//   S24   24 chat tabs in 4 groups
//   S135  135 chat tabs in 14 groups, 15 workspaces (the scale reported live)
// A share of the Claude chats (`--history-chats`) carry a synthetic
// transcript of `--history-turns` turns for the history query; the rest are
// dormant tabs. The agents are stubs that log their start and sleep: no
// provider is ever reached.
//
// Everything runs under `--test-no-activate`: the window is never shown and
// never takes the machine's focus, with background throttling off. These are
// therefore NOT foreground figures (no compositor, no visible frame), and the
// report says so.
//
// The run fails (exit 1) rather than print a figure it cannot stand behind:
// a launch that does not boot, a query that throws or answers nothing, a
// sample set short of the plan, a histogram that recorded nothing, a profile
// that is missing or too thin, or a process still alive after the close.

import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { REPO, separateServerDataDir, serverEndpoint, serverFixture } from '../e2e/harness.mjs'
import { boundedClose } from '../e2e/bounds.mjs'
import {
  SampleError,
  cpuPercent,
  eventLoopDelayMs,
  nodeTimingMark,
  parsePsRows,
  requireStartupOrder,
  requireSamples,
  summarize
} from '../../scripts/performance/backend-stats.mjs'
import {
  appFrames,
  attribute,
  breakdown,
  flamegraphHtml,
  foldProfile,
  foldedText,
  privatePathsIn,
  scrubProfile,
  scrubText,
  validateCpuProfile
} from '../../scripts/performance/backend-profile.mjs'
import { requireAllGone, waitGone } from '../../scripts/performance/backend-process.mjs'

// ── Configuration ────────────────────────────────────────────────────────────

/** Why the installed app gives no launch-to-quit profile: the signed app
 *  drops NODE_OPTIONS (Electron logs "Node.js environment variables are
 *  disabled because this process is invoked by other apps"), so `--cpu-prof`
 *  never reaches its processes, and Electron main takes no `--cpu-prof` on
 *  its command line. Measured on 3.0.0-beta.2, 2026-10-15. Its windowed
 *  profiles (the inspector inside each process) are unaffected. */
const SIGNED_APP_NO_NODE_OPTIONS =
  'signed app ignores NODE_OPTIONS ("Node.js environment variables are disabled because this process is invoked by other apps")'

export const VARIANTS = {
  'installed-separate': {
    bin: '/Applications/Clave.app/Contents/MacOS/Clave',
    appArgs: [],
    server: 'separate',
    installed: true,
    runProfiles: SIGNED_APP_NO_NODE_OPTIONS
  },
  'dev-separate': {
    bin: path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    appArgs: ['.'],
    server: 'separate',
    installed: false
  },
  'dev-in-process': {
    bin: path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    appArgs: ['.'],
    server: 'in-process',
    installed: false
  }
}

export const SCALES = {
  S0: { sessions: 0, groups: 0, workspaces: 1 },
  S24: { sessions: 24, groups: 4, workspaces: 1 },
  S135: { sessions: 135, groups: 14, workspaces: 15 }
}

/** The share of chats that are Codex, as in restore-timing.spec.mjs. */
const CODEX_SHARE = 0.6
/** Where every run keeps its data; the namespace the harness would use. */
const NAMESPACE = 'clave-perf-1015-b'
const BASE_DIR = path.join('/tmp', NAMESPACE)
/** How often `ps` reads the processes during a window. */
const PS_INTERVAL_MS = 1000
/** The event-loop histogram's resolution. */
const ELD_RESOLUTION_MS = 10
/** V8's sampling interval for every profile taken here, µs. */
const PROFILE_INTERVAL_US = 1000
const BOOT_TIMEOUT_MS = 90_000
const CLOSE_TIMEOUT_MS = 25_000
/** How long the processes get to be gone after the close. */
const EXIT_WAIT_MS = 15_000

function options(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      variant: { type: 'string' },
      scale: { type: 'string', default: 'S0' },
      launches: { type: 'string', default: '3' },
      'profiled-launches': { type: 'string', default: '1' },
      'idle-seconds': { type: 'string', default: '30' },
      'profile-idle-seconds': { type: 'string', default: '15' },
      'post-boot-seconds': { type: 'string', default: '5' },
      'startup-settle-seconds': { type: 'string', default: '10' },
      'query-iterations': { type: 'string', default: '200' },
      'query-warmup': { type: 'string', default: '10' },
      'history-chats': { type: 'string', default: '20' },
      'history-turns': { type: 'string', default: '200' },
      // A process whose startup-to-quit profile may be missing without failing
      // the run, named so the report lists it as a limitation.
      'allow-missing-run-profile': { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: path.join(BASE_DIR, 'results') },
      label: { type: 'string', default: '' }
    },
    strict: true
  })
  const int = (k, min) => {
    const n = Number(values[k])
    if (!Number.isInteger(n) || n < min) throw new Error(`--${k} must be an integer ≥ ${min}`)
    return n
  }
  if (!VARIANTS[values.variant])
    throw new Error(`--variant must be one of ${Object.keys(VARIANTS).join(', ')}`)
  if (!SCALES[values.scale])
    throw new Error(`--scale must be one of ${Object.keys(SCALES).join(', ')}`)
  return {
    variant: values.variant,
    scale: values.scale,
    launches: int('launches', 1),
    profiledLaunches: int('profiled-launches', 0),
    idleSeconds: int('idle-seconds', 5),
    profileIdleSeconds: int('profile-idle-seconds', 2),
    postBootSeconds: int('post-boot-seconds', 0),
    startupSettleSeconds: int('startup-settle-seconds', 1),
    queryIterations: int('query-iterations', 5),
    queryWarmup: int('query-warmup', 0),
    historyChats: int('history-chats', 0),
    historyTurns: int('history-turns', 1),
    allowMissingRunProfile: values['allow-missing-run-profile'],
    out: path.resolve(values.out),
    label: values.label
  }
}

// ── Identity ─────────────────────────────────────────────────────────────────

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf-8', timeout: 10_000, ...opts }).trim()

function machineIdentity() {
  const cpus = os.cpus()
  const swVers = (() => {
    try {
      return run('sw_vers', ['-productVersion'])
    } catch {
      return null
    }
  })()
  return {
    platform: process.platform,
    arch: os.arch(),
    macos: swVers,
    darwin: os.release(),
    cpuModel: cpus[0]?.model ?? null,
    logicalCores: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    driverNode: process.versions.node
  }
}

function buildIdentity(variant) {
  const v = VARIANTS[variant]
  if (v.installed) {
    const plist = '/Applications/Clave.app/Contents/Info.plist'
    const fw =
      '/Applications/Clave.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'
    return {
      kind: 'installed',
      app: '/Applications/Clave.app',
      version: run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist]),
      electronFramework: run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleVersion', fw])
    }
  }
  const sha = run('git', ['-C', REPO, 'rev-parse', 'HEAD'])
  const dirty = run('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no']) !== ''
  const outMain = path.join(REPO, 'out', 'main', 'index.js')
  if (!existsSync(outMain)) throw new Error(`no build at ${outMain}: run npm run build first`)
  return {
    kind: 'dev',
    sha,
    trackedChanges: dirty,
    tree: run('git', ['-C', REPO, 'rev-parse', 'HEAD^{tree}']),
    builtAt: new Date(statSync(outMain).mtimeMs).toISOString(),
    electron: JSON.parse(
      readFileSync(path.join(REPO, 'node_modules', 'electron', 'package.json'), 'utf-8')
    ).version
  }
}

/** What else the machine is doing: the load average and the CPU every
 *  other process used, summed from `ps` (a percent of one core). The live
 *  app keeps running beside the benchmark; this is recorded, not removed. */
function coRunningLoad(ours = []) {
  const rows = run('ps', ['-A', '-o', 'pid=,%cpu=']).split('\n')
  let otherCpu = 0
  for (const row of rows) {
    const [pid, cpu] = row.trim().split(/\s+/).map(Number)
    if (Number.isFinite(cpu) && !ours.includes(pid)) otherCpu += cpu
  }
  return { loadavg1m: os.loadavg()[0], otherProcessesCpuPct: Math.round(otherCpu * 10) / 10 }
}

// ── Synthetic workload ───────────────────────────────────────────────────────

/** A login shell that answers at once and the two stub agents, as in
 *  restore-timing.spec.mjs: an agent logs its pid and session, then sleeps. */
function writeStubs(root) {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    path.join(bin, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  const starts = path.join(root, 'agent-starts.jsonl')
  for (const name of ['claude', 'codex'])
    writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho '{"agent":"${name}","pid":'$$',"session":"'"$CLAVE_SESSION_ID"'"}' >> ${JSON.stringify(starts)}\nexec sleep 600\n`,
      { mode: 0o755 }
    )
  return { bin, starts }
}

/** A Claude transcript of `turns` turns: a question, a step with a tool call
 *  and its result, and an answer, a minute apart, all of it invented. */
function transcript(turns, endAt) {
  const lines = []
  for (let n = 0; n < turns; n++) {
    const timestamp = new Date(endAt - (turns - n) * 60_000).toISOString()
    const id = `toolu_${n}`
    lines.push(
      { type: 'user', timestamp, message: { role: 'user', content: `Synthetic question ${n}.` } },
      {
        type: 'assistant',
        timestamp,
        message: {
          content: [
            { type: 'text', text: `Looking at item ${n} in the synthetic fixture.` },
            { type: 'tool_use', id, name: 'Read', input: { file_path: `/fixture/file-${n}.ts` } }
          ]
        }
      },
      {
        type: 'user',
        timestamp,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: id, content: `fixture line ${n}\n`.repeat(8) }
          ]
        }
      },
      {
        type: 'assistant',
        timestamp,
        message: { content: [{ type: 'text', text: `Synthetic answer ${n}: `.padEnd(400, 'x') }] }
      }
    )
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** Seed a fresh launch folder for `scale`. Answers what the run needs to
 *  drive and check it: the data folder, the environment, the groups and the
 *  sessions that carry a transcript. */
export function seedLaunch(launchDir, scaleName, cfg) {
  const scale = SCALES[scaleName]
  rmSync(launchDir, { recursive: true, force: true })
  const dir = path.join(launchDir, 'userdata')
  const root = path.join(launchDir, 'root')
  const transcripts = path.join(root, 'transcripts')
  const codexRoot = path.join(root, 'codex-sessions')
  mkdirSync(dir, { recursive: true })
  mkdirSync(transcripts, { recursive: true })
  mkdirSync(codexRoot, { recursive: true })
  const { bin, starts } = writeStubs(root)

  const workspaces = Array.from({ length: scale.workspaces }, (_, i) => {
    const rootDir = path.join(root, `workspace-${i + 1}`)
    mkdirSync(rootDir, { recursive: true })
    return {
      id: `bench-ws-${i + 1}`,
      name: `Workspace ${i + 1}`,
      rootDir,
      profileFile: null,
      createdAt: i + 1
    }
  })
  const active = workspaces[0]
  const windowKey = 'bench-window'
  const docs = {
    'workspace-state.json': {
      version: 1,
      workspaces,
      activeWorkspaceId: active.id,
      pins: [],
      pinsMigrated: true
    },
    'clave-trusted-roots.json': [root],
    // Off in an instance nobody uses: the telemetry ping of a packaged app.
    'preferences.json': {
      telemetryEnabled: false,
      telemetryNoticeShown: true,
      agentAutoUpdate: false
    },
    'agent-launch-profiles.json': {
      version: 1,
      customProfiles: [
        {
          id: 'stub-claude',
          name: 'Stub Claude',
          family: 'claude',
          command: [path.join(bin, 'claude')],
          additionalArgs: []
        },
        {
          id: 'stub-codex',
          name: 'Stub Codex',
          family: 'codex',
          command: [path.join(bin, 'codex')],
          additionalArgs: []
        }
      ],
      globalDefaults: {},
      workspaceOverrides: {}
    },
    'windows.json': { version: 1, windows: [{ key: windowKey, workspaceId: active.id }] }
  }

  const ids = Array.from({ length: scale.sessions }, () => randomUUID())
  const groups = Array.from({ length: scale.groups }, (_, g) => ({
    id: `bench-group-${g + 1}`,
    name: `Group ${g + 1}`,
    ids: ids.filter((_, i) => i % scale.groups === g)
  }))
  const endAt = Date.now() - 86_400_000
  const history = []
  const records = ids.map((id, i) => {
    const codex = i < Math.round(ids.length * CODEX_SHARE)
    const claudeSessionId = codex ? null : randomUUID()
    if (!codex && history.length < cfg.historyChats) {
      const file = path.join(
        transcripts,
        active.rootDir.replace(/[^a-zA-Z0-9]/g, '-'),
        `${claudeSessionId}.jsonl`
      )
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, transcript(cfg.historyTurns, endAt))
      history.push(id)
    }
    return {
      id,
      adapterId: codex ? 'codex-chat' : 'claude-chat',
      transport: 'events',
      ...(codex ? { codexThreadId: randomUUID() } : { claudeSessionId }),
      cwd: active.rootDir,
      folderName: path.basename(active.rootDir),
      displayName: `${codex ? 'Codex' : 'Claude'} ${i + 1}`,
      claudeMode: !codex,
      antigravityMode: false,
      codexMode: codex,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      launchProfileId: codex ? 'chat:codex:stub-codex' : 'chat:claude:stub-claude',
      workspaceId: active.id,
      windowKey
    }
  })
  if (history.length < Math.min(cfg.historyChats, records.filter((r) => r.claudeMode).length))
    throw new Error('seed: fewer transcripts written than asked')

  const layout = {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      sessionIds: g.ids,
      collapsed: false,
      cwd: active.rootDir,
      terminals: [],
      workspaceId: active.id
    })),
    displayOrder: groups.map((g) => g.id)
  }

  // The documents go to the app's folder and, for a separate server, to the
  // server's own (it reads nothing of the app's, ADR 0003); the records go
  // where the server that runs keeps them, as on an install that ran before.
  const serverDir = cfg.server === 'separate' ? separateServerDataDir(dir) : dir
  for (const target of new Set([dir, serverDir])) {
    mkdirSync(target, { recursive: true })
    for (const [name, value] of Object.entries(docs))
      writeFileSync(path.join(target, name), JSON.stringify(value, null, 2))
  }
  mkdirSync(path.join(dir, 'sidebar-layouts', 'windows'), { recursive: true })
  writeFileSync(
    path.join(dir, 'sidebar-layouts', 'windows', `${windowKey}.json`),
    JSON.stringify(layout)
  )
  if (cfg.server === 'separate') {
    mkdirSync(path.join(serverDir, 'sidebar-layouts', 'windows'), { recursive: true })
    writeFileSync(
      path.join(serverDir, 'sidebar-layouts', 'windows', `${windowKey}.json`),
      JSON.stringify(layout)
    )
  }
  const recordsDir = path.join(serverDir, 'session-records')
  mkdirSync(recordsDir, { recursive: true })
  for (const r of records) writeFileSync(path.join(recordsDir, `${r.id}.json`), JSON.stringify(r))

  const env = {
    SHELL: path.join(bin, 'bash'),
    PATH: `${bin}:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: transcripts,
    CLAVE_CODEX_ROOT: codexRoot,
    CLAVE_E2E_NS: NAMESPACE
  }
  return { dir, root, env, starts, workspaces, groups, ids, history }
}

// ── Code run inside the app's processes ─────────────────────────────────────
// Each is sent as source: to Electron main through Playwright, to the server
// through the test-only fixture route. No closure survives the trip, so each
// takes everything it needs in `arg` and reaches Node through
// `process.getBuiltinModule`.

function processTiming() {
  const ph = process.getBuiltinModule('node:perf_hooks')
  const nt = ph.performance.nodeTiming
  return {
    pid: process.pid,
    timeOrigin: ph.performance.timeOrigin,
    nodeStart: nt.nodeStart,
    v8Start: nt.v8Start,
    environment: nt.environment,
    bootstrapComplete: nt.bootstrapComplete,
    loopStart: nt.loopStart,
    uptimeMs: process.uptime() * 1000,
    versions: {
      node: process.versions.node,
      v8: process.versions.v8,
      electron: process.versions.electron ?? null
    }
  }
}

function startProbe(arg) {
  const ph = process.getBuiltinModule('node:perf_hooks')
  const g = (globalThis.__claveBenchB ??= {})
  if (g[arg.key]) throw new Error(`probe ${arg.key} already running`)
  const h = ph.monitorEventLoopDelay({ resolution: arg.resolutionMs })
  h.enable()
  g[arg.key] = {
    h,
    elu: ph.performance.eventLoopUtilization(),
    cpu: process.cpuUsage(),
    t: ph.performance.now()
  }
  return true
}

function stopProbe(arg) {
  const ph = process.getBuiltinModule('node:perf_hooks')
  const g = globalThis.__claveBenchB?.[arg.key]
  if (!g) throw new Error(`no probe ${arg.key} running`)
  delete globalThis.__claveBenchB[arg.key]
  g.h.disable()
  const elu = ph.performance.eventLoopUtilization(g.elu)
  const cpu = process.cpuUsage(g.cpu)
  const m = process.memoryUsage()
  return {
    histogram: {
      count: g.h.count,
      min: g.h.min,
      max: g.h.max,
      mean: g.h.mean,
      p50: g.h.percentile(50),
      p95: g.h.percentile(95),
      p99: g.h.percentile(99)
    },
    elu: { utilization: elu.utilization, activeMs: elu.active, idleMs: elu.idle },
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    wallMs: ph.performance.now() - g.t,
    memory: {
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers
    }
  }
}

async function startProfiler(arg) {
  const inspector = process.getBuiltinModule('node:inspector')
  const g = (globalThis.__claveBenchB ??= {})
  const key = `profiler:${arg.key}`
  if (g[key]) throw new Error(`profiler ${arg.key} already running`)
  const session = new inspector.Session()
  session.connect()
  const post = (method, params) =>
    new Promise((resolve, reject) =>
      session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res)))
    )
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: arg.intervalUs })
  await post('Profiler.start')
  g[key] = { session, post }
  return true
}

async function stopProfiler(arg) {
  const g = globalThis.__claveBenchB?.[`profiler:${arg.key}`]
  if (!g) throw new Error(`no profiler ${arg.key} running`)
  delete globalThis.__claveBenchB[`profiler:${arg.key}`]
  const { profile } = await g.post('Profiler.stop')
  await g.post('Profiler.disable')
  g.session.disconnect()
  // Written here, in the process, so a large profile does not cross the wire.
  process.getBuiltinModule('node:fs').writeFileSync(arg.file, JSON.stringify(profile))
  return { file: arg.file, samples: profile?.samples?.length ?? 0 }
}

/** `fn` as a function Playwright runs in Electron main, where the first
 *  parameter is the electron module and the second the argument. */
const inMain = (fn) => new Function('electron', 'arg', `return (${fn.toString()})(arg)`)

/** Run `fn(arg)` in a role's process: `main` through Playwright, `server`
 *  through the fixture route (the same process as main in-process). */
function runner(app, server) {
  return {
    main: (fn, arg) => app.evaluate(inMain(fn), arg),
    server: (fn, arg) => server.evaluate(fn, arg)
  }
}

// ── Code run in the window ───────────────────────────────────────────────────

/** Installed at the page's DOMContentLoaded: polls every 10 ms and records,
 *  against the page's own clock, when the boot completes and when every
 *  seeded tab is in its group. A restore prompt is answered and recorded. */
function installBootWatch(expected) {
  const w = window
  w.__benchB = {
    bootAt: null,
    bootState: null,
    rowsAt: expected.length === 0 ? 0 : null,
    promptSeen: false
  }
  const tick = () => {
    const s = w.__benchB
    const boot = document.documentElement.dataset.boot ?? null
    if (s.bootAt === null && (boot === 'complete' || boot === 'restore-prompt')) {
      s.bootAt = performance.now()
      s.bootState = boot
    }
    const restore = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Restore'
    )
    if (restore) {
      s.promptSeen = true
      restore.click()
    }
    if (s.rowsAt === null) {
      const all = expected.every(({ group, ids }) => {
        const foot = document.querySelector(
          `[data-sidebar-drop-zone="group-end"][data-group-id="${group}"]:not(.sidebar-empty-row)`
        )
        const rail = foot?.parentElement
        if (!rail) return false
        const rows = new Set(
          [...rail.querySelectorAll('[data-sidebar-item-type="session"]')].map((r) =>
            r.getAttribute('data-sidebar-item-id')
          )
        )
        return ids.every((id) => rows.has(id))
      })
      if (all) s.rowsAt = performance.now()
    }
    if (s.bootAt !== null && s.rowsAt !== null) clearInterval(w.__benchBTimer)
  }
  tick()
  w.__benchBTimer = setInterval(tick, 10)
}

/** Time one electronAPI method inside the page, so the driver's own latency
 *  is not in the figure: the first call alone (cold), `warmup` untimed, then
 *  `n` timed one after the other. Each answer is checked by `check`
 *  (`nonEmpty`: an array or object with something in it; `items`: a page
 *  whose `items` are not empty; `any`: not undefined) and the first failure
 *  throws with the method's name. */
async function timeMethod({ method, args, warmup, n, check }) {
  const api = window.electronAPI
  if (typeof api?.[method] !== 'function')
    throw new Error(`electronAPI.${method} is not a function`)
  const ok = (v) => {
    if (check === 'any') return v !== undefined
    // A history page: its events, not merely a cursor.
    if (check === 'items') return Array.isArray(v?.items) && v.items.length > 0
    if (Array.isArray(v)) return v.length > 0
    if (v && typeof v === 'object')
      return Object.values(v).some((x) => (Array.isArray(x) ? x.length > 0 : x != null))
    return false
  }
  const call = async () => {
    const v = await api[method](...args)
    if (!ok(v))
      throw new Error(
        `electronAPI.${method} answered nothing usable: ${JSON.stringify(v)?.slice(0, 200)}`
      )
    return v
  }
  let t = performance.now()
  const first = await call()
  const coldMs = performance.now() - t
  for (let i = 0; i < warmup; i++) await call()
  const samples = []
  for (let i = 0; i < n; i++) {
    t = performance.now()
    await call()
    samples.push(performance.now() - t)
  }
  return { coldMs, samples, answerBytes: JSON.stringify(first)?.length ?? 0 }
}

/** The queries a window makes, each with its arguments and what a sound
 *  answer looks like. Read-only, local: nothing here reaches the network. */
function queryPlan(seed) {
  const plan = [
    { method: 'windowIdentity', args: [], check: 'nonEmpty', road: 'ipc (floor)' },
    { method: 'workspaceLoad', args: [], check: 'nonEmpty', road: 'server' },
    { method: 'launchProfilesList', args: [], check: 'nonEmpty', road: 'server' },
    { method: 'pluginsList', args: [], check: 'any', road: 'server' },
    { method: 'listTrustedRoots', args: [], check: 'nonEmpty', road: 'server' },
    { method: 'claudeAccountsList', args: [], check: 'any', road: 'server' },
    { method: 'sidebarLayoutLoad', args: [], check: 'any', road: 'server (sidebar)' },
    {
      method: 'discoverClaveFilesRecursive',
      args: [seed.root, { maxDepth: 6 }],
      check: 'any',
      road: 'server'
    },
    {
      method: 'sessionsList',
      args: [],
      check: seed.ids.length > 0 ? 'nonEmpty' : 'any',
      road: 'server'
    }
  ]
  if (seed.history.length > 0)
    plan.push({
      method: 'sessionsHistory',
      args: [seed.history[0]],
      check: 'items',
      road: 'server',
      note: 'newest page of a synthetic transcript'
    })
  return plan
}

// ── Processes ────────────────────────────────────────────────────────────────

function readPs(pids) {
  const out = execFileSync('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], {
    encoding: 'utf-8',
    timeout: 5000
  }).trim()
  return parsePsRows(out)
}

/** Read `pids` (role → pid) with `ps` every PS_INTERVAL_MS until `stop()`;
 *  answers the per-interval CPU% and the RSS per role. A role whose process
 *  disappears mid-window fails the window. */
function psSampler(roles) {
  const pids = Object.values(roles)
  const series = Object.fromEntries(Object.keys(roles).map((r) => [r, { cpuPct: [], rssMiB: [] }]))
  let last = { t: performance.now(), rows: readPs(pids) }
  let error = null
  const timer = setInterval(() => {
    try {
      const now = { t: performance.now(), rows: readPs(pids) }
      for (const [role, pid] of Object.entries(roles)) {
        const a = last.rows.get(pid)
        const b = now.rows.get(pid)
        if (!a || !b) throw new SampleError(`ps: the ${role} process (${pid}) is gone`)
        series[role].cpuPct.push(cpuPercent(a.cpuMs, b.cpuMs, now.t - last.t))
        series[role].rssMiB.push(b.rssKiB / 1024)
      }
      last = now
    } catch (err) {
      error ??= err
    }
  }, PS_INTERVAL_MS)
  return () => {
    clearInterval(timer)
    if (error) throw error
    return series
  }
}

/** Electron's own reading of every process of the app (main, renderer, GPU,
 *  utilities): pid, type, CPU since the previous reading, working set. */
function appMetrics(app) {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      serviceName: m.serviceName ?? null,
      cpuPct: m.cpu.percentCPUUsage,
      idleWakeupsPerSecond: m.cpu.idleWakeupsPerSecond,
      workingSetMiB: m.memory.workingSetSize / 1024
    }))
  )
}

// ── Profiles ─────────────────────────────────────────────────────────────────

function scrubRoots(launchDir) {
  return [
    [launchDir, '<run>'],
    [REPO, '<repo>'],
    ['/Applications/Clave.app', '<app>'],
    [os.homedir(), '~'],
    [os.tmpdir(), '<tmp>']
  ]
}

/** Validate a raw profile, then publish its scrubbed form, its folded
 *  stacks, its attribution and its flamegraph beside it. Throws if the
 *  profile is unsound or a private path survives the scrub. The raw file
 *  stays where it is, in the private run folder, whatever happens. */
function publishProfile(rawFile, outBase, { title, meta, launchDir, minSamples }) {
  const raw = JSON.parse(readFileSync(rawFile, 'utf-8'))
  const size = validateCpuProfile(title, raw, { minSamples })
  const roots = scrubRoots(launchDir)
  const clean = scrubProfile(raw, roots)
  const folded = foldProfile(clean)
  const text = foldedText(folded)
  const { totalUs, rows } = attribute(folded)
  const top = rows.slice(0, 40)
  const html = flamegraphHtml(folded, { title, meta })
  const files = {
    cpuprofile: `${outBase}.cpuprofile`,
    folded: `${outBase}.folded.txt`,
    flamegraph: `${outBase}.flame.html`
  }
  const cleanJson = JSON.stringify(clean)
  for (const [what, body] of [
    ['profile', cleanJson],
    ['folded stacks', text],
    ['flamegraph', html]
  ]) {
    const leaks = privatePathsIn(body, roots)
    if (leaks.length > 0)
      throw new SampleError(`${title}: the ${what} still names ${leaks.slice(0, 3).join(', ')}`)
  }
  writeFileSync(files.cpuprofile, cleanJson)
  writeFileSync(files.folded, text + '\n')
  writeFileSync(files.flamegraph, html)
  return {
    ...size,
    sampledMs: totalUs / 1000,
    breakdown: breakdown(folded),
    top: top.map((r) => ({ ...r, label: scrubText(r.label, roots) })),
    app: appFrames(rows).map((r) => ({ ...r, label: scrubText(r.label, roots) })),
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, path.basename(f)]))
  }
}

// ── One launch ───────────────────────────────────────────────────────────────

/** The app's environment: the caller's, without an outer server's address
 *  or NODE_OPTIONS, plus the seed's (stub shell and agents, transcript roots). */
function appEnv(seed, extra = {}) {
  const base = { ...process.env }
  delete base.CLAVE_SERVER_URL
  delete base.CLAVE_SERVER_TOKEN
  delete base.NODE_OPTIONS
  return { ...base, ...seed.env, ...extra }
}

function appArgs(v, seed) {
  return [...v.appArgs, `--user-data-dir=${seed.dir}`, '--test-no-activate', `--server=${v.server}`]
}

/**
 * The end of every launch, plain, profiled or startup-profile: stop the stub
 * agents the launch started (by the pids they logged), wait up to `waitMs`
 * for each of the launch's own processes to be gone, kill any still alive
 * by its exact pid so nothing outlives the run, and REFUSE the launch if
 * there was one: a launch whose close needed a kill did not close cleanly.
 * When the launch already failed (`bodyFailed`), its own error is the one
 * that propagates and the leftovers are only recorded. Answers what goes
 * into the launch's record.
 */
export async function endLaunch({
  name,
  pids,
  starts = null,
  when,
  bodyFailed,
  waitMs = EXIT_WAIT_MS
}) {
  let stubAgentsKilled = 0
  if (starts && existsSync(starts))
    for (const line of readFileSync(starts, 'utf-8').split('\n').filter(Boolean)) {
      try {
        process.kill(JSON.parse(line).pid, 'SIGTERM')
        stubAgentsKilled++
      } catch {
        // Already gone.
      }
    }
  const leftovers = await waitGone(pids, waitMs)
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone between the check and the kill.
    }
  }
  if (!bodyFailed) requireAllGone(name, leftovers, when)
  return { leftovers, stubAgentsKilled }
}

/**
 * Launch-to-quit profiles of every Node process of the app: main, the
 * server, the terminal process. Playwright removes NODE_OPTIONS from the
 * environment it launches Electron with (main reads it as unset), so this
 * launch is the app started directly, `NODE_OPTIONS=--cpu-prof` inherited by
 * the children it spawns. Ready is the two discovery files of THIS launch
 * (main on its server; the separate server listening), then `settleSeconds`
 * for the window's boot and the restore, then SIGTERM to main: Electron
 * quits the way the menu does, main stops its server, and each process
 * writes its profile as it exits. A dev variant only; see
 * SIGNED_APP_NO_NODE_OPTIONS for the installed app.
 */
async function startupProfileLaunch(cfg, outDir, settleSeconds, log) {
  const name = 'startup-profile'
  const launchDir = path.join(BASE_DIR, 'runs', `${cfg.variant}-${cfg.scale}-${name}`)
  const v = VARIANTS[cfg.variant]
  const seed = seedLaunch(launchDir, cfg.scale, { ...cfg, server: v.server })
  const rawProfiles = path.join(BASE_DIR, 'raw-profiles', path.basename(outDir), name)
  mkdirSync(rawProfiles, { recursive: true })
  const env = appEnv(seed, {
    NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${rawProfiles} --cpu-prof-interval=${PROFILE_INTERVAL_US}`
  })
  const launchAt = Date.now()
  const child = spawn(v.bin, appArgs(v, seed), {
    cwd: v.installed ? launchDir : REPO,
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)))
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  const pids = { main: child.pid }
  const result = { name, settleSeconds, load: coRunningLoad(), profiles: {}, leftovers: [] }
  let bodyFailed = true
  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let ready = null
    while (Date.now() < deadline && child.exitCode === null) {
      const shell = serverEndpoint(seed.dir)
      const own =
        v.server === 'separate'
          ? (() => {
              try {
                return JSON.parse(
                  readFileSync(
                    path.join(separateServerDataDir(seed.dir), 'clave-server.json'),
                    'utf-8'
                  )
                )
              } catch {
                return null
              }
            })()
          : null
      if (
        shell?.ok &&
        shell.pid === child.pid &&
        (v.server !== 'separate' || own?.pid === shell.serverPid)
      ) {
        ready = { shell, own }
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!ready) throw new Error(`${name}: the app never reached its server\n${stderr.slice(-2000)}`)
    result.serverReadyMs = Date.now() - launchAt
    if (ready.shell.serverPid) pids.server = ready.shell.serverPid
    if (Number.isInteger(ready.own?.terminalProcessPid))
      pids.terminal = ready.own.terminalProcessPid
    await new Promise((r) => setTimeout(r, settleSeconds * 1000))
    result.quitAtMs = Date.now() - launchAt
    process.kill(child.pid, 'SIGTERM')
    const end = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r(null), CLOSE_TIMEOUT_MS))
    ])
    if (!end) {
      process.kill(child.pid, 'SIGKILL')
      throw new Error(`${name}: main did not quit within ${CLOSE_TIMEOUT_MS} ms of SIGTERM`)
    }
    result.exit = end
    bodyFailed = false
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Gone.
      }
    }
    Object.assign(
      result,
      await endLaunch({
        name,
        pids: Object.values(pids),
        starts: seed.starts,
        when: 'the quit',
        bodyFailed
      })
    )
  }
  log(
    `${name}: server ready at ${result.serverReadyMs} ms, quit at ${result.quitAtMs} ms, pids ${JSON.stringify(pids)}`
  )

  const roleOf = Object.fromEntries(Object.entries(pids).map(([r, p]) => [p, r]))
  const found = new Set()
  for (const f of readdirSync(rawProfiles).filter((f) => /^CPU\..*\.cpuprofile$/.test(f))) {
    const pid = Number(f.split('.')[3])
    const role = roleOf[pid] ?? `other-${pid}`
    found.add(role)
    result.profiles[`run-${role}`] = publishProfile(
      path.join(rawProfiles, f),
      path.join(outDir, `${name}-${role}`),
      {
        title: `${cfg.variant} ${cfg.scale} · ${role} · launch to quit`,
        meta: {
          variant: cfg.variant,
          scale: cfg.scale,
          process: role,
          window: `launch, ${settleSeconds} s settled after the server was ready, quit (--cpu-prof)`
        },
        launchDir,
        minSamples: 100
      }
    )
  }
  const missing = Object.keys(pids).filter((r) => !found.has(r))
  result.missing = missing
  const refused = missing.filter((r) => !cfg.allowMissingRunProfile.includes(r))
  if (refused.length > 0)
    throw new SampleError(`${name}: no launch-to-quit profile from ${refused.join(', ')}`)
  rmSync(launchDir, { recursive: true, force: true })
  return result
}

async function oneLaunch(cfg, index, profiled, outDir, log) {
  const name = `${profiled ? 'profiled' : 'plain'}-${index + 1}`
  const launchDir = path.join(BASE_DIR, 'runs', `${cfg.variant}-${cfg.scale}-${name}`)
  const v = VARIANTS[cfg.variant]
  const seedStarted = performance.now()
  const seed = seedLaunch(launchDir, cfg.scale, { ...cfg, server: v.server })
  const seedMs = performance.now() - seedStarted
  // Raw profiles carry private paths: kept out of the published folder, and
  // kept after the launch (whose seeded data is removed) so a profile the
  // checks refused can still be read.
  const rawProfiles = path.join(BASE_DIR, 'raw-profiles', path.basename(outDir), name)
  mkdirSync(rawProfiles, { recursive: true })

  const env = appEnv(seed)
  const args = appArgs(v, seed)
  const result = {
    name,
    profiled,
    seedMs,
    load: coRunningLoad(),
    startup: {},
    postBoot: null,
    idle: null,
    queries: null,
    profiles: {},
    leftovers: [],
    stubAgentsKilled: 0
  }
  const expected = seed.groups.map((g) => ({ group: g.id, ids: g.ids }))

  const launchAt = Date.now()
  const app = await electron.launch({
    executablePath: v.bin,
    args,
    cwd: v.installed ? launchDir : REPO,
    env,
    timeout: BOOT_TIMEOUT_MS
  })
  const mainPid = app.process().pid
  const pids = { main: mainPid }
  // Every Electron process seen, for the leftover check after the close.
  const electronPids = new Set()
  let bodyFailed = true
  try {
    const launchedAt = Date.now()
    const win = await app.firstWindow({ timeout: BOOT_TIMEOUT_MS })
    await win.waitForLoadState('domcontentloaded')
    await win.evaluate(installBootWatch, expected)
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let watch = null
    while (Date.now() < deadline) {
      watch = await win.evaluate(() => window.__benchB)
      const found = serverEndpoint(seed.dir)
      if (watch.bootAt !== null && watch.rowsAt !== null && found?.pid === mainPid && found.ok)
        break
      await new Promise((r) => setTimeout(r, 50))
    }
    const discovery = serverEndpoint(seed.dir)
    if (watch?.bootAt == null) throw new Error(`${name}: the window did not finish its boot`)
    if (watch.rowsAt == null)
      throw new Error(`${name}: the seeded tabs never all reached their groups`)
    if (!discovery?.ok || discovery.pid !== mainPid)
      throw new Error(
        `${name}: no server for this launch (${JSON.stringify(discovery?.error ?? discovery)})`
      )

    const server = serverFixture(discovery.url, discovery.token)
    const inProc = runner(app, server)
    const page = await win.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      dcl: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? null
    }))
    const main = await inProc.main(processTiming)
    const srv = await inProc.server(processTiming)
    if (main.pid !== mainPid)
      throw new Error(`${name}: main reports pid ${main.pid}, not ${mainPid}`)
    if (v.server === 'separate') {
      if (srv.pid === mainPid || srv.pid !== discovery.serverPid)
        throw new Error(
          `${name}: the server answered from pid ${srv.pid}, expected ${discovery.serverPid}`
        )
      pids.server = srv.pid
      const own = JSON.parse(
        readFileSync(path.join(separateServerDataDir(seed.dir), 'clave-server.json'), 'utf-8')
      )
      if (Number.isInteger(own.terminalProcessPid)) pids.terminal = own.terminalProcessPid
    } else if (srv.pid !== mainPid) {
      throw new Error(`${name}: in-process server answered from pid ${srv.pid}`)
    }
    pids.renderer = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    )
    const shellDiscoveryAt = statSync(path.join(seed.dir, 'clave-server.json')).mtimeMs
    const rel = (t) => (t == null ? null : Math.round((t - launchAt) * 10) / 10)
    result.startup = {
      launchResolvedMs: rel(launchedAt),
      mainProcessStartMs: rel(main.timeOrigin),
      mainLoopStartMs: rel(nodeTimingMark(main.timeOrigin, main.loopStart)),
      serverProcessStartMs: v.server === 'separate' ? rel(srv.timeOrigin) : null,
      serverLoopStartMs:
        v.server === 'separate' ? rel(nodeTimingMark(srv.timeOrigin, srv.loopStart)) : null,
      shellOnServerMs: rel(shellDiscoveryAt),
      rendererNavigationStartMs: rel(page.timeOrigin),
      domContentLoadedMs: page.dcl == null ? null : rel(page.timeOrigin + page.dcl),
      bootCompleteMs: rel(page.timeOrigin + watch.bootAt),
      tabsInGroupsMs: seed.ids.length === 0 ? null : rel(page.timeOrigin + watch.rowsAt),
      bootState: watch.bootState,
      restorePromptSeen: watch.promptSeen
    }
    requireStartupOrder(name, result.startup)
    for (const k of ['mainProcessStartMs', 'domContentLoadedMs', 'bootCompleteMs'])
      if (!Number.isFinite(result.startup[k]))
        throw new SampleError(`${name}: startup ${k} missing`)
    result.processes = {
      pids: Object.keys(pids),
      main: main.versions,
      server: v.server === 'separate' ? srv.versions : 'in main'
    }
    log(`${name}: booted in ${result.startup.bootCompleteMs} ms, pids ${JSON.stringify(pids)}`)

    const roles = v.server === 'separate' ? ['main', 'server'] : ['main']
    const call = (role, fn, arg) => inProc[role](fn, arg)

    // After the boot: the restore's tail (sessions adopted, records written)
    // runs on past the tabs being drawn. Recorded on its own, so the idle
    // window after it is the app at rest.
    if (cfg.postBootSeconds > 0) {
      const stop = psSampler(pids)
      await new Promise((r) => setTimeout(r, cfg.postBootSeconds * 1000))
      const series = stop()
      result.postBoot = {
        seconds: cfg.postBootSeconds,
        ps: Object.fromEntries(
          Object.entries(series).map(([role, s]) => [role, { cpuPct: s.cpuPct, rssMiB: s.rssMiB }])
        )
      }
    }

    // Idle: the event loop and the CPU of every process, nothing asked.
    const idleSeconds = profiled ? cfg.profileIdleSeconds : cfg.idleSeconds
    for (const role of roles)
      await call(role, startProbe, { key: 'idle', resolutionMs: ELD_RESOLUTION_MS })
    if (profiled)
      for (const role of roles)
        await call(role, startProfiler, { key: 'idle', intervalUs: PROFILE_INTERVAL_US })
    await appMetrics(app)
    const stopPs = psSampler(pids)
    await new Promise((r) => setTimeout(r, idleSeconds * 1000))
    const ps = stopPs()
    const idle = {
      seconds: idleSeconds,
      ps: {},
      eventLoop: {},
      electronProcesses: await appMetrics(app)
    }
    for (const m of idle.electronProcesses) if (m.pid !== mainPid) electronPids.add(m.pid)
    for (const [role, s] of Object.entries(ps)) {
      idle.ps[role] = {
        cpuPct: summarize(`${name} idle ${role} cpu`, s.cpuPct, { minN: idleSeconds - 2 }),
        rssMiB: summarize(`${name} idle ${role} rss`, s.rssMiB, { minN: idleSeconds - 2 }),
        raw: s
      }
    }
    for (const role of roles) {
      const probe = await call(role, stopProbe, { key: 'idle' })
      idle.eventLoop[role] = {
        ...probe,
        delayMs: eventLoopDelayMs(`${name} idle ${role}`, probe.histogram, {
          resolutionMs: ELD_RESOLUTION_MS
        })
      }
      if (profiled) {
        const file = path.join(rawProfiles, `window-idle-${role}.cpuprofile`)
        await call(role, stopProfiler, { key: 'idle', file })
        result.profiles[`idle-${role}`] = publishProfile(
          file,
          path.join(outDir, `${name}-idle-${role}`),
          {
            title: `${cfg.variant} ${cfg.scale} · ${role} · idle ${idleSeconds}s`,
            meta: {
              variant: cfg.variant,
              scale: cfg.scale,
              process: role,
              window: `idle ${idleSeconds} s`
            },
            launchDir,
            minSamples: 50
          }
        )
      }
    }
    result.idle = idle

    // Queries: each method in turn from the window, the event loop and the
    // CPU of main and the server recorded over the whole pass.
    for (const role of roles)
      await call(role, startProbe, { key: 'queries', resolutionMs: ELD_RESOLUTION_MS })
    if (profiled)
      for (const role of roles)
        await call(role, startProfiler, { key: 'queries', intervalUs: PROFILE_INTERVAL_US })
    const queries = { methods: {}, eventLoop: {} }
    const passStarted = performance.now()
    for (const q of queryPlan(seed)) {
      const timed = await win.evaluate(timeMethod, {
        method: q.method,
        args: q.args,
        warmup: cfg.queryWarmup,
        n: cfg.queryIterations,
        check: q.check
      })
      queries.methods[q.method] = {
        road: q.road,
        note: q.note ?? null,
        coldMs: timed.coldMs,
        answerBytes: timed.answerBytes,
        warm: summarize(`${name} ${q.method}`, timed.samples, { minN: cfg.queryIterations }),
        raw: timed.samples
      }
    }
    queries.passMs = performance.now() - passStarted
    for (const role of roles) {
      const probe = await call(role, stopProbe, { key: 'queries' })
      queries.eventLoop[role] = {
        ...probe,
        delayMs: eventLoopDelayMs(`${name} queries ${role}`, probe.histogram, {
          resolutionMs: ELD_RESOLUTION_MS
        })
      }
      if (profiled) {
        const file = path.join(rawProfiles, `window-queries-${role}.cpuprofile`)
        await call(role, stopProfiler, { key: 'queries', file })
        result.profiles[`queries-${role}`] = publishProfile(
          file,
          path.join(outDir, `${name}-queries-${role}`),
          {
            title: `${cfg.variant} ${cfg.scale} · ${role} · query pass`,
            meta: { variant: cfg.variant, scale: cfg.scale, process: role, window: 'query pass' },
            launchDir,
            minSamples: 50
          }
        )
      }
    }
    result.queries = queries
    bodyFailed = false
  } finally {
    const known = [...new Set([...Object.values(pids), ...electronPids])]
    await boundedClose(() => app.close(), mainPid, CLOSE_TIMEOUT_MS, { log })
    Object.assign(
      result,
      await endLaunch({ name, pids: known, starts: seed.starts, when: 'the close', bodyFailed })
    )
  }

  rmSync(launchDir, { recursive: true, force: true })
  return result
}

// ── The configuration ────────────────────────────────────────────────────────

/** Startup marks across launches: every value kept, the order statistics
 *  where they mean something (p95 only from 20 launches on). */
function startupSummary(launches) {
  const keys = Object.keys(launches[0]?.startup ?? {}).filter((k) => k.endsWith('Ms'))
  const out = {}
  for (const k of keys) {
    const values = launches.map((l) => l.startup[k]).filter((x) => x !== null)
    if (values.length === 0) continue
    if (values.length !== launches.length)
      throw new SampleError(
        `startup ${k}: present in ${values.length} of ${launches.length} launches`
      )
    out[k] = { ...summarize(`startup ${k}`, values), values }
  }
  return out
}

export async function main(argv) {
  const cfg = options(argv)
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(
    cfg.out,
    `${cfg.variant}-${cfg.scale}${cfg.label ? `-${cfg.label}` : ''}-${stamp}`
  )
  mkdirSync(outDir, { recursive: true })
  const log = (line) => process.stderr.write(`[backend-bench] ${line}\n`)
  const record = {
    v: 1,
    lane: 'clave-perf-20261015 lane B (#188)',
    startedAt: startedAt.toISOString(),
    config: { ...cfg, out: undefined },
    machine: machineIdentity(),
    build: buildIdentity(cfg.variant),
    mode: 'test-no-activate (hidden window, background throttling off): not foreground latency',
    workload: {
      ...SCALES[cfg.scale],
      codexShare: CODEX_SHARE,
      agents: 'stub claude/codex (log + sleep), no inference',
      historyChats: cfg.historyChats,
      historyTurns: cfg.historyTurns
    },
    plain: [],
    profiled: [],
    status: 'running'
  }
  const write = () => writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(record, null, 2))
  write()
  try {
    for (let i = 0; i < cfg.launches; i++) {
      record.plain.push(await oneLaunch(cfg, i, false, outDir, log))
      write()
    }
    for (let i = 0; i < cfg.profiledLaunches; i++) {
      record.profiled.push(await oneLaunch(cfg, i, true, outDir, log))
      write()
    }
    // Launch-to-quit profiles: a launch of their own, outside Playwright.
    const v = VARIANTS[cfg.variant]
    if (cfg.profiledLaunches > 0) {
      record.startupProfile =
        v.runProfiles === undefined
          ? await startupProfileLaunch(cfg, outDir, cfg.startupSettleSeconds, log)
          : { unavailable: v.runProfiles }
      write()
    }
    requireSamples(
      'plain launches',
      record.plain.map((l) => l.startup.bootCompleteMs),
      {
        minN: cfg.launches
      }
    )
    record.summary = { startup: startupSummary(record.plain) }
    if (record.profiled.length > 0) record.summary.profiledStartup = startupSummary(record.profiled)
    record.status = 'ok'
    write()
    log(`ok → ${outDir}`)
    return outDir
  } catch (err) {
    record.status = 'failed'
    record.error = err?.stack ?? String(err)
    write()
    throw err
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[backend-bench] FAILED: ${err?.stack ?? err}\n`)
      process.exit(1)
    }
  )
}
