import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { callMcp, REPO } from './harness.mjs'
import {
  seedRendererWorkload,
  chatSelector,
  frames,
  LONG_RESPONSE,
  streamChunk
} from './renderer-workload.mjs'
import {
  RESOURCE_CONFIG,
  validateResourceSeed
} from '../../scripts/performance/renderer-resource-data.mjs'

// Serialized through the existing server fixture. Observe the supported host
// stream while the unchanged seed injects its events; keep all receipts in
// Node/server memory, never in the renderer or adapter's historical API.
export async function captureResourceSeed(host, id, seed) {
  const events = []
  const off = host.subscribe(id, (packet) => {
    if (packet.kind === 'event' && ['user_message', 'assistant_text'].includes(packet.event.type))
      events.push(packet.event)
  })
  if (typeof off !== 'function') throw new Error('live seed subscription missing')
  try {
    await seed()
  } finally {
    off()
  }
  return { id, events, disposed: true }
}

export async function seedResourceWorkload(app, win, fixture, root) {
  const seedReceipts = []
  const observedFixture = {
    evaluate: async (seed, args) => {
      const receipt = await fixture.evaluate(
        `(args) => (${captureResourceSeed.toString()})(globalThis.__claveE2E.sessionHost, args.id, () => (${seed.toString()})(args))`,
        args
      )
      seedReceipts.push(receipt)
    }
  }
  // The original helper still waits for each last turn in the actual visible
  // native DOM, then queries the live session list before returning.
  const seeded = await seedRendererWorkload(app, win, observedFixture, root)
  return { ...seeded, seedReceipts }
}

export async function loadResourceScenario(app, win, fixture, root, bundlePath) {
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/renderer-resource-fixture.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadRendererResource } = await import(pathToFileURL(bundlePath).href)
  return loadRendererResource(
    () => seedResourceWorkload(app, win, fixture, root),
    async (workload) => {
      const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
      validateResourceSeed(workload, sessions)
    }
  )
}

// The fixed shallow grammar has one trailing source space on each paragraph
// line. CommonMark consumes that delimiter; this literal recipe declares the
// exact HTML, including every intervening newline. Actual output is never
// normalized. All native link components in this grammar are plain anchors.
export function resourceLiteral(cycle = 0) {
  assert.ok(Number.isInteger(cycle) && cycle >= 0 && cycle <= 5)
  const count = cycle ? 20 : 500
  const chunks = Array.from({ length: count }, (_, n) => streamChunk(cycle * 1000 + n))
  const label = cycle ? `Resource cycle ${cycle}` : null
  const detail =
    '<strong>Details.</strong> Deterministic text with <a href="https://example.com">reference</a>. '
  const block = '<h2>Synthetic response</h2>\n<p>' + detail.repeat(40).slice(0, -1) + '</p>'
  const html =
    Array(12).fill(block).join('\n') +
    '\n' +
    (label ? '<p>' + label + '</p>\n' : '') +
    '<p>' +
    chunks.join('').slice(0, -1) +
    '</p>'
  return { input: LONG_RESPONSE + (label ? label + '\n\n' : ''), chunks, html, count }
}

export async function assertPopulation(win, records, groups, originalLongIds, closed = false) {
  const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
  assert.equal(sessions.length, 100)
  assert.equal(new Set(records).size, 100)
  assert.ok(records.every((id) => sessions.some((s) => s.id === id && s.adapterId === 'echo')))
  assert.deepEqual(records.slice(0, 20), originalLongIds)
  return {
    liveIds: [...records],
    longIds: [...originalLongIds],
    groups: groups.length,
    longTurns: 200,
    slotTurns: closed ? 2 : null,
    finalReplacementWarmed: false
  }
}

async function armReceipt(win, id, kind, lastDelta, controller, token) {
  controller.own('passive-waiter/callback', token)
  const ack = await win.evaluate(
    ({ id, selector, lastDelta, token }) => {
      if (window.__rendererResourceWaiter) throw new Error('prior resource waiter still retained')
      let resolve
      const s = {
        token,
        timer: null,
        raf: null,
        off: null,
        promise: new Promise((done) => {
          resolve = done
        }),
        sampleCount: 0,
        receipts: 0
      }
      window.__rendererResourceWaiter = s
      s.off = window.electronAPI.onSessionStream(id, (packet) => {
        if (
          packet.kind !== 'event' ||
          packet.event.type !== 'assistant_text' ||
          packet.event.delta !== lastDelta
        )
          return
        if (++s.receipts !== 1) return
        const receivedAt = performance.now()
        s.timer = setTimeout(() => {
          s.timer = null
          s.raf = requestAnimationFrame(() => {
            s.raf = requestAnimationFrame(() => {
              s.raf = null
              const row = [
                ...document.querySelectorAll(selector + ' .chat-turn[data-role="assistant"]')
              ].at(-1)
              const sample = {
                html: row?.innerHTML,
                connected: !!row?.isConnected,
                sampleCount: ++s.sampleCount,
                receipts: s.receipts,
                receivedAt,
                sampledAt: performance.now(),
                frames: 2,
                working:
                  document
                    .querySelector(`.chat-host[data-session-id="${id}"] .chat-state`)
                    ?.getAttribute('data-state') === 'working'
              }
              resolve(sample)
            })
          })
        }, 200)
      })
      return { installed: typeof s.off === 'function', token }
    },
    { id, selector: chatSelector(id, kind), lastDelta, token }
  )
  assert.ok(ack.installed && ack.token === token)
}

async function takeReceipt(win, controller, token) {
  const sample = await controller.bounded(
    'first public receipt/sample',
    () => win.evaluate(() => window.__rendererResourceWaiter.promise),
    RESOURCE_CONFIG.mcpMs
  )
  const ack = await win.evaluate((token) => {
    const s = window.__rendererResourceWaiter
    if (!s || s.token !== token) throw new Error('unknown resource waiter')
    if (s.timer !== null || s.raf !== null || s.sampleCount !== 1 || s.receipts !== 1)
      throw new Error('sampling callbacks/receipts not quiescent')
    s.off()
    s.off = null
    clearTimeout(s.timer)
    cancelAnimationFrame(s.raf)
    s.promise = null
    delete window.__rendererResourceWaiter
    return { retired: !('__rendererResourceWaiter' in window) }
  }, token)
  controller.disposed(token, ack.retired)
  return sample
}

export async function warmResource({ win, fixture, records, cycle, controller }) {
  const id = records[99],
    expected = resourceLiteral(cycle),
    token = randomUUID()
  assert.equal(Buffer.byteLength(LONG_RESPONSE), 34380)
  assert.ok(expected.chunks.every((c) => Buffer.byteLength(c) === 128))
  await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
  await frames(win)
  const host = win.locator(`.chat-host[data-session-id="${id}"]`)
  const choose = async (kind) => {
    const wanted = kind === 'chat' ? 'View: Chat' : 'View: Terminal'
    if ((await host.getByLabel('Change view', { exact: true }).getAttribute('title')) !== wanted) {
      await host.getByLabel('Change view', { exact: true }).click()
      await win
        .getByRole('menuitem', { name: kind === 'chat' ? 'Chat' : 'Terminal', exact: true })
        .click()
      await win.getByRole('menu').waitFor({ state: 'hidden' })
    }
    await frames(win)
  }
  await choose('chat')
  await armReceipt(win, id, 'chat', expected.chunks.at(-1), controller, token)
  const producer = randomUUID()
  controller.own('producer/pending-injection', producer)
  const receipt = await controller.bounded(
    'finite producer',
    () =>
      fixture.evaluate(
        async ({ id, initial, start, count, producer }) => {
          if (globalThis.__rendererResourceProducer) throw new Error('prior producer retained')
          const inject = (event) => globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
          inject({ type: 'state_change', state: 'working' })
          inject({ type: 'assistant_text', delta: initial, final: false })
          const state = { token: producer, timer: null, n: 0, startedAt: Date.now() }
          globalThis.__rendererResourceProducer = state
          return new Promise((resolve, reject) => {
            const fail = (error) => {
              clearInterval(state.timer)
              delete globalThis.__rendererResourceProducer
              reject(error)
            }
            state.timer = setInterval(() => {
              try {
                const delta =
                  `chunk${String(start + state.n).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
                inject({ type: 'assistant_text', delta, final: false })
                if (++state.n === count) {
                  clearInterval(state.timer)
                  state.timer = null
                  delete globalThis.__rendererResourceProducer
                  resolve({
                    token: producer,
                    count: state.n,
                    startedAt: state.startedAt,
                    endedAt: Date.now(),
                    stopped: !('__rendererResourceProducer' in globalThis)
                  })
                }
              } catch (error) {
                fail(error)
              }
            }, 50)
          })
        },
        { id, initial: expected.input, start: cycle * 1000, count: expected.count, producer }
      ),
    RESOURCE_CONFIG.producerMs
  )
  assert.equal(receipt.count, expected.count)
  controller.disposed(producer, receipt.stopped)
  const first = await takeReceipt(win, controller, token)
  const check = (sample) => {
    assert.equal(sample.sampleCount, 1)
    if ('receipts' in sample) assert.equal(sample.receipts, 1)
    assert.equal(sample.frames, 2)
    assert.ok(sample.sampledAt - sample.receivedAt >= 200)
    assert.ok(sample.connected && sample.working)
    assert.equal(
      sample.html,
      expected.html,
      'first public native HTML equals independent complete literal'
    )
  }
  controller.firstDom(first, check)
  const samples = [first]
  for (const kind of ['terminal', 'chat']) {
    await choose(kind)
    // A view-selection barrier uses its completion timestamp, then the same
    // fixed 200 ms and two frames; it samples once without waiting for content.
    const sample = await win.evaluate(
      async (selector) => {
        const receivedAt = performance.now()
        await new Promise((done) => setTimeout(done, 200))
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        const row = [
          ...document.querySelectorAll(selector + ' .chat-turn[data-role="assistant"]')
        ].at(-1)
        return {
          html: row?.innerHTML,
          connected: !!row?.isConnected,
          working:
            row?.closest('.chat-host')?.querySelector('.chat-state')?.getAttribute('data-state') ===
            'working',
          receivedAt,
          sampledAt: performance.now(),
          frames: 2,
          sampleCount: 1
        }
      },
      chatSelector(id, kind)
    )
    controller.firstDom(sample, check)
    samples.push(sample)
  }
  return {
    complete: true,
    views: ['chat', 'terminal', 'chat'],
    chunks: expected.count,
    firstSamples: samples.length,
    sampleCount: 1,
    working: true,
    producerStopped: receipt.stopped,
    producer: receipt
  }
}

export async function replaceResource({ app, win, fixture, root, records, groups }) {
  const id = records[99]
  assert.deepEqual(await callMcp(app, 'closeSession', { sessionId: id }), { closed: id })
  await win.locator(`[data-sidebar-item-id="${id}"]`).waitFor({ state: 'detached' })
  await win.locator(`.chat-host[data-session-id="${id}"]`).waitFor({ state: 'detached' })
  assert.equal((await win.evaluate(() => window.electronAPI.sessionsList())).length, 99)
  const { sessionId } = await callMcp(app, 'openSession', {
    cwd: root,
    mode: 'claude',
    profile: 'dev-echo-adapter',
    account: 'default',
    name: 'Synthetic tab 99',
    groupId: groups[9]
  })
  assert.ok(sessionId !== id)
  records[99] = sessionId
  await win.locator(`[data-sidebar-item-id="${sessionId}"] > button`).click()
  await win.locator(chatSelector(sessionId) + ' textarea:not(:disabled)').waitFor()
  await fixture.evaluate((id) => {
    for (let n = 0; n < 2; n++)
      globalThis.__claveE2E.echo.inject(id, {
        kind: 'event',
        event: n
          ? {
              type: 'assistant_text',
              delta:
                'Tab 99 turn 1.\n\n' +
                '**Synthetic report.** A deterministic paragraph for renderer profiling. '.repeat(
                  8
                ) +
                '\n\n```ts\nconst measurement = 42\n```',
              final: true
            }
          : {
              type: 'user_message',
              text: 'Tab 99 turn 0.\n\n' + 'Describe a synthetic renderer workload. '.repeat(8)
            }
      })
    globalThis.__claveE2E.echo.inject(id, {
      kind: 'event',
      event: { type: 'state_change', state: 'done' }
    })
  }, sessionId)
  await win
    .locator(chatSelector(sessionId) + ' .chat-turn')
    .filter({ hasText: 'Tab 99 turn 1.' })
    .waitFor()
  return {
    closed: id,
    replacement: sessionId,
    turns: 2,
    warmed: false,
    archivePolicy: 'normal application close; no deletion or log truncation'
  }
}

export async function disposeResourceWork(win, fixture) {
  const renderer = await win.evaluate(() => {
    const s = window.__rendererResourceWaiter
    if (s) {
      s.off?.()
      clearTimeout(s.timer)
      cancelAnimationFrame(s.raf)
      s.promise = null
      delete window.__rendererResourceWaiter
    }
    return { absent: !('__rendererResourceWaiter' in window), found: !!s }
  })
  const producer = await fixture.evaluate(() => {
    const s = globalThis.__rendererResourceProducer
    if (s) {
      clearInterval(s.timer)
      delete globalThis.__rendererResourceProducer
    }
    return { absent: !('__rendererResourceProducer' in globalThis), found: !!s }
  })
  return { renderer, producer }
}
