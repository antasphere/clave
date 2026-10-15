#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript, like the Electron harness. */
// Real Electron renderer measurements. Never attach to an existing app/profile.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import {
  seedWorkspaces,
  waitForBoot,
  appServerFixture,
  callMcp,
  REPO
} from '../../tests/e2e/harness.mjs'
import { boundedClose } from '../../tests/e2e/bounds.mjs'
import {
  summarize,
  scrubProfile,
  validateProfile,
  flamegraph,
  profileHotspots
} from './renderer-data.mjs'

const { values } = parseArgs({
  options: {
    build: { type: 'string', default: 'dev' },
    out: { type: 'string' },
    runs: { type: 'string', default: '5' },
    samples: { type: 'string', default: '30' },
    tabs: { type: 'string', default: '24' },
    turns: { type: 'string', default: '200' },
    'idle-ms': { type: 'string', default: '5000' },
    source: { type: 'string' }
  }
})
assert.ok(['dev', 'installed'].includes(values.build), '--build must be dev or installed')
assert.ok(values.out, '--out is required, use a new artifact directory')
const cfg = Object.fromEntries(
  ['runs', 'samples', 'tabs', 'turns', 'idle-ms'].map((k) => {
    const n = Number(values[k])
    assert.ok(Number.isInteger(n) && n > 0, `invalid --${k}`)
    return [k, n]
  })
)
assert.ok(cfg.tabs >= 8 && cfg.tabs % 4 === 0, '--tabs must be a multiple of four >=8')
const out = path.resolve(values.out)
mkdirSync(out, { recursive: false }) // Refuse overwriting a previous measurement.
const base = '/tmp/clave-perf-1015-a'
mkdirSync(base, { recursive: true })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (name, value) =>
  writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
const installed = values.build === 'installed'
const result = {
  schema: 1,
  build: values.build,
  source: installed ? (values.source ?? 'unknown') : sha,
  sourceBasis: installed
    ? 'operator-supplied installed release tag; executable hash below'
    : 'git HEAD, tooling-only working changes',
  startedAt: new Date().toISOString(),
  config: cfg,
  machine: {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramGiB: os.totalmem() / 2 ** 30,
    node: process.version
  },
  protocol: {
    server: 'separate',
    hidden: true,
    noActivate: true,
    warmups: 5,
    profilerIntervalUs: 1000,
    synthetic: true
  },
  runs: []
}

async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}
async function idle(cdp) {
  const before = await metrics(cdp)
  await delay(cfg['idle-ms'])
  const after = await metrics(cdp)
  const r = {
    elapsedMs: 1000 * (after.Timestamp - before.Timestamp),
    taskMs: 1000 * (after.TaskDuration - before.TaskDuration),
    scriptMs: 1000 * (after.ScriptDuration - before.ScriptDuration),
    heapBytes: after.JSHeapUsedSize
  }
  assert.ok(
    r.elapsedMs > 0 && Number.isFinite(r.taskMs) && r.taskMs >= 0,
    'idle metrics unavailable'
  )
  return r
}
async function saveProfile(cdp, label, run) {
  const { profile } = await cdp.send('Profiler.stop')
  let p
  try {
    p = scrubProfile(profile)
  } catch (error) {
    throw new Error(
      `Profiler rejected ${label}, samples=${profile.samples?.length}, minDeltaUs=${Math.min(...(profile.timeDeltas ?? []))}, negativeDeltas=${profile.timeDeltas?.filter((x) => x < 0).length}: ${error}`
    )
  }
  const checked = validateProfile(p)
  const stem = `run-${run}-${label}`
  json(`${stem}.cpuprofile`, p)
  writeFileSync(
    path.join(out, `${stem}.html`),
    flamegraph(p, `${values.build} ${label} run ${run}`)
  )
  return {
    file: `${stem}.cpuprofile`,
    samples: p.samples.length,
    sampledMs: checked.totalUs / 1000,
    hotspots: profileHotspots(p)
  }
}

// Capture starts at the DOM event, excluding Playwright's actionability wait.
// Two rAF callbacks bracket a rendering opportunity, not a presented pixel.
async function arm(page, selector, type) {
  await page.evaluate(
    ({ selector, type }) => {
      if (!document.querySelector(selector)) throw new Error(`missing workload target ${selector}`)
      window.__rendererMeasurement = null
      const listener = (event) => {
        if (!event.target.closest(selector)) return
        document.removeEventListener(type, listener, true)
        const start = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__rendererMeasurement = performance.now() - start
          })
        )
      }
      document.addEventListener(type, listener, true)
    },
    { selector, type }
  )
}
async function observed(page) {
  await page.waitForFunction(() => window.__rendererMeasurement != null, null, { timeout: 10_000 })
  return page.evaluate(() => window.__rendererMeasurement)
}
const view = '[data-testid="chat-view"]'
const composer = `${view} textarea:not(:disabled)`
async function interactions(page, workload) {
  const { records, groups } = workload
  const samples = { tab: [], group: [], composer: [], scroll: [] }
  let active = records.at(-1)
  const selectedView = () => `.chat-host[data-session-id="${active}"] ${view}`
  const selectedComposer = () => `${selectedView()} textarea:not(:disabled)`
  const perGroup = cfg.tabs / 4
  for (const kind of Object.keys(samples)) {
    if (kind === 'composer' || kind === 'scroll') {
      active = records[0]
      await page.locator(`[data-sidebar-item-id="${active}"] > button`).click()
      await page.locator(selectedComposer()).waitFor()
    }
    for (let i = 0; i < cfg.samples + 5; i++) {
      if (kind === 'tab' || kind === 'group') {
        const index = kind === 'tab' ? i % perGroup : (i % 4) * perGroup
        const target = records[index]
        const selector = `[data-sidebar-item-id="${kind === 'group' ? groups[i % 4] : target}"] > button`
        active = target
        await arm(page, selector, 'click')
        await page.locator(selector).click()
        const ms = await observed(page)
        await page.locator(selectedComposer()).waitFor()
        // Verify the selected synthetic transcript at its preserved scroll position.
        await page
          .locator(`${selectedView()} .chat-turn`)
          .filter({ hasText: `Tab ${index} turn ` })
          .first()
          .waitFor()
        if (i >= 5) samples[kind].push(ms)
      } else if (kind === 'composer') {
        await page.locator(selectedComposer()).fill('')
        await arm(page, selectedComposer(), 'input')
        await page.locator(selectedComposer()).pressSequentially('x')
        const ms = await observed(page)
        assert.equal(
          await page.locator(selectedComposer()).inputValue(),
          'x',
          'composer failed to accept input'
        )
        if (i >= 5) samples[kind].push(ms)
      } else {
        const selector = `${selectedView()} .chat-scroll`
        const g = await page.locator(selector).evaluate((el) => ({
          height: el.scrollHeight,
          client: el.clientHeight,
          top: el.scrollTop
        }))
        assert.ok(g.height > 2 * g.client, 'transcript does not overflow')
        await arm(page, selector, 'scroll')
        const target = g.top > g.client ? 0 : g.height
        await page.locator(selector).evaluate((el, top) => {
          el.scrollTop = top
        }, target)
        const ms = await observed(page)
        const top = await page.locator(selector).evaluate((el) => el.scrollTop)
        assert.ok(target === 0 ? top < 2 : top > g.client, 'scroll did not move transcript')
        if (i >= 5) samples[kind].push(ms)
      }
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([k, v]) => [k, { rawMs: v, summary: summarize(v) }])
  )
}

async function seed(app, page, fixture, root) {
  const records = []
  const groups = []
  for (let g = 0; g < 4; g++)
    groups.push((await callMcp(app, 'createGroup', { name: `Synthetic group ${g}` })).groupId)
  for (let i = 0; i < cfg.tabs; i++) {
    const opened = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      profile: 'dev-echo-adapter',
      groupId: groups[Math.floor(i / (cfg.tabs / 4))],
      name: `Synthetic tab ${i}`,
      account: 'default'
    })
    records.push(opened.sessionId)
    await page.locator(`[data-sidebar-item-id="${opened.sessionId}"] > button`).click()
    await page.locator(`.chat-host[data-session-id="${opened.sessionId}"] ${composer}`).waitFor()
    await fixture.evaluate(
      ({ id, index, turns }) => {
        for (let n = 0; n < turns; n++) {
          const text =
            `Tab ${index} turn ${n}.\n\n` +
            (n % 2
              ? '**Synthetic report.** A deterministic paragraph for renderer profiling. '.repeat(
                  8
                ) + '\n\n```ts\nconst measurement = 42\n```'
              : 'Describe a synthetic renderer workload. '.repeat(8))
          globalThis.__claveE2E.echo.inject(id, {
            kind: 'event',
            event:
              n % 2
                ? { type: 'assistant_text', delta: text, final: true }
                : { type: 'user_message', text }
          })
        }
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: { type: 'state_change', state: 'done' }
        })
      },
      { id: opened.sessionId, index: i, turns: cfg.turns }
    )
    await page
      .locator(`.chat-host[data-session-id="${opened.sessionId}"] ${view} .chat-turn`)
      .filter({ hasText: `Tab ${i} turn ${cfg.turns - 1}.` })
      .waitFor()
  }
  const sessions = await page.evaluate(() => window.electronAPI.sessionsList())
  assert.equal(sessions.length, cfg.tabs, 'incorrect workload session count')
  assert.ok(
    sessions.every((s) => s.adapterId === 'echo'),
    'a non-synthetic adapter was launched'
  )
  return { records, groups }
}

for (let run = 1; run <= cfg.runs; run++) {
  const dir = mkdtempSync(path.join(base, 'run-')),
    root = path.join(dir, 'workspace')
  mkdirSync(root)
  seedWorkspaces(dir, {
    workspaces: [
      { id: 'synthetic', name: 'Synthetic', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'synthetic'
  })
  let app, cdp
  const r = { run, beforeLoad: os.loadavg(), startedAt: new Date().toISOString() }
  try {
    const env = { ...process.env, CLAVE_E2E_NS: 'clave-perf-1015-a' }
    for (const k of [
      'CLAVE_SERVER_URL',
      'CLAVE_SERVER_TOKEN',
      'ELECTRON_RUN_AS_NODE',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_API_KEY'
    ])
      delete env[k]
    const executablePath = installed
      ? '/Applications/Clave.app/Contents/MacOS/Clave'
      : path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    r.executableSha256 = createHash('sha256').update(readFileSync(executablePath)).digest('hex')
    const start = performance.now()
    app = await _electron.launch({
      executablePath: installed
        ? '/Applications/Clave.app/Contents/MacOS/Clave'
        : path.join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [
        ...(installed ? [] : ['.']),
        `--user-data-dir=${dir}`,
        '--test-no-activate',
        '--server=separate',
        '--dev-echo-adapter'
      ],
      cwd: REPO,
      env,
      timeout: 60_000
    })
    const page = await app.firstWindow()
    r.pageErrors = []
    page.on('pageerror', (error) => r.pageErrors.push(error.message))
    page.setDefaultTimeout(15_000)
    await page.waitForLoadState('domcontentloaded')
    await waitForBoot(page, { dir, pid: app.process().pid })
    r.startupMs = performance.now() - start
    r.identity = await app.evaluate(({ app, BrowserWindow }) => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      backgroundThrottling: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
      userData: app.getPath('userData')
    }))
    assert.equal(r.identity.userData, dir, 'app data isolation failed')
    delete r.identity.userData
    assert.equal(r.identity.visible, false, 'test window became visible')
    assert.equal(r.identity.backgroundThrottling, false)
    const endpoint = JSON.parse(readFileSync(path.join(dir, 'clave-server.json'), 'utf8'))
    assert.equal(endpoint.mode, 'separate', 'unexpected server mode')
    r.server = { mode: endpoint.mode, port: new URL(endpoint.url).port }
    r.pids = {
      main: app.process().pid,
      renderer: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
      )
    }
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    r.reloadAttempts = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await cdp.send('Profiler.start')
      const reloadStart = performance.now()
      await page.reload()
      await waitForBoot(page, { dir, pid: app.process().pid })
      const ms = performance.now() - reloadStart
      try {
        r.startupProfile = await saveProfile(cdp, 'renderer-reload', run)
        r.reloadStartupMs = ms
        r.reloadAttempts.push({ attempt, ms, ok: true })
        break
      } catch (error) {
        // V8 occasionally reports a negative interval at reload. Reject it,
        // retain the failed timing/diagnostic, then retry the whole reload.
        r.reloadAttempts.push({ attempt, ms, ok: false, error: String(error) })
        console.log(
          JSON.stringify({ run, phase: 'reload-profile-rejected', attempt, error: String(error) })
        )
        if (attempt === 3 || !String(error).includes('Profiler rejected renderer-reload'))
          throw error
      }
    }
    r.viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio
    }))
    await delay(1000)
    r.emptyIdle = await idle(cdp)
    await cdp.send('Profiler.start')
    r.emptyIdleProfiled = await idle(cdp)
    r.emptyProfile = await saveProfile(cdp, 'empty-idle', run)
    const seedStart = performance.now()
    const records = await seed(app, page, appServerFixture(dir), root)
    r.setupMs = performance.now() - seedStart
    await delay(1000)
    r.loadedIdle = await idle(cdp)
    await cdp.send('Profiler.start')
    r.loadedIdleProfiled = await idle(cdp)
    r.loadedProfile = await saveProfile(cdp, 'many-idle', run)
    console.log(JSON.stringify({ run, phase: 'unsampled', tabs: cfg.tabs, turns: cfg.turns }))
    r.unsampled = await interactions(page, records)
    await cdp.send('Profiler.start')
    console.log(JSON.stringify({ run, phase: 'sampled' }))
    r.sampled = await interactions(page, records)
    r.interactionProfile = await saveProfile(cdp, 'interactions', run)
    r.afterLoad = os.loadavg()
    assert.deepEqual(r.pageErrors, [], 'renderer raised an uncaught exception')
    r.ok = true
  } catch (error) {
    r.ok = false
    r.error = String(error).replaceAll(REPO, '[repo]').replaceAll(dir, '[run-data]')
    throw error
  } finally {
    if (cdp) await cdp.detach().catch(() => {})
    if (app) r.close = await boundedClose(() => app.close(), app.process().pid, 25_000)
    rmSync(dir, { recursive: true, force: true })
    r.cleaned = true
    result.runs.push(r)
    json('measurements.json', result)
    console.log(
      JSON.stringify({ run, ok: r.ok, startupMs: r.startupMs, setupMs: r.setupMs, error: r.error })
    )
  }
}
result.completedAt = new Date().toISOString()
assert.equal(result.runs.length, cfg.runs)
assert.ok(
  result.runs.every((r) => r.ok && r.cleaned),
  'incomplete workload'
)
result.summary = {
  startup: summarize(result.runs.map((r) => r.startupMs)),
  unsampled: Object.fromEntries(
    ['tab', 'group', 'composer', 'scroll'].map((k) => [
      k,
      summarize(result.runs.flatMap((r) => r.unsampled[k].rawMs))
    ])
  ),
  sampled: Object.fromEntries(
    ['tab', 'group', 'composer', 'scroll'].map((k) => [
      k,
      summarize(result.runs.flatMap((r) => r.sampled[k].rawMs))
    ])
  )
}
json('measurements.json', result)
console.log(JSON.stringify(result.summary))
