// Resource-only extension. No product observer or formal workload mutation.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { callMcp, REPO } from './harness.mjs'
import { LONG_RESPONSE, streamChunk, chatSelector, frames } from './renderer-workload.mjs'
import { observeNativeParser } from './native-parser-checks.mjs'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function chooseResourceView(win, id, kind) {
  const host = win.locator(`.chat-host[data-session-id="${id}"]`)
  const picker = host.getByRole('button', { name: 'Change view', exact: true })
  if ((await picker.getAttribute('title')) !== `View: ${kind === 'chat' ? 'Chat' : 'Terminal'}`) {
    await picker.click()
    const menu = win.locator('[role="menu"][aria-label="Views"]')
    await menu
      .getByRole('menuitem', { name: kind === 'chat' ? 'Chat' : 'Terminal', exact: true })
      .click()
    await menu.waitFor({ state: 'detached' })
  }
  await win.locator(chatSelector(id, kind) + ' textarea:not(:disabled)').waitFor()
  await frames(win)
}
async function fullParserProbe(win) {
  const assets = path.join(REPO, 'out/renderer/assets'),
    names = readdirSync(assets).filter(
      (n) =>
        n.endsWith('.js') &&
        readFileSync(path.join(assets, n), 'utf8').includes('function remarkParse(')
    )
  assert.equal(names.length, 1, 'one actual installed original parser bundle')
  const name = names[0],
    source = readFileSync(path.join(assets, name), 'utf8')
  assert.ok(!source.includes('function createMarkdownAttempt('), 'R2 full renderer source')
  const start = source.indexOf('function remarkParse('),
    offset = source.indexOf('    return fromMarkdown(', start)
  assert.ok(offset > start)
  const cdp = await win.context().newCDPSession(win),
    entries = []
  let failure
  const paused = async (e) => {
    try {
      const r = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: e.callFrames[0].callFrameId,
        expression: '({length:arguments[0].length,fullLength:String(arguments[1].value).length})',
        returnByValue: true
      })
      assert.equal(r.exceptionDetails, undefined)
      entries.push(r.result.value)
    } catch (error) {
      failure = error
    } finally {
      await cdp.send('Debugger.resume').catch(() => {})
    }
  }
  let breakpointId
  try {
    await cdp.send('Debugger.enable')
    const bp = await cdp.send('Debugger.setBreakpointByUrl', {
      urlRegex: name.replaceAll('.', '\\.') + '$',
      lineNumber: source.slice(0, offset).split('\n').length - 1
    })
    breakpointId = bp.breakpointId
    assert.ok(bp.locations.length > 0, 'original parser breakpoint bound')
    cdp.on('Debugger.paused', paused)
  } catch (error) {
    await cdp.detach()
    throw error
  }
  return {
    phase(value) {
      assert.equal(value, 'resource-warm')
    },
    read() {
      if (failure) throw failure
      return entries
    },
    async detach() {
      try {
        await cdp.send('Debugger.removeBreakpoint', { breakpointId })
        cdp.off('Debugger.paused', paused)
      } finally {
        await cdp.detach()
      }
      if (failure) throw failure
    }
  }
}
export async function warmResourceProbe({ win, fixture, id, chunks, cycle = 0, candidate }) {
  await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
  await chooseResourceView(win, id, 'chat')
  const initial = LONG_RESPONSE + (cycle ? `resource-only cycle ${cycle}\n\n` : '')
  const expected = initial + Array.from({ length: chunks }, (_, i) => streamChunk(i)).join('')
  const oracle = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, expected)
  )
  const diagnostic = candidate ? await observeNativeParser(win) : await fullParserProbe(win)
  let delivered, produced
  try {
    diagnostic.phase('resource-warm')
    await win.evaluate((id) => {
      window.__parserResourceSeen = []
      window.__parserResourceOff = window.electronAPI.onSessionStream(id, (value) => {
        if (value.kind === 'event' && value.event.type === 'assistant_text')
          window.__parserResourceSeen.push({ delta: value.event.delta, final: value.event.final })
      })
    }, id)
    await fixture.evaluate(
      ({ id, initial, chunks }) => {
        const state = { chunks: [], started: Date.now(), stopped: null, complete: false }
        state.stop = () => {
          clearInterval(state.timer)
          state.stopped ??= Date.now()
        }
        for (const event of [
          { type: 'state_change', state: 'working' },
          { type: 'assistant_text', delta: initial, final: false }
        ])
          globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
        state.timer = setInterval(() => {
          const text =
            `chunk${String(state.chunks.length).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
          globalThis.__claveE2E.echo.inject(id, {
            kind: 'event',
            event: { type: 'assistant_text', delta: text, final: false }
          })
          state.chunks.push(text)
          if (state.chunks.length === chunks) {
            state.complete = true
            state.stop()
          }
        }, 50)
        globalThis.__parserResourceProducer = state
      },
      { id, initial, chunks }
    )
    const deadline = Date.now() + 60000
    while (!(await fixture.evaluate(() => globalThis.__parserResourceProducer.complete))) {
      assert.ok(Date.now() < deadline, 'resource producer deadline')
      await delay(100)
    }
    produced = await fixture.evaluate(() => {
      const s = globalThis.__parserResourceProducer
      s.stop()
      const result = { chunks: s.chunks, elapsedMs: s.stopped - s.started }
      delete globalThis.__parserResourceProducer
      return result
    })
    await win.waitForFunction((n) => window.__parserResourceSeen.length === n, chunks + 1)
    delivered = await win.evaluate(() => {
      const result = window.__parserResourceSeen
      window.__parserResourceOff()
      delete window.__parserResourceSeen
      delete window.__parserResourceOff
      return result
    })
    assert.equal(
      delivered.map((v) => v.delta).join(''),
      expected,
      'exact canonical stream generated/delivered'
    )
    assert.ok(
      delivered.every((v) => v.final === false),
      'working unfinished stream'
    )
    assert.deepEqual(
      produced.chunks,
      Array.from({ length: chunks }, (_, i) => streamChunk(i))
    )
    for (const kind of ['chat', 'terminal', 'chat']) {
      await chooseResourceView(win, id, kind)
      await win.waitForFunction(
        ({ selector, oracle }) => {
          const row = [
            ...document.querySelectorAll(selector + ' .chat-turn[data-role="assistant"]')
          ].at(-1)
          return (
            row?.textContent ===
            new DOMParser().parseFromString(oracle, 'text/html').body.textContent
          )
        },
        { selector: chatSelector(id, kind), oracle }
      )
      await win.locator(chatSelector(id, kind) + ' [data-state="working"]').waitFor()
    }
    const entries = diagnostic.read()
    assert.ok(entries.length > 1, 'positive actual parser path')
    assert.ok(
      entries.every((e) => e.fullLength > 0 && e.length <= e.fullLength),
      'parser documents'
    )
    if (candidate)
      assert.ok(
        entries.some((e) => e.baseKind === 'prefix' && e.length < e.fullLength),
        'actual warm candidate tail entry'
      )
    else
      assert.ok(
        entries.every((e) => e.length === e.fullLength),
        'matching full R2 parser'
      )
    return {
      expected,
      canonicalBytes: Buffer.byteLength(expected),
      producedChunks: produced.chunks.length,
      elapsedMs: produced.elapsedMs,
      entries,
      views: ['chat', 'terminal', 'chat'],
      unfinished: true
    }
  } finally {
    // Producer and inspector must be gone before any GC/heap observation.
    await fixture
      .evaluate(() => {
        globalThis.__parserResourceProducer?.stop()
        delete globalThis.__parserResourceProducer
      })
      .catch(() => {})
    await win
      .evaluate(() => {
        window.__parserResourceOff?.()
        delete window.__parserResourceSeen
        delete window.__parserResourceOff
      })
      .catch(() => {})
    await diagnostic.detach()
  }
}
export async function replaceResourceSlot({
  app,
  win,
  fixture,
  root,
  workload,
  id,
  index = 99,
  cycle
}) {
  assert.ok(index >= 20, 'preserve all twenty long histories')
  await callMcp(app, 'closeSession', { sessionId: id })
  await win.locator(`[data-sidebar-item-id="${id}"]`).waitFor({ state: 'detached' })
  assert.equal((await win.evaluate(() => window.electronAPI.sessionsList())).length, 99)
  const record = await callMcp(app, 'openSession', {
    cwd: root,
    mode: 'claude',
    profile: 'dev-echo-adapter',
    groupId: workload.groups[Math.floor(index / 10)],
    name: `Synthetic tab ${index} resource ${cycle}`,
    account: 'default'
  })
  const next = record.sessionId
  await win.locator(`[data-sidebar-item-id="${next}"] > button`).click()
  await fixture.evaluate(
    ({ id, index }) => {
      for (const event of [
        {
          type: 'user_message',
          text: `Tab ${index} turn 0.\n\n` + 'Describe a synthetic renderer workload. '.repeat(8)
        },
        {
          type: 'assistant_text',
          delta:
            `Tab ${index} turn 1.\n\n` +
            '**Synthetic report.** A deterministic paragraph for renderer profiling. '.repeat(8) +
            '\n\n```ts\nconst measurement = 42\n```',
          final: true
        },
        { type: 'state_change', state: 'done' }
      ])
        globalThis.__claveE2E.echo.inject(id, { kind: 'event', event })
    },
    { id: next, index }
  )
  await win
    .locator(chatSelector(next) + ' .chat-turn')
    .filter({ hasText: `Tab ${index} turn 1.` })
    .waitFor()
  workload.records[index] = next
  assert.equal((await win.evaluate(() => window.electronAPI.sessionsList())).length, 100)
  return next
}
