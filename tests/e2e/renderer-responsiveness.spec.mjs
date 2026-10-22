import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, seedWorkspaces, fixturePath, until, callMcp } from './harness.mjs'
import { inject } from './chat-view.spec.mjs'
import {
  countPaneRenders,
  chatSelector,
  frames,
  LONG_RESPONSE,
  loadWorkloadScenario,
  seedRendererWorkload
} from './renderer-workload.mjs'
import {
  checkImmediateReveal,
  checkImmediateRows,
  checkMarkdownIdentity
} from './renderer-presentation-checks.mjs'

export async function run(t) {
  const dir = fixturePath('renderer-responsiveness')
  const root = path.join(dir, 'workspace')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [
      { id: 'synthetic', name: 'Synthetic', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'synthetic'
  })
  const { app, win, fixture } = await launchApp(dir, { args: ['--dev-echo-adapter'] })
  try {
    const receipt = await loadWorkloadScenario(
      () => seedRendererWorkload(app, win, fixture, root),
      path.join(dir, 'scenario.mjs')
    )
    console.log(JSON.stringify({ scenario: 'chat/renderer-responsiveness', runId: receipt.runId }))
    const { records } = receipt.values.workload
    const from = records.at(-1),
      to = records[1]
    const counters = await countPaneRenders(win, from, to)
    writeFileSync(path.join(dir, 'render-counters.json'), JSON.stringify(counters, null, 2))
    const unrelated = records.filter((id) => id !== from && id !== to)
    assert.equal(unrelated.length, 98)
    for (const component of ['RegisteredSessionView', 'ChatView', 'TerminalView']) {
      const calls = unrelated.reduce((sum, id) => sum + (counters[`${component}:${id}`] ?? 0), 0)
      assert.equal(calls, 0, `${component} must not render unrelated hidden panes on a switch`)
    }
    t.check('a tab switch renders its changed panes and no unrelated hidden pane', true)
    const id = records[0]
    const host = win.locator(`.chat-host[data-session-id="${id}"]`)
    const view = (kind) => win.locator(chatSelector(id, kind))
    await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
    const field = view('chat').getByRole('textbox', { name: 'Message', exact: true })
    await field.fill('retained responsiveness draft')
    await win.evaluate((id) => {
      window.__responsivenessChunks = []
      window.__responsivenessArrived = []
      window.__responsivenessStopObserver = window.electronAPI.onSessionStream(id, (value) => {
        if (
          value.kind === 'event' &&
          value.event.type === 'assistant_text' &&
          /^chunk\d{6} /.test(value.event.delta)
        ) {
          window.__responsivenessChunks.push(value.event.delta)
          window.__responsivenessArrived.push(performance.now())
        }
      })
    }, id)
    await inject(fixture, id, [
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: LONG_RESPONSE, final: false }
    ])
    await view('chat').getByText('Synthetic response', { exact: true }).first().waitFor()
    await fixture.evaluate((id) => {
      const state = { chunks: [], timer: null }
      state.timer = setInterval(() => {
        const text = `chunk${String(state.chunks.length).padStart(6, '0')} ` + 'a'.repeat(115) + ' '
        state.chunks.push(text)
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: { type: 'assistant_text', delta: text, final: false }
        })
      }, 50)
      globalThis.__responsivenessBehavior = state
    }, id)
    const scroller = view('chat').locator('.chat-scroll')
    const geometry = () =>
      scroller.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight
      }))
    assert.ok(
      await until(async () => {
        const g = await geometry()
        return g.height - g.top - g.client < 2
      })
    )
    const choose = async (kind) => {
      await host.getByLabel('Change view', { exact: true }).click()
      await win
        .getByRole('menuitem', { name: kind === 'chat' ? 'Chat' : 'Terminal', exact: true })
        .click()
      await win.getByRole('menu').waitFor({ state: 'hidden' })
      await view(kind).getByRole('textbox', { name: 'Message', exact: true }).waitFor()
      await frames(win)
    }
    const hideZeroBox = async (kind) => {
      await win.locator(`[data-sidebar-item-id="${records[1]}"] > button`).click()
      await frames(win)
      const scroll = view(kind).locator('.chat-scroll')
      assert.deepEqual(
        await scroll.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop })),
        { height: 0, top: 0 }
      )
      await scroll.dispatchEvent('scroll')
      await frames(win)
      await win.waitForTimeout(180)
    }
    for (const kind of ['chat', 'terminal']) {
      if (kind === 'terminal') await choose(kind)
      await hideZeroBox(kind)
      const marker = await fixture.evaluate(
        () => globalThis.__responsivenessBehavior.chunks.at(-1)?.match(/^chunk\d{6}/)[0]
      )
      assert.ok(marker)
      await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
      await frames(win)
      assert.ok(
        await until(() =>
          view(kind)
            .locator('.chat-scroll')
            .evaluate((el, marker) => {
              const box = el.getBoundingClientRect()
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
              let text
              while ((text = walker.nextNode())) {
                const start = text.textContent.indexOf(marker)
                if (start < 0) continue
                const range = document.createRange()
                range.setStart(text, start)
                range.setEnd(text, start + marker.length)
                const rect = range.getBoundingClientRect()
                if (rect.height > 0 && rect.bottom > box.top + 1 && rect.top < box.bottom - 1)
                  return true
              }
              return false
            }, marker)
        ),
        `${kind} reveals the latest painted stream tail before any test scroll`
      )
    }
    await choose('chat')
    t.check(
      'both native views paint a long streaming tail after hidden zero-box restoration without a test scroll',
      true
    )
    await win.evaluate((selector) => {
      window.__responsivenessAnchor = document.querySelector(
        `${selector} .chat-turn[data-role="assistant"] a`
      )
      if (!window.__responsivenessAnchor) throw new Error('fixture must contain a Markdown link')
    }, chatSelector(id))
    const box = await scroller.boundingBox()
    assert.ok(box && box.height > 0)
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.wheel(0, -700)
    await view('chat').getByRole('button', { name: 'Scroll to end', exact: true }).waitFor()
    const positions = [],
      freshness = []
    for (let i = 0; i < 6; i++) {
      await win.waitForTimeout(160)
      positions.push(await geometry())
      freshness.push(
        await win.evaluate((selector) => {
          const rows = [
            ...document
              .querySelector(selector)
              .querySelectorAll('.chat-turn[data-role="assistant"]')
          ]
          const markers = rows.at(-1)?.textContent.match(/chunk\d{6}/g) ?? []
          const painted = markers.length ? Number(markers.at(-1).slice(5)) + 1 : 0
          const oldest = window.__responsivenessArrived[painted]
          return {
            painted,
            delivered: window.__responsivenessArrived.length,
            pendingAgeMs: oldest === undefined ? 0 : performance.now() - oldest
          }
        }, chatSelector(id))
      )
    }
    assert.ok(
      positions.every((g) => g.height - g.top - g.client > 300),
      `native wheel reading intent survives continuous streaming: ${JSON.stringify(positions)}`
    )
    assert.ok(
      Math.abs(positions.at(-1).top - positions[0].top) < 5,
      'visible streaming preserves the reader offset'
    )
    assert.equal(await field.inputValue(), 'retained responsiveness draft')
    assert.ok(
      await win.evaluate(() => window.__responsivenessAnchor.isConnected),
      'appending assistant text retains existing Markdown link elements'
    )
    const savedTop = positions.at(-1).top
    assert.ok(savedTop > 0, 'the retained reading position is nonzero')
    await hideZeroBox('chat')
    await win.locator(`[data-sidebar-item-id="${id}"] > button`).click()
    await frames(win)
    assert.ok(
      await until(async () => Math.abs((await geometry()).top - savedTop) < 5),
      'reveal restores the native wheel reader offset without jumping to the end'
    )
    assert.equal(await field.inputValue(), 'retained responsiveness draft')
    console.log(JSON.stringify({ metric: 'visible-pending-snapshot-age', samples: freshness }))
    assert.ok(
      freshness.every((sample) => sample.pendingAgeMs <= 150),
      'visible unfinished text stays within its 150ms freshness target'
    )
    t.check(
      'native wheel scrolling retains reading position and draft while a visible long answer streams',
      true
    )
    const produced = await fixture.evaluate(() => {
      clearInterval(globalThis.__responsivenessBehavior.timer)
      return globalThis.__responsivenessBehavior.chunks
    })
    assert.ok(produced.length >= 10)
    await win.waitForFunction((n) => window.__responsivenessChunks.length >= n, produced.length)
    assert.deepEqual(
      await win.evaluate(() => window.__responsivenessChunks),
      produced,
      'ordered exactly-once transport'
    )
    await inject(fixture, id, [
      { type: 'assistant_text', delta: ' FINAL-FLUSH', final: true },
      { type: 'state_change', state: 'done' }
    ])
    const expected = produced.map((chunk) => chunk.match(/^chunk\d{6}/)[0])
    for (const kind of ['chat', 'terminal']) {
      if (kind === 'terminal') await choose(kind)
      const response = view(kind)
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'Synthetic response' })
      await view(kind)
        .locator('.chat-scroll')
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
      await response.filter({ hasText: 'FINAL-FLUSH' }).waitFor()
      assert.deepEqual(
        (await response.textContent()).match(/chunk\d{6}/g),
        expected,
        `${kind} paints every ordered delta and final text`
      )
      assert.equal(
        await view(kind).getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
        'retained responsiveness draft'
      )
    }
    t.check(
      'both native views retain every ordered chunk, final text and shared draft after reveal',
      true
    )
    await choose('chat')
    await inject(fixture, id, [
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: 'Pending control text ', final: false }
    ])
    await view('chat').getByText('Pending control text', { exact: true }).waitFor()
    await win.evaluate(
      ({ id, selector }) => {
        window.__responsivenessControl = { arrived: null, painted: null }
        window.__responsivenessControlOff = window.electronAPI.onSessionStream(id, (value) => {
          if (value.kind === 'event' && value.event.type === 'permission_request')
            window.__responsivenessControl.arrived = performance.now()
        })
        window.__responsivenessControlObserver = new MutationObserver(() => {
          if (window.__responsivenessControl.painted !== null) return
          if (
            [...document.querySelector(selector).querySelectorAll('button')].some((button) =>
              button.textContent.startsWith('Allow once')
            )
          )
            window.__responsivenessControl.painted = performance.now()
        })
        window.__responsivenessControlObserver.observe(document.querySelector(selector), {
          childList: true,
          subtree: true
        })
      },
      { id, selector: chatSelector(id) }
    )
    await inject(fixture, id, [
      { type: 'assistant_text', delta: 'latest control text ', final: false },
      {
        type: 'permission_request',
        id: 'responsiveness-permission',
        description: 'Allow responsiveness fixture?',
        toolName: 'Write',
        input: { file_path: '/tmp/synthetic-fixture.txt' },
        options: [
          { id: 'allow', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ]
      },
      { type: 'session_meta', model: 'responsiveness-model', providerSessionId: null }
    ])
    await view('chat').getByRole('button', { name: 'Allow once', exact: true }).waitFor()
    const control = await win.evaluate(() => window.__responsivenessControl)
    assert.equal(typeof control.arrived, 'number')
    assert.equal(typeof control.painted, 'number')
    console.log(
      JSON.stringify({ metric: 'permission-stream-to-dom', ms: control.painted - control.arrived })
    )
    assert.ok(
      control.painted - control.arrived < 75,
      `permission rendering bypasses the text deadline: ${JSON.stringify(control)}`
    )
    await view('chat')
      .getByText('Pending control text latest control text', { exact: true })
      .waitFor()
    assert.ok(
      await until(
        async () => (await host.locator('.chat-state').getAttribute('data-state')) === 'blocked'
      )
    )
    assert.equal(
      await host.locator('.pane-header-meta').getAttribute('title'),
      'responsiveness-model'
    )
    t.check(
      'a permission request and live model/state metadata bypass unfinished text scheduling',
      true
    )
    await inject(fixture, id, [
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: 'https://example.com/one', final: false }
    ])
    await view('chat').getByRole('link', { name: 'https://example.com/one', exact: true }).waitFor()
    await inject(fixture, id, [{ type: 'assistant_text', delta: '/two', final: true }])
    const changedLink = view('chat').getByRole('link', {
      name: 'https://example.com/one/two',
      exact: true
    })
    await changedLink.waitFor()
    assert.equal(await changedLink.getAttribute('href'), 'https://example.com/one/two')
    t.check('Markdown links update label and destination as an unfinished URL grows', true)
    await frames(win)
    // A fresh session prevents the earlier deliberately unanswered permission
    // from making this stream blocked, where unfinished text is not throttled.
    const { sessionId: guardId } = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      profile: 'dev-echo-adapter',
      account: 'default',
      name: 'Presentation contract regressions',
      groupId: receipt.values.workload.groups[0]
    })
    console.log(
      JSON.stringify({ scenario: 'chat/renderer-responsiveness', presentationSessionId: guardId })
    )
    await win.locator(`[data-sidebar-item-id="${guardId}"] > button`).click()
    await win
      .locator(chatSelector(guardId))
      .getByRole('textbox', { name: 'Message', exact: true })
      .waitFor()
    const chooseGuard = async (kind) => {
      await win
        .locator(`.chat-host[data-session-id="${guardId}"]`)
        .getByLabel('Change view', { exact: true })
        .click()
      await win
        .getByRole('menuitem', { name: kind === 'chat' ? 'Chat' : 'Terminal', exact: true })
        .click()
      await win.getByRole('menu').waitFor({ state: 'hidden' })
      await win
        .locator(chatSelector(guardId, kind))
        .getByRole('textbox', { name: 'Message', exact: true })
        .waitFor()
      await frames(win)
    }
    await checkImmediateReveal({ win, fixture, id: guardId, other: records[1], t })
    await checkImmediateRows({ win, fixture, id: guardId, t })
    await checkMarkdownIdentity({ win, fixture, id: guardId, choose: chooseGuard, t })
  } finally {
    await fixture
      .evaluate(() => clearInterval(globalThis.__responsivenessBehavior?.timer))
      .catch(() => {})
    await win.evaluate(() => window.__responsivenessStopObserver?.()).catch(() => {})
    await win
      .evaluate(() => {
        window.__responsivenessControlOff?.()
        window.__responsivenessControlObserver?.disconnect()
      })
      .catch(() => {})
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
