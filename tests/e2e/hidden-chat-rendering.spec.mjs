import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openChat, inject } from './chat-view.spec.mjs'
import { callMcp, until, fixturePath, REPO, seedWorkspaces } from './harness.mjs'

export async function run(t) {
  const modulePath = fixturePath('hidden-streaming-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/hidden-chat-rendering-fixture.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadHiddenStreaming } = await import(pathToFileURL(modulePath).href)
  const receipt = await loadHiddenStreaming((runId) =>
    openChat(
      `hidden-streaming-${runId}`,
      [],
      '[data-testid="chat-view"] textarea:not(:disabled)',
      {},
      (dir) => {
        const state = JSON.parse(readFileSync(path.join(dir, 'workspace-state.json'), 'utf8'))
        const rootDir = path.join(state.workspaces[0].rootDir, 'alternate')
        mkdirSync(rootDir, { recursive: true })
        seedWorkspaces(dir, {
          workspaces: [
            ...state.workspaces,
            {
              id: `${runId}-workspace`,
              name: 'Hidden streaming alternate',
              rootDir,
              profileFile: null,
              createdAt: 1
            }
          ],
          activeWorkspaceId: 'chat',
          fresh: true
        })
      }
    )
  )
  const chat = receipt.values.chat
  const { app, win, record, fixture } = chat
  win.setDefaultTimeout(8_000)
  console.log(
    JSON.stringify({
      scenario: 'chat/hidden-streaming',
      runId: receipt.runId,
      sessionId: record.id
    })
  )
  const host = win.locator(`.chat-host[data-session-id="${record.id}"]`)
  const view = (kind) => host.locator(`[data-testid="${kind}-view"]`)
  const frames = () =>
    win.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
  const reveal = async (kind) => {
    await view(kind).getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    await frames()
  }
  const painted = (kind, text = '') =>
    view(kind)
      .locator('.chat-scroll')
      .evaluate((el, text) => {
        const box = el.getBoundingClientRect()
        return Array.from(el.querySelectorAll('.chat-turn')).some((row) => {
          const rect = row.getBoundingClientRect()
          return (
            rect.height > 0 &&
            rect.bottom > box.top + 1 &&
            rect.top < box.bottom - 1 &&
            row.textContent.includes(text)
          )
        })
      }, text)
  const choose = async (kind) => {
    await win.evaluate(
      ({ id, kind }) => window.electronAPI.sessionsSetView(id, `clave.chat-view/${kind}`),
      { id: record.id, kind }
    )
    // A host metadata change refreshes the baseline registry. Test setup uses
    // commands rather than relying on the picker's animation/focus handling.
    await callMcp(app, 'rename', {
      target: 'session',
      id: record.id,
      name: `Synthetic ${kind} ${Date.now()}`
    })
    await view(kind).getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    await frames()
  }
  const observe = async (kind) =>
    view(kind)
      .locator('.chat-column')
      .evaluate((el) => {
        globalThis.__hiddenMutations = 0
        globalThis.__hiddenMutationDetails = []
        globalThis.__hiddenObserver?.disconnect()
        globalThis.__hiddenObserver = new MutationObserver((changes) => {
          globalThis.__hiddenMutations += changes.length
          globalThis.__hiddenMutationDetails.push(
            ...changes.map((change) => ({
              type: change.type,
              target: change.target.parentElement?.className,
              text: change.target.textContent?.slice(0, 200),
              added: Array.from(change.addedNodes, (node) => node.textContent?.slice(0, 80)),
              removed: Array.from(change.removedNodes, (node) => node.textContent?.slice(0, 80))
            }))
          )
        })
        globalThis.__hiddenObserver.observe(el, {
          subtree: true,
          childList: true,
          characterData: true
        })
      })
  await win.evaluate((id) => {
    globalThis.__deliveryDeltas = []
    globalThis.__stopDelivery = window.electronAPI.onSessionStream(id, (value) => {
      if (value.kind === 'event' && value.event.type === 'assistant_text')
        globalThis.__deliveryDeltas.push(value.event.delta)
    })
  }, record.id)
  const delta = async (text) => {
    const before = await win.evaluate(() => globalThis.__deliveryDeltas.length)
    await inject(fixture, record.id, [{ type: 'assistant_text', delta: text, final: false }])
    assert.ok(
      await until(async () =>
        win.evaluate(
          ({ before, text }) => globalThis.__deliveryDeltas.slice(before).includes(text),
          { before, text }
        )
      ),
      'the observed hidden delta arrives before its presentation is checked'
    )
  }
  try {
    // Exercise a real write before the deterministic stream recording.
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'hidden fixture command'
        }),
      record.id
    )
    await view('chat').locator('.chat-turn[data-role="assistant"]').waitFor()
    await inject(
      fixture,
      record.id,
      Array.from({ length: 40 }, (_, n) => [
        { type: 'user_message', text: `Question ${n}. ` + 'Synthetic history. '.repeat(20) },
        {
          type: 'assistant_text',
          delta: `Answer ${n}. ` + 'Synthetic answer. '.repeat(20),
          final: true
        }
      ]).flat()
    )
    await inject(fixture, record.id, [
      { type: 'user_message', text: 'Streaming question' },
      { type: 'assistant_text', delta: 'START ', final: false }
    ])
    await view('chat').getByText('START', { exact: true }).waitFor()
    await choose('terminal')
    await view('terminal').getByText('START', { exact: true }).waitFor()
    await choose('chat')
    await win.waitForTimeout(150)
    await frames()
    await observe('terminal')
    await delta('selected-slot ')
    await view('chat').getByText('START selected-slot', { exact: true }).waitFor()
    await frames()
    assert.equal(
      await win.evaluate(() => globalThis.__hiddenMutations),
      0,
      'inactive native view must defer transcript presentation'
    )
    t.check('the inactive native view defers presentation while the visible view streams', true)

    // Keep the streaming row in the virtualised range: a scrolled-up reader
    // alone cannot expose wasted background rendering of the offscreen tail.
    await win.locator('.launcher-split .launcher-btn').click()
    assert.ok(
      await until(
        async () => (await win.evaluate(() => window.electronAPI.sessionsList())).length === 2
      )
    )
    const other = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.id !== record.id
    )
    assert.ok(other)
    assert.ok(await until(async () => !(await view('chat').isVisible())))
    await win.waitForTimeout(150)
    await observe('chat')
    const following = Array.from({ length: 10 }, (_, n) => `following-${n} `)
    for (const chunk of following) {
      await delta(chunk)
      await frames()
    }
    assert.equal(
      await win.evaluate(() => globalThis.__hiddenMutations),
      0,
      'a background tab following the end must defer transcript presentation'
    )
    await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
    await reveal('chat')
    assert.ok(
      await until(() => painted('chat', 'following-9')),
      'background reveal paints the latest text without a test scroll'
    )
    t.check('a background tab following the end defers rendering and catches up on reveal', true)

    const input = view('chat').getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('draft retained while hidden')
    const scroll = view('chat').locator('.chat-scroll')
    await scroll.evaluate((el) => {
      el.scrollTop = 240
    })
    await view('chat').getByRole('button', { name: 'Scroll to end', exact: true }).waitFor()
    await frames()
    const savedTop = await scroll.evaluate((el) => el.scrollTop)
    assert.ok(savedTop > 0, 'the reader has a nonzero offset to preserve')
    await win.locator(`[data-sidebar-item-id="${other.id}"] > button`).click()
    await win.waitForTimeout(150)
    await observe('chat')
    await win.evaluate((id) => {
      globalThis.__receivedHidden = []
      globalThis.__stopHidden = window.electronAPI.onSessionStream(id, (value) => {
        if (value.kind === 'event' && value.event.type === 'assistant_text')
          globalThis.__receivedHidden.push(value.event.delta)
      })
    }, record.id)
    const chunks = Array.from({ length: 20 }, (_, n) => `chunk-${n} `)
    for (const chunk of chunks) {
      await delta(chunk)
      await frames()
    }
    assert.ok(
      await until(
        async () => (await win.evaluate(() => globalThis.__receivedHidden.length)) === chunks.length
      )
    )
    assert.deepEqual(
      await win.evaluate(() => globalThis.__receivedHidden),
      chunks,
      'transport conserves every ordered delta'
    )
    assert.equal(
      await win.evaluate(() => globalThis.__hiddenMutations),
      0,
      'background tab must defer transcript presentation'
    )
    t.check('a background tab defers presentation without dropping or reordering deltas', true)

    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'hidden-permission',
        description: 'Allow Write?',
        toolName: 'Write',
        input: { file_path: '/tmp/fixture.txt' },
        options: [
          { id: 'allow', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ]
      },
      { type: 'state_change', state: 'blocked' },
      { type: 'session_meta', model: 'fixture-hidden-model', providerSessionId: null }
    ])
    assert.ok(
      await until(
        async () => (await host.locator('.chat-state').getAttribute('data-state')) === 'blocked'
      ),
      'hidden metadata remains live'
    )
    assert.ok(
      await until(
        async () =>
          (await host.locator('.pane-header-meta').getAttribute('title')) === 'fixture-hidden-model'
      ),
      'hidden model metadata remains live'
    )
    assert.ok(
      await until(
        async () =>
          (await win
            .locator(`[data-sidebar-item-id="${record.id}"] .tab-status`)
            .getAttribute('data-status')) === 'needs-you'
      ),
      'the hidden session still notifies the sidebar that it needs the reader'
    )
    await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
    await view('chat').locator('.chat-prompt[data-kind="permission"]').waitFor()
    assert.equal(await input.inputValue(), 'draft retained while hidden')
    assert.ok(
      await until(
        async () => Math.abs((await scroll.evaluate((el) => el.scrollTop)) - savedTop) < 2
      ),
      `returning preserves the reader's offset ${savedTop}, got ${await scroll.evaluate((el) => el.scrollTop)}`
    )
    assert.ok(await until(() => painted('chat')), 'returning paints rows at the retained offset')
    await view('chat').getByRole('button', { name: 'Scroll to end', exact: true }).click()
    const expected = 'START selected-slot ' + following.join('') + chunks.join('')
    assert.ok(
      await until(async () =>
        (
          await view('chat').locator('.chat-turn[data-role="assistant"]').allTextContents()
        ).includes(expected.trim())
      ),
      'chat reveals the complete accumulated answer'
    )
    await choose('terminal')
    assert.ok(
      await until(async () =>
        (
          await view('terminal').locator('.chat-turn[data-role="assistant"]').allTextContents()
        ).includes(expected.trim())
      ),
      'terminal reveals the same complete accumulated answer'
    )
    await view('terminal').locator('.chat-prompt[data-kind="permission"]').waitFor()
    await win.locator(`[data-sidebar-item-id="${other.id}"] > button`).click()
    await inject(fixture, record.id, [
      { type: 'state_change', state: 'working' },
      {
        type: 'permission_request',
        id: 'hidden-question',
        description: 'Question',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          { question: 'Continue the fixture?', options: [{ label: 'Yes' }, { label: 'No' }] }
        ],
        options: [
          { id: 'answer', label: 'Submit' },
          { id: 'deny', label: 'Skip' }
        ]
      }
    ])
    await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
    await view('terminal').locator('.chat-prompt[data-kind="question"]').waitFor()
    t.check(
      'both views reveal complete text and control requests, preserving draft, scroll and current state',
      true
    )

    await win
      .locator(`[data-sidebar-item-id="${other.id}"] > button`)
      .click({ modifiers: ['Meta'] })
    assert.ok(
      await view('terminal').isVisible(),
      'the first pane remains visible when another pane is focused'
    )
    assert.ok(await win.locator(`.chat-host[data-session-id="${other.id}"]`).isVisible())
    await delta('grid-live ')
    await view('terminal')
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'grid-live' })
      .waitFor()
    t.check('every selected grid pane streams even when another pane has focus', true)
    await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()

    const alternate = `${receipt.runId}-workspace`
    await view('terminal').evaluate((el) => {
      el.dataset.fixtureIdentity = 'before-workspace'
    })
    await callMcp(app, 'switchWorkspace', { workspace: alternate })
    assert.ok(
      await until(async () => !(await view('terminal').isVisible())),
      'the alternate workspace hides the pane'
    )
    await win.waitForTimeout(150)
    await frames()
    // Chromium reports a zero scroll box while hidden. Exercise a scroll
    // notification in that state before it restores the visible DOM offset;
    // this makes the virtualizer's stale hidden position reproducible.
    const hiddenScroll = view('terminal').locator('.chat-scroll')
    assert.deepEqual(
      await hiddenScroll.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop })),
      { height: 0, top: 0 },
      'the hidden scroll notification observes the real zero-sized browser box'
    )
    await hiddenScroll.dispatchEvent('scroll')
    await frames()
    await observe('terminal')
    await delta('workspace-hidden ')
    await frames()
    assert.equal(
      await win.evaluate(() => globalThis.__hiddenMutations),
      0,
      `a pane in another workspace defers presentation: ${JSON.stringify(await win.evaluate(() => globalThis.__hiddenMutationDetails))}`
    )
    await callMcp(app, 'switchWorkspace', { workspace: 'chat' })
    await win.locator(`[data-sidebar-item-id="${record.id}"] > button`).click()
    await reveal('terminal')
    assert.ok(
      await until(() => painted('terminal', 'workspace-hidden')),
      'workspace reveal paints the latest text without a test scroll'
    )
    assert.equal(
      await view('terminal').getAttribute('data-fixture-identity'),
      'before-workspace',
      'workspace switching keeps the native view mounted'
    )
    await view('terminal')
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'workspace-hidden' })
      .waitFor()
    t.check('workspace hiding defers rendering and returning catches up', true)

    await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    assert.ok(await until(async () => !(await view('terminal').isVisible())))
    await win.waitForTimeout(150)
    await frames()
    await observe('terminal')
    await delta('settings-hidden ')
    await frames()
    assert.equal(
      await win.evaluate(() => globalThis.__hiddenMutations),
      0,
      'Settings covering the grid defers presentation'
    )
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await reveal('terminal')
    assert.ok(
      await until(() => painted('terminal', 'settings-hidden')),
      'Settings reveal paints the latest text without a test scroll'
    )
    await view('terminal')
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'settings-hidden' })
      .waitFor()
    t.check('a grid covered by Settings catches up when sessions return', true)

    // Measure from the automation request through Chromium input delivery and
    // the observed controlled textarea value. This includes input queuing,
    // unlike a timer installed inside the input handler. It excludes hardware
    // and compositor presentation in the hidden no-activate test window.
    const field = view('terminal').getByRole('textbox', { name: 'Message', exact: true })
    await field.fill('')
    await win.evaluate((id) => {
      globalThis.__inputStreamObserved = 0
      globalThis.__stopInputStream = window.electronAPI.onSessionStream(id, (value) => {
        if (
          value.kind === 'event' &&
          value.event.type === 'assistant_text' &&
          value.event.delta === 'input-load '
        )
          globalThis.__inputStreamObserved++
      })
    }, other.id)
    await fixture.evaluate((id) => {
      globalThis.__inputStreamProduced = 0
      globalThis.__inputStreamTimer = setInterval(() => {
        globalThis.__inputStreamProduced++
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: { type: 'assistant_text', delta: 'input-load ', final: false }
        })
      }, 50)
    }, other.id)
    const rawMs = []
    for (let n = 0; n < 25; n++) {
      const start = performance.now()
      await field.pressSequentially('x')
      assert.equal(await field.inputValue(), 'x'.repeat(n + 1))
      rawMs.push(performance.now() - start)
    }
    const produced = await fixture.evaluate(() => {
      clearInterval(globalThis.__inputStreamTimer)
      return globalThis.__inputStreamProduced
    })
    assert.ok(produced > 0, 'the input exercise overlaps actual hidden streaming')
    assert.ok(
      await until(
        async () => (await win.evaluate(() => globalThis.__inputStreamObserved)) === produced
      ),
      'input-load deltas all arrive'
    )
    console.log(
      JSON.stringify({
        metric: 'input-request-to-observed-value',
        rawMs,
        hiddenProduced: produced,
        hiddenObserved: await win.evaluate(() => globalThis.__inputStreamObserved)
      })
    )
    assert.equal(rawMs.length, 25)
    t.check('real input requests reach the controlled composer in order', true)
  } finally {
    await fixture.evaluate(() => clearInterval(globalThis.__inputStreamTimer)).catch(() => {})
    await win
      .evaluate(() => {
        globalThis.__hiddenObserver?.disconnect()
        globalThis.__stopHidden?.()
        globalThis.__stopDelivery?.()
        globalThis.__stopInputStream?.()
      })
      .catch(() => {})
    await chat.close()
  }
}
