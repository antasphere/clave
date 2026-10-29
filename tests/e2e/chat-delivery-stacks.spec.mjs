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
        'closed bodies stay unmounted'
      )
      assert.match(
        await first.locator('summary').innerText(),
        /3 messages from.*Wave coordinator.*Lane verifier.*Another agent/s
      )
      assert.ok(await view.getByText('Keep my conversation readable.', { exact: true }).isVisible())
      assert.ok(await view.getByText('I will report progress here.', { exact: true }).isVisible())
      t.check(`${mode}: deliveries start in one collapsed stack; human turns stay visible`, true)

      await first.locator('summary').focus()
      await first.locator('summary').press('Enter')
      await first.locator('.chat-delivery-items').waitFor()
      const texts = await first.locator('[data-from="tab"]').allTextContents()
      assert.equal(texts.length, 3)
      assert.match(texts[0], /First payload.*Recovery details/s)
      assert.match(texts[1], /Second payload, no omitted words/)
      assert.match(texts[2], /Third anonymous payload/)
      assert.ok(texts.every((s) => !s.includes('[Message from')))
      await inject(fixture, record.id, [deliveredMessage('Wave coordinator', 'Fourth payload.')])
      const grown = view.locator('.chat-delivery-stack[data-messages="4"]')
      await grown.waitFor()
      assert.equal(await grown.evaluate((el) => el.open), true)
      assert.equal(await grown.locator('[data-from="tab"]').count(), 4)
      t.check(
        `${mode}: keyboard expansion preserves full text, senders and order as the stack grows`,
        true
      )

      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: 'A human-facing progress update.', final: true },
        { type: 'tool_call', id: 'stack-command', name: 'Bash', input: { command: 'echo done' } },
        { type: 'tool_result', id: 'stack-command', output: 'done' },
        deliveredMessage('Lane verifier', 'Lone payload.'),
        { type: 'user_message', text: 'My follow-up.' }
      ])
      const lone = view.locator('.chat-delivery-stack[data-messages="1"]')
      await lone.waitFor()
      assert.equal(await lone.evaluate((el) => el.open), false)
      assert.equal(await stacks.count(), 2)
      assert.ok(
        await view.getByText('A human-facing progress update.', { exact: true }).isVisible()
      )
      assert.ok(await view.getByText('My follow-up.', { exact: true }).isVisible())
      assert.equal(
        await view.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools').count(),
        1
      )
      t.check(`${mode}: prose and commands divide stacks; a lone delivery also starts closed`, true)

      for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
        await win.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme)
        await win.setViewportSize({ width: 850, height: 700 })
        assert.ok(await grown.locator('summary').isVisible())
        assert.ok(await grown.locator('summary').evaluate((el) => el.scrollWidth <= el.clientWidth))
      }
      t.check(`${mode}: stack fits a narrow pane in all four themes`, true)

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
      await grown.locator('summary').press('Space')
      assert.equal(await grown.evaluate((el) => el.open), false)
      t.check(`${mode}: expansion survives virtualised remount and Space collapses it`, true)
    } finally {
      await chat.close()
    }
  }
}
