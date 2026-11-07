import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openChat, inject } from './chat-view.spec.mjs'
import { callMcp, fixturePath, until } from './harness.mjs'
import { chatSelector, frames } from './renderer-workload.mjs'
import { checkFullLifecycle } from './markdown-full-lifecycle.mjs'

// First public receipt, fixed 200 ms, exactly two frames, one raw DOM sample.
// Expected content stays in Node. No SSR, parser hook or output-based polling.
async function arm(win, id, kind, delta) {
  await win.evaluate(
    ({ id, selector, delta }) => {
      const s = { done: false, sample: null, receipts: 0, timer: null, raf: null }
      window.__fullNativeSample = s
      s.off = window.electronAPI.onSessionStream(id, (packet) => {
        if (
          packet.kind !== 'event' ||
          packet.event.type !== 'assistant_text' ||
          packet.event.delta !== delta
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
              s.sample = {
                html: row?.innerHTML,
                text: row?.textContent,
                connected: !!row?.isConnected,
                receivedAt,
                sampledAt: performance.now(),
                animationFrames: 2,
                sampleCount: 1
              }
              s.done = true
            })
          })
        }, 200)
      })
    },
    { id, selector: chatSelector(id, kind), delta }
  )
}

export async function run(t) {
  const runId = randomUUID()
  const evidence = process.env.CLAVE_FULL_NATIVE_EVIDENCE_DIR || fixturePath('full-native-evidence')
  mkdirSync(evidence, { recursive: true })
  let sequence = 0
  const save = (label, data) =>
    writeFileSync(
      path.join(evidence, `${runId}-${++sequence}-${label}.json`),
      JSON.stringify(data, null, 2) + '\n',
      { flag: 'wx' }
    )
  for (const kind of ['chat', 'terminal']) {
    const chat = await openChat(
      'full-native-' + kind,
      ['--dev-echo-view=clave.chat-view/' + kind, '--test-no-machine-usage'],
      `[data-testid="${kind}-view"] textarea:not(:disabled)`,
      { SHELL: '/bin/zsh' }
    )
    const { app, win, fixture, record } = chat
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    win.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const selector = chatSelector(record.id, kind)
    const view = win.locator(selector)
    const row = () => view.locator('.chat-turn[data-role="assistant"]').last()
    const field = view.getByRole('textbox', { name: 'Message', exact: true })
    let closed = false
    try {
      assert.ok(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible())
        )
      )
      await field.fill('retained full-parser draft')
      await field.evaluate((el) => {
        el.focus()
        el.setSelectionRange(3, 9)
      })
      const sample = async (label, delta, expected, final = false, events = []) => {
        await arm(win, record.id, kind, delta)
        try {
          await inject(fixture, record.id, [...events, { type: 'assistant_text', delta, final }])
          await win.waitForFunction(() => window.__fullNativeSample.done)
          const data = await win.evaluate(() => ({
            ...window.__fullNativeSample.sample,
            receipts: window.__fullNativeSample.receipts
          }))
          save(kind + '-' + label, data)
          assert.equal(data.receipts, 1)
          assert.equal(data.sampleCount, 1)
          assert.equal(data.animationFrames, 2)
          assert.ok(data.sampledAt - data.receivedAt >= 200)
          assert.ok(data.connected)
          assert.equal(data.html, expected, 'complete first native HTML: ' + label)
          return data
        } finally {
          const disposed = await win.evaluate(() => {
            const s = window.__fullNativeSample
            s.off()
            clearTimeout(s.timer)
            cancelAnimationFrame(s.raf)
            delete window.__fullNativeSample
            return !('__fullNativeSample' in window)
          })
          assert.ok(disposed, 'owned first-sample listener/timer/frame/reference retired')
        }
      }
      let tail = 'Mutable'
      let defined = false
      const prefix = () =>
        `<h1>Native ${kind}</h1>\n<p>Earlier <a href="https://example.org/retained">retained</a> ${defined ? '<a href="https://example.org/late">late</a>' : '[late][x]'}.</p>\n<p>${tail}</p>`
      const input = `# Native ${kind}\n\nEarlier [retained](https://example.org/retained) [late][x].\n\nMutable`
      await sample('initial', input, prefix(), false, [{ type: 'state_change', state: 'working' }])
      await row().evaluate((el) => {
        window.__fullNativeLink = el.querySelector('a')
      })
      tail += ' warm-visible'
      await sample('append', ' warm-visible', prefix())
      assert.ok(
        await row().evaluate(
          (el) =>
            window.__fullNativeLink.isConnected && window.__fullNativeLink === el.querySelector('a')
        )
      )
      assert.equal(await field.inputValue(), 'retained full-parser draft')
      assert.deepEqual(await field.evaluate((el) => [el.selectionStart, el.selectionEnd]), [3, 9])
      const other = await callMcp(app, 'openSession', {
        cwd: fixturePath('full-native-' + kind) + '-root',
        mode: 'claude',
        profile: 'dev-echo-adapter',
        account: 'default',
        name: 'Full native hidden control'
      })
      await win.locator(`[data-sidebar-item-id="${other.sessionId}"] > button`).click()
      await frames(win)
      assert.equal(await view.evaluate((el) => el.getBoundingClientRect().height), 0)
      await win.evaluate((selector) => {
        window.__fullNativePaints = 0
        window.__fullNativeObserver = new MutationObserver((changes) => {
          window.__fullNativePaints += changes.length
        })
        window.__fullNativeObserver.observe(document.querySelector(selector + ' .chat-column'), {
          childList: true,
          subtree: true,
          characterData: true
        })
      }, selector)
      await sample('hidden-frozen', ' hidden-canonical-latest', prefix())
      assert.equal(await win.evaluate(() => window.__fullNativePaints), 0)
      await win.evaluate(() => {
        window.__fullNativeObserver.disconnect()
        delete window.__fullNativeObserver
      })
      tail += ' hidden-canonical-latest'
      await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
      await frames(win)
      const revealed = await row().innerHTML()
      save(kind + '-reveal-second-frame', { html: revealed })
      assert.equal(revealed, prefix(), 'reveal uses latest canonical content by second frame')
      defined = true
      await sample('late-definition', '\n\n[x]: https://example.org/late', prefix())
      const columns = Array.from({ length: 12 }, (_, n) => 'Column' + n)
      const cells = columns.map((_, n) => 'unbreakable-value-' + n)
      const table = `\n\n| ${columns.join(' | ')} |\n|${'---|'.repeat(12)}\n| ${cells.join(' | ')} |\n\nTable-tail`
      const tableHtml =
        '\n<div class="chat-table-scroll"><table><thead><tr>' +
        columns.map((c) => '<th>' + c + '</th>').join('') +
        '</tr></thead><tbody><tr>' +
        cells.map((c) => '<td>' + c + '</td>').join('') +
        '</tr></tbody></table></div>\n<p>Table-tail'
      await sample('table', table, prefix() + tableHtml + '</p>')
      await row().evaluate((el) => {
        const frame = el.querySelector('.chat-table-scroll')
        frame.scrollLeft = 80
        window.__fullNativeIdentity = {
          link: el.querySelector('a'),
          table: el.querySelector('table'),
          frame,
          left: frame.scrollLeft
        }
      })
      await sample(
        'table-append',
        ' preserved-full-append',
        prefix() + tableHtml + ' preserved-full-append</p>'
      )
      const identity = await row().evaluate((el) => {
        const old = window.__fullNativeIdentity
        return {
          link: old.link.isConnected && old.link === el.querySelector('a'),
          table: old.table.isConnected && old.table === el.querySelector('table'),
          frame: old.frame.isConnected && old.frame === el.querySelector('.chat-table-scroll'),
          before: old.left,
          after: old.frame.scrollLeft
        }
      })
      save(kind + '-identity', identity)
      assert.ok(
        identity.link &&
          identity.table &&
          identity.frame &&
          identity.before > 0 &&
          Math.abs(identity.before - identity.after) < 1
      )
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('shell:openExternal')
        ipcMain.handle('shell:openExternal', (_event, url) => {
          globalThis.__fullNativeExternal = url
        })
      })
      await row().getByRole('link', { name: 'retained', exact: true }).click()
      assert.ok(
        await until(() =>
          app.evaluate(() => globalThis.__fullNativeExternal === 'https://example.org/retained')
        )
      )
      await sample(
        'final',
        ' final-native',
        prefix() + tableHtml + ' preserved-full-append final-native</p>',
        true
      )
      await sample(
        'new-row',
        'https://example.org/one',
        '<p><a href="https://example.org/one">https://example.org/one</a></p>'
      )
      await sample(
        'url-reinterpretation',
        '/two',
        '<p><a href="https://example.org/one/two">https://example.org/one/two</a></p>'
      )
      await sample(
        'safe-unsafe-policy',
        ' [relative](/local) [unsafe](javascript:bad)',
        '<p><a href="https://example.org/one/two">https://example.org/one/two</a> <span>relative</span> <span>unsafe</span></p>'
      )
      await row().getByRole('link', { name: 'https://example.org/one/two', exact: true }).click()
      assert.ok(
        await until(() =>
          app.evaluate(() => globalThis.__fullNativeExternal === 'https://example.org/one/two')
        ),
        'grown link invokes the latest destination'
      )
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('shell:openExternal')
        ipcMain.handle('shell:openExternal', () => {
          throw new Error('owned live-link rejection')
        })
      })
      await row().getByRole('link', { name: 'https://example.org/one/two', exact: true }).click()
      await view.getByText('owned live-link rejection', { exact: false }).waitFor()
      // Queue an unfinished append then immediately close the real session.
      // Server-side instrumentation observes actual subscriptions, not just
      // whether the local callback variable was cleared.
      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: ' pending-close', final: false }
      ])
      assert.deepEqual(await callMcp(app, 'closeSession', { sessionId: record.id }), {
        closed: record.id
      })
      closed = true
      await win.locator(`.chat-host[data-session-id="${record.id}"]`).waitFor({ state: 'detached' })
      await win.waitForTimeout(200)
      const subscriptions = await fixture.evaluate(
        (id) => globalThis.__chatSubscriptions.filter((s) => s.id === id),
        record.id
      )
      save(kind + '-subscription-cleanup', subscriptions)
      assert.ok(subscriptions.some((s) => s.channel === 'sessions:subscribe'))
      assert.equal(
        subscriptions.filter((s) => s.channel === 'sessions:subscribe').length,
        subscriptions.filter((s) => s.channel === 'sessions:unsubscribe').length,
        'all actual host subscriptions released'
      )
      assert.equal(
        await win.locator(`.chat-host[data-session-id="${record.id}"]`).count(),
        0,
        'pending close cannot recreate a stale row'
      )
      assert.ok(
        !(await win.evaluate(() => window.electronAPI.sessionsList())).some(
          (s) => s.id === record.id
        )
      )
      t.check(
        `${kind} complete first samples, hidden freeze/reveal, connected Markdown, live URL handler and real close cleanup`,
        true
      )
    } finally {
      await win
        .evaluate(() => {
          window.__fullNativeSample?.off?.()
          clearTimeout(window.__fullNativeSample?.timer)
          cancelAnimationFrame(window.__fullNativeSample?.raf)
          window.__fullNativeObserver?.disconnect()
          delete window.__fullNativeSample
          delete window.__fullNativeObserver
          delete window.__fullNativeLink
          delete window.__fullNativeIdentity
        })
        .catch(() => {})
      if (!closed) await callMcp(app, 'closeSession', { sessionId: record.id }).catch(() => {})
      save(kind + '-errors-before-shutdown', errors)
      try {
        assert.deepEqual(errors, [], 'no renderer errors in current native functional gate')
      } finally {
        await chat.close()
      }
    }
  }
  await checkFullLifecycle(t, save)
}
