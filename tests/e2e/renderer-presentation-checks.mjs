import assert from 'node:assert/strict'
import { inject } from './chat-view.spec.mjs'
import { chatSelector, frames } from './renderer-workload.mjs'

const RICH_TEXT =
  'Presentation guard [retained reference](https://example.com/retained).\n\n' +
  `| ${Array.from({ length: 12 }, (_, i) => `Column${i}`).join(' | ')} |\n` +
  `|${'---|'.repeat(12)}\n` +
  `| ${Array.from({ length: 12 }, (_, i) => `unbreakable-value-${i}`).join(' | ')} |\n\nTail `

async function nextTextPaint(win, selector) {
  return win.evaluate(
    (selector) =>
      new Promise((resolve, reject) => {
        const scroll = document.querySelector(selector + ' .chat-scroll')
        const text = () =>
          [...scroll.querySelectorAll('.chat-turn[data-role="assistant"]')].at(-1)?.textContent
        const previous = text()
        const observer = new MutationObserver(() => {
          if (text() === previous) return
          observer.disconnect()
          clearTimeout(timeout)
          resolve(performance.now())
        })
        const timeout = setTimeout(() => {
          observer.disconnect()
          reject(new Error('the active stream must produce a visible text paint'))
        }, 2500)
        observer.observe(scroll, { childList: true, subtree: true, characterData: true })
      }),
    selector
  )
}

async function stream(win, fixture, id, action) {
  const selector = chatSelector(id)
  await inject(fixture, id, [
    { type: 'state_change', state: 'working' },
    { type: 'user_message', text: 'Presentation regression stream' },
    { type: 'assistant_text', delta: RICH_TEXT, final: false }
  ])
  await win
    .locator(selector)
    .getByRole('link', { name: 'retained reference', exact: true })
    .last()
    .waitFor()
  await win.locator(selector + ' .chat-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })
  await win.waitForFunction(
    (id) =>
      document
        .querySelector(`.chat-host[data-session-id="${id}"] .chat-state`)
        ?.getAttribute('data-state') === 'working',
    id
  )
  await win.evaluate((id) => {
    window.__presentationChecks = { delivered: [] }
    window.__presentationChecks.off = window.electronAPI.onSessionStream(id, (value) => {
      if (
        value.kind === 'event' &&
        value.event.type === 'assistant_text' &&
        /^guard\d{6}/.test(value.event.delta)
      )
        window.__presentationChecks.delivered.push(value.event.delta.slice(0, 11))
    })
  }, id)
  await fixture.evaluate((id) => {
    const state = { n: 0 }
    state.timer = setInterval(
      () =>
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: {
            type: 'assistant_text',
            delta: `guard${String(state.n++).padStart(6, '0')} `,
            final: false
          }
        }),
      50
    )
    globalThis.__presentationChecks = state
  }, id)
  try {
    await nextTextPaint(win, selector)
    await action(selector)
  } finally {
    await fixture
      .evaluate(() => clearInterval(globalThis.__presentationChecks?.timer))
      .catch(() => {})
    await win
      .evaluate(() => {
        window.__presentationChecks?.off?.()
        window.__presentationChecks?.controlObserver?.disconnect()
        window.__presentationChecks?.controlOff?.()
        if (window.__presentationChecks?.clickListener)
          document.removeEventListener('click', window.__presentationChecks.clickListener, true)
      })
      .catch(() => {})
    await inject(fixture, id, [
      { type: 'assistant_text', delta: ' End guard.', final: true },
      { type: 'state_change', state: 'done' }
    ])
  }
}

export async function checkImmediateReveal({ win, fixture, id, other, t }) {
  await stream(win, fixture, id, async (selector) => {
    const samples = []
    for (let i = 0; i < 25 && samples.filter((s) => s.quick).length < 10; i++) {
      const paintedAt = await nextTextPaint(win, selector)
      await win.evaluate((other) => {
        window.__presentationChecks.hiddenAt = performance.now()
        window.__presentationChecks.beforeHide = window.__presentationChecks.delivered.at(-1)
        document.querySelector(`[data-sidebar-item-id="${other}"] > button`).click()
      }, other)
      await frames(win)
      const hidden = await win.evaluate(
        (selector) => ({
          height: document.querySelector(selector + ' .chat-scroll').clientHeight,
          state: document
            .querySelector(selector)
            ?.closest('.chat-host')
            ?.querySelector('.chat-state')
            ?.getAttribute('data-state')
        }),
        selector
      )
      assert.equal(hidden.height, 0, 'the quick-reveal subject really becomes hidden')
      assert.equal(hidden.state, 'working', 'quick reveals exercise an unfinished working answer')
      await win.waitForTimeout(20)
      await win.waitForFunction(
        () =>
          window.__presentationChecks.delivered.at(-1) !== window.__presentationChecks.beforeHide
      )
      await win.evaluate(
        ({ id, selector, paintedAt }) => {
          const state = window.__presentationChecks
          state.reveal = null
          const listener = (event) => {
            if (!event.target.closest(`[data-sidebar-item-id="${id}"] > button`)) return
            document.removeEventListener('click', listener, true)
            const marker = state.delivered.at(-1)
            const hiddenMs = performance.now() - state.hiddenAt
            const paintToClickMs = performance.now() - paintedAt
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const row = [
                  ...document.querySelectorAll(selector + ' .chat-turn[data-role="assistant"]')
                ].at(-1)
                state.reveal = {
                  marker,
                  hiddenMs,
                  paintToClickMs,
                  paintToSecondFrameMs: performance.now() - paintedAt,
                  present: !!marker && !!row?.textContent.includes(marker)
                }
              })
            )
          }
          state.clickListener = listener
          document.addEventListener('click', listener, true)
          document.querySelector(`[data-sidebar-item-id="${id}"] > button`).click()
        },
        { id, selector, paintedAt }
      )
      // Wait only for the immutable observation made at the second frame,
      // never for the missing text to appear on a later timer tick.
      await win.waitForFunction(() => window.__presentationChecks.reveal !== null)
      const sample = await win.evaluate(() => window.__presentationChecks.reveal)
      samples.push({
        ...sample,
        hidden,
        quick: sample.hiddenMs < 110 && sample.paintToClickMs < 120
      })
    }
    console.log(JSON.stringify({ metric: 'quick-reveal-second-frame', samples }))
    assert.ok(
      samples.filter((s) => s.quick && s.marker).length === 10,
      'obtain ten quick reveals while the text deadline is still pending; retain slower setup attempts'
    )
    assert.ok(
      samples.every((s) => s.present),
      'quick reveal paints the latest delivered text by its second frame'
    )
    t.check('a quick streaming reveal bypasses the text deadline by the second frame', true)
  })
}

export async function checkImmediateRows({ win, fixture, id, t }) {
  await stream(win, fixture, id, async (selector) => {
    const samples = []
    for (const kind of ['permission_request', 'user_message']) {
      for (
        let i = 0;
        i < 12 && samples.filter((s) => s.kind === kind && s.aligned).length < 3;
        i++
      ) {
        await inject(fixture, id, [{ type: 'state_change', state: 'working' }])
        const marker = `Immediate ${kind} ${i}`
        await win.evaluate(
          ({ id, selector, kind, marker }) => {
            const state = window.__presentationChecks
            state.control = { kind, arrived: null, painted: null }
            state.controlOff = window.electronAPI.onSessionStream(id, (value) => {
              if (
                value.kind === 'event' &&
                value.event.type === kind &&
                (value.event.description === marker || value.event.text === marker)
              )
                state.control.arrived = performance.now()
            })
            const scroll = document.querySelector(selector + ' .chat-scroll')
            state.controlObserver = new MutationObserver(() => {
              if (!scroll.textContent.includes(marker)) return
              state.control.painted = performance.now()
              state.controlObserver.disconnect()
              state.controlOff()
            })
            state.controlObserver.observe(scroll, {
              childList: true,
              subtree: true,
              characterData: true
            })
          },
          { id, selector, kind, marker }
        )
        const paintedAt = await nextTextPaint(win, selector)
        const stateBeforeRow = await win
          .locator(`.chat-host[data-session-id="${id}"] .chat-state`)
          .getAttribute('data-state')
        assert.equal(
          stateBeforeRow,
          'working',
          'row immediacy exercises an active unfinished-text deadline'
        )
        await win.waitForTimeout(20)
        const event =
          kind === 'permission_request'
            ? {
                type: kind,
                id: `immediate-${i}`,
                toolName: marker,
                description: marker,
                options: [
                  { id: 'allow', label: 'Allow once' },
                  { id: 'deny', label: 'Deny' }
                ]
              }
            : { type: kind, text: marker }
        await inject(fixture, id, [event])
        await win.waitForFunction(() => window.__presentationChecks.control.painted !== null)
        const sample = await win.evaluate(() => window.__presentationChecks.control)
        samples.push({
          ...sample,
          stateBeforeRow,
          afterTextPaintMs: sample.arrived - paintedAt,
          aligned: sample.arrived >= paintedAt && sample.arrived - paintedAt < 75,
          latencyMs: sample.painted - sample.arrived
        })
        if (kind === 'permission_request') {
          await win
            .locator(selector + ' .chat-prompt')
            .getByRole('button', { name: 'Allow once', exact: true })
            .waitFor()
          await win.waitForFunction(
            (id) =>
              document
                .querySelector(`.chat-host[data-session-id="${id}"] .chat-state`)
                ?.getAttribute('data-state') === 'blocked',
            id
          )
          await win
            .locator(selector + ' .chat-prompt')
            .getByRole('button', { name: 'Allow once', exact: true })
            .click()
          await win.locator(selector + ' .chat-prompt').waitFor({ state: 'hidden' })
        }
      }
    }
    console.log(JSON.stringify({ metric: 'active-stream-transcript-immediacy', samples }))
    assert.ok(
      ['permission_request', 'user_message'].every(
        (kind) =>
          samples.filter((s) => s.kind === kind && s.aligned && Number.isFinite(s.arrived))
            .length === 3
      ),
      'obtain three aligned live-stream row injections of each kind; retain slower setup attempts'
    )
    assert.ok(
      samples.every((s) => s.latencyMs >= 0 && s.latencyMs < 75),
      'control and non-assistant transcript rows bypass the active text deadline'
    )
    t.check('permission and non-assistant transcript rows bypass an active stream deadline', true)
  })
}

export async function checkMarkdownIdentity({ win, fixture, id, choose, t }) {
  for (const kind of ['chat', 'terminal']) {
    await choose(kind)
    const selector = chatSelector(id, kind)
    await inject(fixture, id, [
      { type: 'state_change', state: 'working' },
      { type: 'user_message', text: `Visible ${kind} identity` },
      { type: 'assistant_text', delta: RICH_TEXT, final: false }
    ])
    const row = win.locator(selector + ' .chat-turn[data-role="assistant"]').last()
    await row.getByRole('link', { name: 'retained reference', exact: true }).waitFor()
    await row.locator('table').waitFor()
    await row.evaluate((el) => {
      const frame = el.querySelector('.chat-table-scroll')
      frame.scrollLeft = 80
      window.__markdownIdentity = {
        link: el.querySelector('a'),
        table: el.querySelector('table'),
        frame,
        left: frame.scrollLeft
      }
    })
    for (let n = 0; n < 6; n++) {
      await inject(fixture, id, [
        { type: 'assistant_text', delta: `visible-${kind}-${n} `, final: false }
      ])
      await win.waitForTimeout(60)
    }
    await row.getByText(`visible-${kind}-5`, { exact: false }).first().waitFor()
    const retained = await row.evaluate((el) => {
      const old = window.__markdownIdentity
      return {
        selected: el.closest('[data-testid]').getBoundingClientRect().height > 0,
        link: old.link.isConnected && old.link === el.querySelector('a'),
        table: old.table.isConnected && old.table === el.querySelector('table'),
        frame: old.frame.isConnected && old.frame === el.querySelector('.chat-table-scroll'),
        before: old.left,
        after: el.querySelector('.chat-table-scroll').scrollLeft
      }
    })
    console.log(JSON.stringify({ metric: 'visible-markdown-identity', kind, ...retained }))
    assert.ok(
      retained.selected && retained.link && retained.table && retained.frame,
      `${kind} preserves existing link, table and scroll-frame DOM during a visible append`
    )
    assert.ok(
      retained.before > 0 && Math.abs(retained.before - retained.after) < 1,
      `${kind} retains the table reader's horizontal scroll position`
    )
    await inject(fixture, id, [{ type: 'assistant_text', delta: ' Complete.', final: true }])
    await inject(fixture, id, [
      { type: 'assistant_text', delta: 'https://example.com/one', final: false }
    ])
    await win
      .locator(selector)
      .getByRole('link', { name: 'https://example.com/one', exact: true })
      .last()
      .waitFor()
    await inject(fixture, id, [{ type: 'assistant_text', delta: '/two', final: true }])
    const changed = win
      .locator(selector)
      .getByRole('link', { name: 'https://example.com/one/two', exact: true })
      .last()
    await changed.waitFor()
    assert.equal(await changed.getAttribute('href'), 'https://example.com/one/two')
    t.check(
      `${kind} retains link/table identity and table scroll while live links still update`,
      true
    )
    await inject(fixture, id, [{ type: 'state_change', state: 'done' }])
  }
}
