import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { callMcp, REPO } from './harness.mjs'

export const LONG_RESPONSE = (
  '## Synthetic response\n\n' +
  '**Details.** Deterministic text with [reference](https://example.com). '.repeat(40) +
  '\n\n'
).repeat(12)
export const streamChunk = (index) =>
  `chunk${String(index).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
export const chatSelector = (id, kind = 'chat') =>
  `.chat-host[data-session-id="${id}"] [data-testid="${kind}-view"]`
export const frames = (win) =>
  win.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )

export async function loadWorkloadScenario(create, bundlePath) {
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/renderer-responsiveness-fixture.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadRendererResponsiveness } = await import(pathToFileURL(bundlePath).href)
  return loadRendererResponsiveness(create)
}

export async function seedRendererWorkload(app, win, fixture, root) {
  const records = [],
    groups = []
  for (let g = 0; g < 10; g++)
    groups.push((await callMcp(app, 'createGroup', { name: `Synthetic group ${g}` })).groupId)
  for (let i = 0; i < 100; i++) {
    const { sessionId } = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      profile: 'dev-echo-adapter',
      groupId: groups[Math.floor(i / 10)],
      name: `Synthetic tab ${i}`,
      account: 'default'
    })
    records.push(sessionId)
    await win.locator(`[data-sidebar-item-id="${sessionId}"] > button`).click()
    await win.locator(`${chatSelector(sessionId)} textarea:not(:disabled)`).waitFor()
    const turns = i < 20 ? 200 : 2
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
      { id: sessionId, index: i, turns }
    )
    await win
      .locator(`${chatSelector(sessionId)} .chat-turn`)
      .filter({ hasText: `Tab ${i} turn ${turns - 1}.` })
      .waitFor()
  }
  const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
  assert.equal(sessions.length, 100)
  assert.ok(sessions.every((s) => s.adapterId === 'echo'))
  return { records, groups }
}

/** Count entered component functions, separately from every latency collection.
 * Breakpoint locations and observed incoming/outgoing panes are asserted, so
 * missing instrumentation cannot turn a render regression into a false pass. */
export async function countPaneRenders(win, from, to) {
  const assets = path.join(REPO, 'out/renderer/assets')
  const name = readdirSync(assets).find(
    (n) =>
      n.endsWith('.js') &&
      readFileSync(path.join(assets, n), 'utf8').includes('function RegisteredSessionView(')
  )
  assert.ok(name, 'the built renderer exposes the registered pane')
  const source = readFileSync(path.join(assets, name), 'utf8')
  const cdp = await win.context().newCDPSession(win)
  const counters = {},
    breakpoints = []
  let pauseError
  const paused = async (event) => {
    try {
      for (const id of event.hitBreakpoints ?? []) {
        const component = breakpoints.find(([bp]) => bp === id)?.[1]
        if (!component) continue
        const answer = await cdp.send('Debugger.evaluateOnCallFrame', {
          callFrameId: event.callFrames[0].callFrameId,
          expression: component === 'RegisteredSessionView' ? 'sessionId' : 'session.id',
          returnByValue: true
        })
        assert.equal(answer.exceptionDetails, undefined)
        assert.equal(typeof answer.result.value, 'string')
        const key = `${component}:${answer.result.value}`
        counters[key] = (counters[key] ?? 0) + 1
      }
    } catch (error) {
      pauseError = error
    } finally {
      await cdp.send('Debugger.resume').catch(() => {})
    }
  }
  try {
    await win.locator(`[data-sidebar-item-id="${from}"] > button`).click()
    await frames(win)
    await cdp.send('Debugger.enable')
    for (const component of ['RegisteredSessionView', 'ChatView', 'TerminalView']) {
      const start = source.indexOf(`function ${component}(`)
      assert.ok(start >= 0, `missing render function ${component}`)
      const body = source.indexOf('}) {', start) + 4
      const { breakpointId, locations } = await cdp.send('Debugger.setBreakpointByUrl', {
        urlRegex: name.replaceAll('.', '\\.') + '$',
        lineNumber: source.slice(0, body).split('\n').length - 1
      })
      assert.ok(locations.length > 0, `unbound breakpoint ${component}`)
      breakpoints.push([breakpointId, component])
    }
    cdp.on('Debugger.paused', paused)
    await win.locator(`[data-sidebar-item-id="${to}"] > button`).click()
    await frames(win)
    if (pauseError) throw pauseError
    for (const component of ['RegisteredSessionView', 'ChatView', 'TerminalView'])
      for (const id of [from, to])
        assert.ok(counters[`${component}:${id}`] > 0, `${component} observes changed pane ${id}`)
    return counters
  } finally {
    for (const [breakpointId] of breakpoints)
      await cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})
    cdp.off('Debugger.paused', paused)
    await cdp.detach()
  }
}
