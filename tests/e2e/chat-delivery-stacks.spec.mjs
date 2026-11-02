import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openChat, inject } from './chat-view.spec.mjs'
import { until, fixturePath, REPO } from './harness.mjs'

export async function run(t) {
  const modulePath = fixturePath('chat-deliveries-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/chat-deliveries.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { deliveredMessage, loadChatDeliveries } = await import(pathToFileURL(modulePath).href)
  for (const mode of ['chat', 'terminal']) {
    const chat = await openChat(
      `delivery-stacks-${mode}`,
      mode === 'terminal' ? ['--dev-echo-view=clave.chat-view/terminal'] : [],
      `[data-testid="${mode}-view"] textarea:not(:disabled)`
    )
    const { win, record, fixture } = chat
    const view = win.locator(`[data-testid="${mode}-view"]`)
    const stacks = view.locator('.chat-delivery-stack')
    const first = view.locator('.chat-delivery-stack[data-messages="3"]')
    try {
      const receipt = await loadChatDeliveries(
        (events) => inject(fixture, record.id, events),
        async () => {
          await first.waitFor()
        }
      )
      assert.ok(receipt)
      console.log(JSON.stringify({ scenario: 'chat/cross-session-stacks', mode, receipt }))
      assert.equal(await first.evaluate((el) => el.open), false)
      assert.equal(
        await view.locator('[data-from="tab"]').count(),
        0,
        'closed message and response bodies stay unmounted'
      )
      assert.match(
        await first.locator('> summary').innerText(),
        /Agent conversation.*3 exchanges.*Wave coordinator.*Lane verifier.*Another agent/s
      )
      assert.ok(await view.getByText('Keep my conversation readable.', { exact: true }).isVisible())
      assert.ok(await view.getByText('I will report progress here.', { exact: true }).isVisible())
      const geometry = await first.evaluate((el) => {
        const cover = el.querySelector('.chat-delivery-cover').getBoundingClientRect()
        return [...el.querySelectorAll('.chat-delivery-peek')].map((peek) => {
          const box = peek.getBoundingClientRect()
          return { inset: box.left - cover.left, below: box.bottom - cover.bottom }
        })
      })
      assert.equal(geometry.length, 2)
      assert.ok(geometry[0].inset > 0 && geometry[0].below > 0)
      assert.ok(geometry[1].inset > geometry[0].inset && geometry[1].below > geometry[0].below)
      t.check(`${mode}: closed deck has inset layered cards; human turns stay visible`, true)

      await first.locator('> summary').focus()
      await first.locator('> summary').press('Enter')
      await first.locator('.chat-delivery-items').waitFor()
      const texts = await first.locator('[data-from="tab"]').allTextContents()
      assert.equal(texts.length, 3)
      assert.match(texts[0], /First payload.*Recovery details/s)
      assert.match(texts[1], /Second payload, no omitted words/)
      assert.match(texts[2], /Third anonymous payload/)
      assert.ok(texts.every((s) => !s.includes('[Message from')))
      assert.equal(await first.locator('.chat-exchange-card').count(), 3)
      assert.match(
        await first.locator('.chat-exchange-card').nth(0).innerText(),
        /Reply to the coordinator/
      )
      assert.match(
        await first.locator('.chat-exchange-card').nth(1).innerText(),
        /Reply to the verifier/
      )
      assert.equal(
        await first.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools').count(),
        1
      )
      const command = first.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools')
      await command.locator('> summary').click()
      assert.ok(await command.evaluate((el) => el.open))
      await inject(fixture, record.id, [deliveredMessage('Wave coordinator', 'Fourth payload.')])
      const grown = view.locator('.chat-delivery-stack[data-messages="4"]')
      await grown.waitFor()
      assert.equal(await grown.evaluate((el) => el.open), true)
      assert.equal(await grown.locator('[data-from="tab"]').count(), 4)
      t.check(
        `${mode}: keyboard expansion preserves full text, senders and order as the stack grows`,
        true
      )
      await grown.locator('> summary').press('Space')

      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: 'An answer to the fourth agent message.', final: true },
        { type: 'tool_call', id: 'stack-command', name: 'Bash', input: { command: 'echo done' } },
        { type: 'tool_result', id: 'stack-command', output: 'done' },
        { type: 'user_message', text: 'A new human question.' },
        { type: 'assistant_text', delta: 'A human-facing progress update.', final: true },
        deliveredMessage('Lane verifier', 'Lone payload.'),
        { type: 'assistant_text', delta: 'An answer to the lone agent.', final: true },
        { type: 'user_message', text: 'My follow-up.' }
      ])
      const lone = view.locator('.chat-delivery-stack[data-messages="1"]')
      await lone.waitFor()
      // The fixture emits a sequence of frames; seeing the delivery does not
      // mean the renderer has received the human turn that follows it yet.
      await view.getByText('My follow-up.', { exact: true }).waitFor()
      assert.equal(await lone.evaluate((el) => el.open), false)
      assert.equal(await stacks.count(), 2)
      assert.ok(
        await view.getByText('A human-facing progress update.', { exact: true }).isVisible()
      )
      assert.ok(await view.getByText('My follow-up.', { exact: true }).isVisible())
      // Closing can let the virtualiser remount this deck. Its lazy bodies
      // need not survive while closed; inspect them after explicitly opening.
      await grown.locator('> summary').click()
      assert.ok(
        await until(
          async () =>
            (await grown.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools').count()) === 2
        )
      )
      assert.match(await grown.textContent(), /An answer to the fourth agent message/)
      await grown.locator('> summary').click()
      assert.equal(
        await lone.locator('.chat-exchange-card').count(),
        0,
        'closed replies remain unmounted'
      )
      t.check(
        `${mode}: replies and commands belong to the agent deck; human turns divide decks`,
        true
      )

      const surfaces = new Set()
      for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
        const surface = await win.evaluate(async (theme) => {
          const state = await window.electronAPI.skinsActivate(theme)
          return state.skins.find((skin) => skin.id === theme).tokens['--surface-0'].trim()
        }, theme)
        assert.ok(
          await until(() =>
            win.evaluate(
              (expected) =>
                document.documentElement.style.getPropertyValue('--surface-0').trim() === expected,
              surface
            )
          )
        )
        surfaces.add(surface)
        await win.setViewportSize({ width: 850, height: 700 })
        assert.ok(await grown.locator('> summary').isVisible())
        assert.ok(
          await grown.locator('> summary').evaluate((el) => el.scrollWidth <= el.clientWidth)
        )
      }
      assert.equal(surfaces.size, 4, 'four different active palettes were exercised')
      t.check(`${mode}: stack fits a narrow pane in all four themes`, true)

      await win.emulateMedia({ reducedMotion: 'reduce' })
      assert.deepEqual(
        await grown.evaluate((el) => [
          getComputedStyle(el).transitionDuration,
          getComputedStyle(el, '::details-content').transitionDuration,
          getComputedStyle(el.querySelector('.chat-delivery-peek')).transitionDuration
        ]),
        ['0s', '0s', '0s']
      )
      await win.emulateMedia({ reducedMotion: 'no-preference' })

      await grown.locator('> summary').click()

      await inject(
        fixture,
        record.id,
        Array.from({ length: 60 }, (_, i) =>
          i % 2 === 0
            ? { type: 'user_message', text: `Filler ${i}` }
            : { type: 'assistant_text', delta: 'A long response. '.repeat(60), final: true }
        )
      )
      const scroller = view.locator('.chat-scroll')
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      assert.ok(
        await until(async () => (await grown.count()) === 0),
        'stack unmounts outside the viewport'
      )
      await scroller.evaluate((el) => {
        el.scrollTop = 0
      })
      await grown.waitFor()
      assert.equal(await grown.evaluate((el) => el.open), true)
      assert.equal(await grown.locator('[data-from="tab"]').count(), 4)
      await grown.locator('> summary').press('Space')
      assert.equal(await grown.evaluate((el) => el.open), false)
      t.check(`${mode}: expansion survives virtualised remount and Space collapses it`, true)
    } finally {
      await chat.close()
    }
  }
}
