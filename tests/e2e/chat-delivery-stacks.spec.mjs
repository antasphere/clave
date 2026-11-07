import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openChat, inject } from './chat-view.spec.mjs'
import { until, fixturePath, REPO } from './harness.mjs'

/* Messages from other tabs gather in exchange timelines (one card per
   message); the agent's own words never do.
   On 5 November 2026 a collapsed deck hid an explanation, three numbered
   choices and "So I'm waiting on one answer from you: option 1, 2 or 3.",
   because the deck captured every reply and every tool run after a message
   from another tab until the reader wrote again. What this spec holds, in
   both presentations:
   - with every deck collapsed, the agent's explanation and its choices are
     on screen, while they stream and once the turn is final;
   - a tool run after a message from another tab keeps its own row;
   - consecutive messages from other tabs stack in one deck, and the next one
     after the agent spoke starts another; a deck the reader opened stays open
     as it grows; human turns and decks keep their order;
   - the expansion survives a virtualised remount, and the deck fits a narrow
     pane in the four themes.
   A conversation restored from its transcript is chat-delivery-history's. */

const CHOICES = ['Merge the fix now.', 'Wait for the verifier.', 'Drop the change.']

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
  const { deliveredMessage, loadChatDeliveries, EXPLANATION_END } = await import(
    pathToFileURL(modulePath).href
  )
  for (const mode of ['chat', 'terminal']) {
    const chat = await openChat(
      `delivery-stacks-${mode}`,
      mode === 'terminal' ? ['--dev-echo-view=clave.chat-view/terminal'] : [],
      `[data-testid="${mode}-view"] textarea:not(:disabled)`
    )
    const { win, record, fixture } = chat
    const view = win.locator(`[data-testid="${mode}-view"]`)
    const stacks = view.locator('.chat-delivery-stack')
    const toolRows = view.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools')
    /** The agent's turn holding `text`, mounted in the transcript or not at all. */
    const said = (text) => view.locator('.chat-turn[data-role="assistant"]', { hasText: text })
    const visible = (locator) => until(() => locator.isVisible())
    /** How many messages from other tabs the decks hold between them. */
    const stacked = () =>
      stacks.evaluateAll((els) => els.reduce((n, el) => n + Number(el.dataset.messages), 0))
    const allClosed = () =>
      view.locator('.exchange-card').evaluateAll((els) => els.every((el) => !el.open))
    /** The deck whose cover previews `text`: a handle that survives the
     *  virtualiser unmounting the decks above it, which a position does not. */
    const deckOf = (text) =>
      stacks.filter({ has: win.locator('.exchange-gist', { hasText: text }) })
    /** The transcript's order as mounted (the virtualiser keeps the end of the
     *  conversation in the DOM): decks by their size, turns by their first words. */
    const order = () =>
      view
        .locator(
          '.chat-delivery-stack, .chat-turn[data-role="assistant"], .chat-turn[data-role="user"]:not([data-from="tab"])'
        )
        .evaluateAll((els) =>
          els.map((el) =>
            el.classList.contains('chat-delivery-stack')
              ? `deck of ${el.dataset.messages}`
              : el.textContent.trim().split('\n')[0].slice(0, 40)
          )
        )
    try {
      const receipt = await loadChatDeliveries(
        (events) => inject(fixture, record.id, events),
        async () => {
          assert.ok(
            await until(async () => (await stacked()) === 4),
            'four messages from other tabs arrived'
          )
        }
      )
      assert.ok(receipt)
      console.log(JSON.stringify({ scenario: 'chat/cross-session-stacks', mode, receipt }))

      // The regression. Every deck is closed, and the agent's explanation to
      // the reader, still streaming, is on screen with its three choices.
      const streaming = {
        closed: await allClosed(),
        explanation: await visible(said('Here is where things stand.')),
        choices: []
      }
      for (const choice of CHOICES) streaming.choices.push(await visible(said(choice)))
      t.check(
        `${mode}: with every deck collapsed, the agent's explanation and its three choices are on screen while it streams`,
        streaming.closed && streaming.explanation && streaming.choices.every(Boolean),
        streaming
      )
      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: EXPLANATION_END, final: true }
      ])
      const final = { question: await visible(said(EXPLANATION_END)), closed: await allClosed() }
      t.check(
        `${mode}: the question the agent asks the reader is on screen once the turn is final, the decks still collapsed`,
        final.question && final.closed,
        final
      )
      const rows = await toolRows.count()
      t.check(
        `${mode}: a tool run after a message from another tab keeps its own row in the transcript`,
        rows === 2,
        { rows }
      )
      const shape = {
        decks: await stacks.evaluateAll((els) => els.map((el) => el.dataset.messages)),
        reply: await visible(said('Reply to the coordinator.')),
        progress: await view.getByText('I will report progress here.', { exact: true }).isVisible(),
        human: await view.getByText('Keep my conversation readable.', { exact: true }).isVisible()
      }
      t.check(
        `${mode}: consecutive messages from other tabs stack in one deck, and the agent's reply between them stays in the transcript`,
        shape.decks.join(',') === '1,3' && shape.reply && shape.progress && shape.human,
        shape
      )

      // The timeline itself: one card per message, its senders named, each
      // card opening on its message whole from the keyboard.
      const deck = view.locator('.chat-delivery-stack[data-messages="3"]')
      const cards = deck.locator('.exchange-card')
      assert.equal(await cards.count(), 3)
      assert.equal(
        await deck.locator('.exchange-part').count(),
        0,
        'closed exchanges stay unmounted'
      )
      assert.match(
        await deck.locator('.exchange-names').innerText(),
        /Lane verifier.*Another agent.*Wave coordinator/s
      )
      const faces = await deck.locator('.exchange-summary').allInnerTexts()
      assert.match(faces[0], /Lane verifier.*Second payload/s)
      assert.match(faces[1], /Another agent.*Third anonymous payload/s)
      assert.match(faces[2], /Wave coordinator.*Fourth payload/s)
      t.check(
        `${mode}: a timeline names its senders, one card per message, each face its sender and first line`,
        true
      )

      await cards.first().locator('> summary').focus()
      await cards.first().locator('> summary').press('Enter')
      await cards.first().locator('.exchange-part').first().waitFor()
      for (const index of [1, 2]) {
        await cards.nth(index).locator('> summary').click()
        await cards.nth(index).locator('.exchange-part').first().waitFor()
      }
      const texts = await deck
        .locator('.exchange-part[data-theirs] .exchange-part-text')
        .allTextContents()
      assert.equal(texts.length, 3)
      assert.match(texts[0], /Second payload, no omitted words/)
      assert.match(texts[1], /Third anonymous payload/)
      assert.match(texts[2], /Fourth payload, the merge is pre-authorised/)
      assert.ok(texts.every((s) => !s.includes('[Message from')))
      assert.equal(
        await deck.locator('.chat-turn[data-role="assistant"]').count(),
        0,
        'the timeline holds no words of the agent'
      )
      await cards.first().locator('> summary').press('Space')
      assert.equal(await cards.first().evaluate((el) => el.open), false)
      for (const index of [1, 2]) await cards.nth(index).locator('> summary').click()
      assert.ok(await until(allClosed), 'every card closes again')
      t.check(
        `${mode}: Enter opens a card on its full message, senders and order kept, with none of the agent's words; Space closes it`,
        true
      )

      // A message arriving after the agent spoke starts a new deck, and a deck
      // the reader opened stays open as consecutive messages stack on it.
      await inject(fixture, record.id, [deliveredMessage('Wave coordinator', 'Fifth payload.')])
      const third = deckOf('Fifth payload.')
      await third.waitFor()
      const fresh = await third.getAttribute('data-messages')
      await third.scrollIntoViewIfNeeded()
      const thirdFirst = third.locator('.exchange-card').first()
      await thirdFirst.locator('> summary').click()
      // The toggle event that mounts the exchange follows the click in its own
      // task: wait for it before the timeline is grown.
      await thirdFirst.locator('.exchange-part').first().waitFor()
      await inject(fixture, record.id, [deliveredMessage('Lane verifier', 'Sixth payload.')])
      const state = () =>
        third.evaluate((el) => ({
          open: el.querySelector('.exchange-card').open,
          bodies: el.querySelectorAll('.exchange').length,
          messages: el.dataset.messages
        }))
      await until(async () => {
        const now = await state()
        return now.open && now.bodies === 2 && now.messages === '2'
      })
      const grown = { ...(await state()), fresh }
      t.check(
        `${mode}: a message arriving after the agent spoke starts a new timeline, and a card the reader opened stays open as it grows`,
        fresh === '1' && grown.open && grown.bodies === 2 && grown.messages === '2',
        grown
      )
      await thirdFirst.locator('> summary').click()
      assert.ok(
        await until(async () => !(await thirdFirst.evaluate((el) => el.open))),
        'the opened card closes again'
      )
      // Reaching the card may have scrolled the reader off the end, where the
      // transcript no longer follows what arrives: back to the end, as a
      // reader would, before the next frames.
      await view.locator('.chat-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })

      // Human turns and decks keep their order, and every answer is on screen.
      await inject(fixture, record.id, [
        { type: 'assistant_text', delta: 'An answer after the sixth message.', final: true },
        { type: 'user_message', text: 'A new human question.' },
        { type: 'assistant_text', delta: 'A human-facing progress update.', final: true },
        deliveredMessage('Lane verifier', 'Lone payload.'),
        { type: 'assistant_text', delta: 'An answer to the lone agent.', final: true },
        { type: 'user_message', text: 'My follow-up.' }
      ])
      await view.getByText('My follow-up.', { exact: true }).waitFor()
      const expected = [
        'Keep my conversation readable.',
        'I will report progress here.',
        'deck of 1',
        'Reply to the coordinator.',
        'deck of 3',
        'Here is where things stand.',
        'deck of 2',
        'An answer after the sixth message.',
        'A new human question.',
        'A human-facing progress update.',
        'deck of 1',
        'An answer to the lone agent.',
        'My follow-up.'
      ]
      /** The mounted rows are the end of the expected order, from the deck of
       *  two at least: what follows the agent's explanation is the point. */
      const endsExpected = (sequence) =>
        sequence.length >= expected.length - expected.indexOf('deck of 2') &&
        JSON.stringify(expected.slice(expected.length - sequence.length)) ===
          JSON.stringify(sequence)
      const sequence = await order()
      const closed = await allClosed()
      t.check(
        `${mode}: every answer after a deck is on screen, and human turns and decks keep their order`,
        endsExpected(sequence) && closed,
        { sequence, closed }
      )

      // A tool run between two messages from other tabs keeps its row in its
      // place: the second message does not join the first deck across it (the
      // verifier's round 1 found the unit layer alone pinned this).
      await inject(fixture, record.id, [
        deliveredMessage('Wave coordinator', 'Seventh payload.'),
        {
          type: 'tool_call',
          id: 'between-decks',
          name: 'Bash',
          input: { command: 'echo between' }
        },
        { type: 'tool_result', id: 'between-decks', output: 'between' },
        deliveredMessage('Lane verifier', 'Eighth payload.'),
        // A turn of the agent's closes the frames: it is on screen whether the
        // rule holds or not, so the check below reports in its own name when
        // the rule regresses (the verifier's round 2 found a wait on the
        // eighth deck crashed the spec instead).
        { type: 'assistant_text', delta: 'Noted the eighth message.', final: true }
      ])
      assert.ok(await visible(said('Noted the eighth message.')), 'the frames arrived')
      const between = (
        await view
          .locator(`.chat-delivery-stack, ${mode === 'chat' ? '.chat-tool-run' : '.term-tools'}`)
          .evaluateAll((els) =>
            els.map((el) =>
              el.classList.contains('chat-delivery-stack')
                ? `deck of ${el.dataset.messages}`
                : 'tool run'
            )
          )
      ).slice(-3)
      t.check(
        `${mode}: a tool run between two messages from other tabs keeps its row in its place, and the second message starts its own deck`,
        JSON.stringify(between) === JSON.stringify(['deck of 1', 'tool run', 'deck of 1']),
        { between }
      )

      // The deck fits a narrow pane in the four themes, and respects reduced
      // motion. The deck sits near the top, unmounted once the transcript has
      // grown past the viewport: scroll back to it first.
      const scroller = view.locator('.chat-scroll')
      await scroller.evaluate((el) => {
        el.scrollTop = 0
      })
      await deck.waitFor()
      await deck.scrollIntoViewIfNeeded()
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
        await deck.scrollIntoViewIfNeeded()
        assert.ok(await deck.locator('.exchange-summary').first().isVisible())
        assert.ok(
          await deck
            .locator('.exchange-summary')
            .first()
            .evaluate((el) => el.scrollWidth <= el.clientWidth)
        )
      }
      assert.equal(surfaces.size, 4, 'four different active palettes were exercised')
      t.check(`${mode}: the deck fits a narrow pane in all four themes`, true)

      await win.emulateMedia({ reducedMotion: 'reduce' })
      assert.deepEqual(
        await deck.evaluate((el) => {
          const card = el.querySelector('.exchange-card')
          return [
            getComputedStyle(card).transitionDuration,
            getComputedStyle(card, '::details-content').transitionDuration,
            getComputedStyle(card.querySelector('.exchange-body')).transitionDuration
          ]
        }),
        ['0s', '0s', '0s']
      )
      await win.emulateMedia({ reducedMotion: 'no-preference' })

      // The expansion survives a virtualised remount.
      const card = deck.locator('.exchange-card').first()
      await card.locator('> summary').click()
      assert.equal(await card.evaluate((el) => el.open), true)
      await inject(
        fixture,
        record.id,
        Array.from({ length: 60 }, (_, i) =>
          i % 2 === 0
            ? { type: 'user_message', text: `Filler ${i}` }
            : { type: 'assistant_text', delta: 'A long response. '.repeat(60), final: true }
        )
      )
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      assert.ok(
        await until(async () => (await deck.count()) === 0),
        'the deck unmounts outside the viewport'
      )
      await scroller.evaluate((el) => {
        el.scrollTop = 0
      })
      await deck.waitFor()
      const remounted = {
        open: await card.evaluate((el) => el.open),
        bodies: await deck.locator('.exchange-part[data-theirs]').count()
      }
      await card.locator('> summary').press('Space')
      remounted.closedAgain = !(await card.evaluate((el) => el.open))
      t.check(
        `${mode}: the expansion survives a virtualised remount, and Space collapses it`,
        remounted.open && remounted.bodies === 1 && remounted.closedAgain,
        remounted
      )
    } finally {
      await chat.close()
    }
  }
}
