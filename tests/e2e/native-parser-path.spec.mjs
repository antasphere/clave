// Separate debugger diagnostic; no freshness/second-frame/latency collection.
// Reuses the actual native echo fixture and production renderer. Caller mode
// and namespace are preserved; the outer runner owns whole-run cleanup.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openChat, inject } from './chat-view.spec.mjs'
import { callMcp, fixturePath } from './harness.mjs'
import { chatSelector, frames } from './renderer-workload.mjs'
import { observeNativeParser } from './native-parser-checks.mjs'

export async function run(t) {
  for (const kind of ['chat', 'terminal']) {
    const suffix = 'native-parser-' + kind
    const chat = await openChat(
      suffix,
      [`--dev-echo-view=clave.chat-view/${kind}`],
      `[data-testid="${kind}-view"] textarea:not(:disabled)`
    )
    const { app, win, record, fixture } = chat
    let parser
    try {
      const selector = chatSelector(record.id, kind)
      const row = () => win.locator(selector + ' .chat-turn[data-role="assistant"]').last()
      assert.ok(
        await win.locator(selector).evaluate((el) => el.getBoundingClientRect().height > 0),
        'selected native view is visible within hidden app'
      )
      assert.ok(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => !w.isVisible())
        ),
        'diagnostic app remains physically hidden'
      )
      parser = await observeNativeParser(win)
      const observations = (phase) => parser.read().filter((e) => e.phase === phase)
      let input = `# Native ${kind}\n\nEarlier [retained](https://example.org/retained) [late][x].\n\nMutable`
      const compareComplete = async () => {
        const oracle = renderToStaticMarkup(
          createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, input)
        )
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
          { selector, oracle }
        )
        const urls = await row().evaluate((el) =>
          [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))
        )
        const expected = await win.evaluate(
          (oracle) =>
            [...new DOMParser().parseFromString(oracle, 'text/html').querySelectorAll('a')]
              .map((a) => a.getAttribute('href'))
              .filter((href) => /^(https?:|mailto:)/i.test(href ?? '')),
          oracle
        )
        assert.deepEqual(
          urls,
          expected,
          'complete native safe URLs equal the unchanged full pipeline'
        )
      }
      const append = async (phase, delta, final = false) => {
        parser.phase(phase)
        input += delta
        await inject(fixture, record.id, [{ type: 'assistant_text', delta, final }])
        await compareComplete()
        await frames(win)
        assert.ok(
          observations(phase).length > 0,
          'actual native parser instrumentation entered: ' + phase
        )
        assert.ok(
          observations(phase).every((e) => e.fullLength === input.length),
          'native boundary receives complete canonical input'
        )
      }
      parser.phase('initial')
      await inject(fixture, record.id, [
        { type: 'state_change', state: 'working' },
        { type: 'assistant_text', delta: input, final: false }
      ])
      await row().getByRole('link', { name: 'retained', exact: true }).waitFor()
      await compareComplete()
      await frames(win)
      assert.deepEqual(
        observations('initial').map((e) => [e.length, e.final]),
        [[input.length, false]],
        'cold native mount performs full parse with actual unfinished flag'
      )
      await row().evaluate((el) => {
        window.__nativeRetainedLink = el.querySelector('a')
      })
      await append('warm-append', ' warm-visible')
      assert.ok(
        observations('warm-append').every(
          (e) => e.baseKind === 'prefix' && e.length < e.fullLength && !e.final
        ),
        'warm selected native append actually reuses shorter tail'
      )
      assert.ok(
        await row().evaluate(
          (el) =>
            window.__nativeRetainedLink.isConnected &&
            window.__nativeRetainedLink === el.querySelector('a')
        ),
        'eligible append preserves connected link identity'
      )
      const other = await callMcp(app, 'openSession', {
        cwd: fixturePath(suffix) + '-root',
        mode: 'claude',
        profile: 'dev-echo-adapter',
        account: 'default',
        name: 'Hidden parser control'
      })
      await win.locator(`[data-sidebar-item-id="${other.sessionId}"] > button`).click()
      await win.locator(chatSelector(other.sessionId, kind) + ' textarea:not(:disabled)').waitFor()
      await frames(win)
      await win.evaluate((id) => {
        window.__nativeHiddenDeltas = []
        window.__nativeHiddenOff = window.electronAPI.onSessionStream(id, (value) => {
          if (value.kind === 'event' && value.event.type === 'assistant_text')
            window.__nativeHiddenDeltas.push(value.event.delta)
        })
        window.__nativeHiddenPaints = 0
        window.__nativeHiddenObserver = new MutationObserver((changes) => {
          window.__nativeHiddenPaints += changes.length
        })
        window.__nativeHiddenObserver.observe(
          document.querySelector(`.chat-host[data-session-id="${id}"] .chat-column`),
          { subtree: true, childList: true, characterData: true }
        )
      }, record.id)
      parser.phase('hidden')
      const beforeHidden = parser.read().length
      const hidden = ' hidden-canonical-latest'
      input += hidden
      await inject(fixture, record.id, [{ type: 'assistant_text', delta: hidden, final: false }])
      await win.waitForFunction((delta) => window.__nativeHiddenDeltas.includes(delta), hidden)
      await win.waitForTimeout(200)
      assert.equal(
        parser.read().length,
        beforeHidden,
        'delivered hidden stream enters no native parser'
      )
      assert.equal(
        await win.evaluate(() => window.__nativeHiddenPaints),
        0,
        'delivered hidden stream paints no hidden glyphs'
      )
      await win.evaluate(() => {
        window.__nativeHiddenObserver.disconnect()
        window.__nativeHiddenOff()
      })
      parser.phase('reveal')
      await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
      await row().getByText('hidden-canonical-latest', { exact: false }).waitFor()
      await frames(win)
      assert.ok(
        observations('reveal').length > 0,
        'revealing latest canonical input enters actual parser'
      )
      await compareComplete()
      await append('reveal-warm-append', ' reveal-warm')
      assert.ok(
        observations('reveal-warm-append').every(
          (e) => e.baseKind === 'prefix' && e.length < e.fullLength && !e.final
        ),
        'explicit post-reveal warm state reuses tail'
      )
      await append('global-invalidation', '\n\n[x]: https://example.org/late')
      assert.deepEqual(
        observations('global-invalidation').map((e) => e.length < e.fullLength),
        [true, false],
        'actual late global definition forces tail then full'
      )
      assert.equal(
        await row().getByRole('link', { name: 'late', exact: true }).getAttribute('href'),
        'https://example.org/late'
      )
      const table = `\n\n| ${Array.from({ length: 12 }, (_, n) => 'Column' + n).join(' | ')} |\n|${'---|'.repeat(12)}\n| ${Array.from({ length: 12 }, (_, n) => 'unbreakable-value-' + n).join(' | ')} |\n\nTable-tail`
      await append('unsupported-table', table)
      assert.ok(
        observations('unsupported-table').every(
          (e) => e.baseKind === 'full' && e.length === e.fullLength
        ),
        'known unsupported lineage skips failed-tail speculation'
      )
      await row().locator('table').waitFor()
      await row().evaluate((el) => {
        const frame = el.querySelector('.chat-table-scroll')
        frame.scrollLeft = 80
        window.__nativeTableIdentity = {
          link: el.querySelector('a'),
          table: el.querySelector('table'),
          frame,
          left: frame.scrollLeft
        }
      })
      await append('full-append', ' preserved-full-append')
      const identity = await row().evaluate((el) => {
        const previous = window.__nativeTableIdentity,
          frame = el.querySelector('.chat-table-scroll')
        return {
          link: previous.link.isConnected && previous.link === el.querySelector('a'),
          table: previous.table.isConnected && previous.table === el.querySelector('table'),
          frame: previous.frame.isConnected && previous.frame === frame,
          before: previous.left,
          after: frame.scrollLeft
        }
      })
      assert.ok(
        identity.link &&
          identity.table &&
          identity.frame &&
          identity.before > 0 &&
          Math.abs(identity.before - identity.after) < 1,
        'reuse-to-full native renderer preserves existing link/table/frame and nonzero table scroll'
      )
      await append('final', ' final-native', true)
      assert.ok(
        observations('final').every((e) => e.final && e.length === e.fullLength),
        'actual final flag forces full native render'
      )
      parser.phase('replacement')
      input = 'https://example.org/one'
      await inject(fixture, record.id, [{ type: 'assistant_text', delta: input, final: false }])
      await row().getByRole('link', { name: 'https://example.org/one', exact: true }).waitFor()
      assert.ok(
        observations('replacement').every((e) => e.baseKind === null && e.length === e.fullLength),
        'new row replacement is a cold full parse'
      )
      await append('url-reinterpretation', '/two')
      assert.equal(
        await row()
          .getByRole('link', { name: 'https://example.org/one/two', exact: true })
          .getAttribute('href'),
        'https://example.org/one/two'
      )
      await append('unsafe-policy', ' [relative](/local) [unsafe](javascript:bad)')
      assert.equal(
        await row().getByRole('link', { name: 'unsafe', exact: true }).count(),
        0,
        'unsafe URL retains original span policy'
      )
      await append('url-tail', '\n\nURL-tail')
      await append('url-final', ' complete', true)
      const trace = parser.read()
      assert.ok(trace.length > 0)
      await parser.detach()
      parser = undefined
      console.log(
        JSON.stringify({
          diagnostic: 'actual-native-parser-path',
          kind,
          identity,
          entries: trace,
          noTimingClaim: true
        })
      )
      t.check(
        `${kind} actual native warm parser reuse, full invalidation, final flags and hidden freeze`,
        true
      )
      t.check(
        `${kind} connected native links/tables/scroll survive full fallback with original URL semantics`,
        true
      )
    } catch (error) {
      let entries
      try {
        entries = parser?.read()
      } catch (observationError) {
        entries = { error: observationError.message }
      }
      console.error(
        JSON.stringify({
          diagnostic: 'actual-native-parser-failure',
          kind,
          error: error.message,
          entries
        })
      )
      throw error
    } finally {
      try {
        await parser?.detach()
      } finally {
        try {
          await win
            .evaluate(() => {
              window.__nativeHiddenOff?.()
              window.__nativeHiddenObserver?.disconnect()
              delete window.__nativeRetainedLink
              delete window.__nativeTableIdentity
            })
            .catch(() => {})
        } finally {
          await chat.close()
        }
      }
    }
  }
}
