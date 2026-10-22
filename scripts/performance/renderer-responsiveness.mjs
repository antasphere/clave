#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript benchmark */
// Fixed issue #204 workload. Before and after use these exact bytes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { launchApp, seedWorkspaces, REPO } from '../../tests/e2e/harness.mjs'
import {
  chatSelector,
  LONG_RESPONSE,
  loadWorkloadScenario,
  seedRendererWorkload
} from '../../tests/e2e/renderer-workload.mjs'
import { scrubProfile, normalizeProfile, flamegraph } from './renderer-data.mjs'
import { responsivenessSummary } from './responsiveness-data.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    runs: { type: 'string', default: '3' },
    samples: { type: 'string', default: '30' }
  }
})
assert.ok(values.out, '--out is required and must be a fresh directory')
const runs = Number(values.runs),
  samples = Number(values.samples)
assert.ok(Number.isInteger(runs) && runs > 0)
assert.ok(Number.isInteger(samples) && samples >= 20)
const out = path.resolve(values.out)
mkdirSync(out, { recursive: false })
const privateRaw = mkdtempSync(path.join(os.tmpdir(), 'clave-responsiveness-raw-'))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const runtimeFiles = [
  'scripts/performance/renderer-responsiveness.mjs',
  'scripts/performance/responsiveness-data.mjs',
  'scripts/performance/renderer-data.mjs',
  'tests/e2e/renderer-workload.mjs',
  'tests/e2e/renderer-responsiveness-fixture.mjs',
  'tests/e2e/harness.mjs',
  'tests/e2e/bounds.mjs'
]
const result = {
  schema: 1,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  config: {
    tabs: 100,
    groups: 10,
    historyTabs: 20,
    turns: 200,
    samples,
    warmups: 5,
    responseBytes: Buffer.byteLength(LONG_RESPONSE),
    intervalMs: 50,
    payloadBytes: 128,
    idleMs: 5000,
    hidden: true,
    noActivate: true,
    server: 'separate',
    profileIntervalUs: 1000
  },
  toolingSha256: Object.fromEntries(
    runtimeFiles.map((name) => [name, sha256(readFileSync(path.join(REPO, name)))])
  ),
  machine: {
    cpu: os.cpus()[0].model,
    cpus: os.cpus().length,
    arch: os.arch(),
    release: os.release(),
    node: process.version
  },
  startedAt: new Date().toISOString(),
  runs: []
}
const json = (name, data) =>
  writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n')
const save = () => json('measurements.json', result)
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}
async function arm(win, selector, type) {
  await win.evaluate(
    ({ selector, type }) => {
      if (!document.querySelector(selector)) throw new Error('missing input target')
      window.__responsivenessFrame = null
      const listener = (event) => {
        if (!event.target.closest(selector)) return
        document.removeEventListener(type, listener, true)
        const start = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__responsivenessFrame = performance.now() - start
          })
        )
      }
      document.addEventListener(type, listener, true)
    },
    { selector, type }
  )
}
async function observed(win) {
  await win.waitForFunction(() => window.__responsivenessFrame != null)
  return win.evaluate(() => window.__responsivenessFrame)
}
async function interactions(win, workload) {
  const timings = {}
  for (const kind of ['tab', 'group', 'composer']) {
    const values = { handlerMs: [], requestMs: [] }
    if (kind === 'composer') {
      await win.locator(`[data-sidebar-item-id="${workload.records[0]}"] > button`).click()
      await win.locator(`${chatSelector(workload.records[0])} textarea:not(:disabled)`).waitFor()
    }
    for (let i = 0; i < samples + 5; i++) {
      let handler, request
      if (kind === 'composer') {
        const field = win.locator(`${chatSelector(workload.records[0])} textarea:not(:disabled)`)
        await field.fill('')
        await arm(win, `${chatSelector(workload.records[0])} textarea`, 'input')
        const start = performance.now()
        await win.keyboard.insertText('x')
        assert.equal(await field.inputValue(), 'x', 'controlled composer accepts native input')
        request = performance.now() - start
        handler = await observed(win)
      } else {
        const index = kind === 'tab' ? i % 10 : (i % 10) * 10
        const id = kind === 'tab' ? workload.records[index] : workload.groups[i % 10]
        const selector = `[data-sidebar-item-id="${id}"] > button`
        await arm(win, selector, 'click')
        const start = performance.now()
        await win.locator(selector).click()
        handler = await observed(win)
        const view = win.locator(chatSelector(workload.records[index]))
        await view.locator('textarea:not(:disabled)').waitFor()
        await view
          .locator('.chat-turn')
          .filter({ hasText: new RegExp(`Tab ${index} turn |Synthetic response`) })
          .first()
          .waitFor()
        request = performance.now() - start
      }
      if (i >= 5) {
        values.handlerMs.push(handler)
        values.requestMs.push(request)
      }
    }
    timings[kind] = values
  }
  return timings
}

for (let run = 1; run <= runs; run++) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-responsiveness-'))
  const root = path.join(dir, 'workspace')
  mkdirSync(root)
  seedWorkspaces(dir, {
    workspaces: [
      { id: 'synthetic', name: 'Synthetic', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'synthetic'
  })
  let app, win, fixture, cdp
  const record = {
    run,
    startedAt: new Date().toISOString(),
    load: os.loadavg(),
    pageErrors: [],
    phases: {}
  }
  result.runs.push(record)
  try {
    ;({ app, win, fixture } = await launchApp(dir, {
      server: 'separate',
      args: ['--dev-echo-adapter']
    }))
    win.on('pageerror', (error) => record.pageErrors.push(error.message))
    win.setDefaultTimeout(15_000)
    record.identity = await app.evaluate(({ app, BrowserWindow }) => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      throttled: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
      userData: app.getPath('userData')
    }))
    assert.equal(record.identity.userData, dir)
    delete record.identity.userData
    assert.equal(record.identity.visible, false)
    assert.equal(record.identity.throttled, false)
    record.pids = {
      main: app.process().pid,
      renderer: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
      )
    }
    const endpoint = JSON.parse(readFileSync(path.join(dir, 'clave-server.json'), 'utf8'))
    record.server = { mode: endpoint.mode, port: new URL(endpoint.url).port }
    assert.equal(record.server.mode, 'separate')
    record.rendererSha256 = Object.fromEntries(
      readdirSync(path.join(REPO, 'out/renderer/assets'))
        .filter((n) => n.endsWith('.js'))
        .map((n) => [n, sha256(readFileSync(path.join(REPO, 'out/renderer/assets', n)))])
    )
    const receipt = await loadWorkloadScenario(
      () => seedRendererWorkload(app, win, fixture, root),
      path.join(dir, 'scenario.mjs')
    )
    record.fixture = { scenario: 'chat/renderer-responsiveness', runId: receipt.runId }
    const workload = receipt.values.workload
    const id = workload.records[0]
    await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
    await win.evaluate((id) => {
      window.__responsivenessSeen = []
      window.__responsivenessOff = window.electronAPI.onSessionStream(id, (value) => {
        if (
          value.kind === 'event' &&
          value.event.type === 'assistant_text' &&
          /^chunk\d{6} /.test(value.event.delta)
        )
          window.__responsivenessSeen.push(value.event.delta)
      })
    }, id)
    await fixture.evaluate(
      ({ id, text }) => {
        for (const event of [
          { type: 'state_change', state: 'working' },
          { type: 'assistant_text', delta: text, final: false }
        ])
          globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
      },
      { id, text: LONG_RESPONSE }
    )
    await win
      .locator(`${chatSelector(id)} .chat-turn`)
      .filter({ hasText: 'Synthetic response' })
      .waitFor()
    await delay(1000)
    cdp = await win.context().newCDPSession(win)
    await cdp.send('Performance.enable')
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
    for (const phase of ['off', 'on']) {
      console.log(JSON.stringify({ run, phase, at: new Date().toISOString() }))
      await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
      await win.evaluate(() => {
        window.__responsivenessSeen = []
      })
      await cdp.send('Profiler.start')
      await fixture.evaluate(
        ({ id, enabled }) => {
          const state = { started: Date.now(), stopped: null, chunks: [], ceilingReached: false }
          state.stop = () => {
            clearInterval(state.timer)
            state.stopped ??= Date.now()
          }
          if (enabled)
            state.timer = setInterval(() => {
              if (Date.now() - state.started >= 90_000) {
                state.ceilingReached = true
                state.stop()
                return
              }
              const text =
                `chunk${String(state.chunks.length).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
              state.chunks.push(text)
              globalThis.__claveE2E.echo.inject(id, {
                kind: 'event',
                event: { type: 'assistant_text', delta: text, final: false }
              })
            }, 50)
          globalThis.__responsivenessStream = state
        },
        { id, enabled: phase === 'on' }
      )
      const start = await metrics(cdp)
      await delay(5000)
      const end = await metrics(cdp)
      const idle = {
        elapsedMs: (end.Timestamp - start.Timestamp) * 1000,
        taskMs: (end.TaskDuration - start.TaskDuration) * 1000,
        scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000
      }
      const timings = await interactions(win, workload)
      const produced = await fixture.evaluate(() => {
        const s = globalThis.__responsivenessStream
        s.stop()
        return {
          elapsedMs: s.stopped - s.started,
          chunks: s.chunks,
          ceilingReached: s.ceilingReached
        }
      })
      assert.equal(produced.ceilingReached, false)
      assert.ok(produced.elapsedMs > 0 && produced.elapsedMs < 90_000)
      await win.waitForFunction(
        (n) => window.__responsivenessSeen.length >= n,
        produced.chunks.length
      )
      const seen = await win.evaluate(() => window.__responsivenessSeen)
      assert.deepEqual(
        seen,
        produced.chunks,
        'every uniquely numbered delta arrives once and in order'
      )
      assert.ok(phase === 'on' ? seen.length >= 100 : seen.length === 0)
      const { profile } = await cdp.send('Profiler.stop')
      writeFileSync(path.join(privateRaw, `${run}-${phase}.cpuprofile`), JSON.stringify(profile), {
        mode: 0o600
      })
      const raw = scrubProfile(profile, { allowSigned: true })
      const normalized = normalizeProfile(raw)
      const stem = `run-${run}-${phase}`
      json(`${stem}.raw.cpuprofile`, raw)
      json(`${stem}.cpuprofile`, normalized.profile)
      writeFileSync(
        path.join(out, `${stem}.html`),
        flamegraph(normalized.profile, `Renderer responsiveness ${phase}, run ${run}`)
      )
      record.phases[phase] = {
        idle,
        timings,
        produced,
        observed: seen,
        actualEventsPerSecond: seen.length / (produced.elapsedMs / 1000),
        profile: {
          raw: `${stem}.raw.cpuprofile`,
          normalized: `${stem}.cpuprofile`,
          audit: normalized.audit
        }
      }
      save()
    }
    assert.deepEqual(record.pageErrors, [])
    record.ok = true
  } catch (error) {
    record.ok = false
    record.error = String(error).replaceAll(REPO, '[repo]').replaceAll(dir, '[data]')
    throw error
  } finally {
    await fixture?.evaluate(() => globalThis.__responsivenessStream?.stop()).catch(() => {})
    await cdp?.detach().catch(() => {})
    if (app) {
      await app.close()
      record.closed = true
    }
    rmSync(dir, { recursive: true, force: true })
    record.cleaned = true
    save()
  }
}
result.completedAt = new Date().toISOString()
result.summary = responsivenessSummary(result.runs)
save()
console.log(JSON.stringify(result.summary))
