// The status card (PRDCT-5166) on the real app: an answer that ends with a
// `clave-status` block shows its words and a card under them, in the Chat,
// Enclave and Folio views, and nothing of the block as text. The echo
// adapter answers with what it was sent, whole, in one final delta, so a
// message written with a block comes back as an answer that ends with it.
// Checked: the card and its four fields; no `clave-status` in the answer's
// text nor in its copy; the next message makes the card before it past; a
// block followed by words is the answer's text and draws no card; a card
// alone is drawn with no words. Every locator is scoped to its view: the
// views of one session stay mounted when another is shown.
import assert from 'node:assert/strict'
import { until } from './harness.mjs'
import { openChat, selectChatView } from './chat-view.spec.mjs'

const block = (...lines) => ['```clave-status', ...lines, '```'].join('\n')
const ASKS = `The export is ready.\n\n${block(
  'doing: the export of a conversation',
  'where: the writer is done and its tests pass',
  'decide: keep the old format? I would, for the readers who parse it',
  'next: answer the question above'
)}`
const NOTHING = `All merged.\n\n${block('where: the export shipped', 'next: nothing')}`
const TRAILED = `Here is the format:\n\n${block('doing: an example')}\n\nAnd a word after it.`
const ALONE = block('doing: a card with no words', 'next: nothing')

export async function run(t) {
  const { win, record, close } = await openChat('chat-status-card')
  try {
    const chat = win.locator('[data-testid="chat-view"]')
    const send = async (text) => {
      const before = await chat.locator('.chat-turn-wrap[data-side="end"]').count()
      const composer = chat.locator('textarea')
      await composer.fill(text)
      await composer.press('Enter')
      await until(async () =>
        (await chat.locator('.chat-turn-wrap[data-side="end"]').count()) > before ? true : null
      )
    }
    const answers = (view) => view.locator('.chat-turn[data-role="assistant"]')

    /* The Chat view. */
    await send(ASKS)
    const cards = chat.getByTestId('status-card')
    await until(async () => ((await cards.count()) === 1 ? true : null))
    const first = cards.first()
    const firstText = await first.innerText()
    t.check(
      'Chat: the card shows its four fields',
      [
        'the export of a conversation',
        'the writer is done and its tests pass',
        'To decide',
        'keep the old format? I would, for the readers who parse it',
        'Next',
        'answer the question above'
      ].every((words) => firstText.includes(words)),
      { firstText }
    )
    t.check(
      'Chat: the card asks something and is current',
      (await first.getAttribute('data-needs-you')) === 'true' &&
        (await first.getAttribute('data-past')) === null
    )
    const answer = answers(chat).first()
    const answerText = await answer.innerText()
    t.check(
      'Chat: the answer is its words, with no trace of the block',
      answerText.trim() === 'The export is ready.' && !answerText.includes('clave-status'),
      { answerText }
    )
    await answer.hover()
    await chat
      .locator('.chat-turn-wrap[data-side="start"]')
      .first()
      .getByRole('button', { name: 'Copy message', exact: true })
      .click()
    const copied = await win.evaluate(() => navigator.clipboard.readText())
    t.check(
      'Chat: the copy of the answer holds its words alone',
      copied === 'The export is ready.',
      {
        copied
      }
    )

    await send(NOTHING)
    await until(async () => ((await cards.count()) === 2 ? true : null))
    t.check(
      'Chat: the next message makes the card before it past, and the new one owes nothing',
      (await cards.nth(0).getAttribute('data-past')) === 'true' &&
        (await cards.nth(1).getAttribute('data-past')) === null &&
        (await cards.nth(1).getAttribute('data-needs-you')) === 'false' &&
        (await cards.nth(1).innerText()).includes('Nothing needed from you')
    )

    await send(TRAILED)
    await until(async () => ((await answers(chat).count()) === 3 ? true : null))
    const trailed = await answers(chat).nth(2).innerText()
    t.check(
      'Chat: a block followed by words is the answer, and draws no card',
      (await cards.count()) === 2 &&
        trailed.includes('clave-status') &&
        trailed.includes('And a word after it.'),
      { trailed }
    )

    await send(ALONE)
    await until(async () => ((await cards.count()) === 3 ? true : null))
    const lastWrap = chat.locator('.chat-turn-wrap[data-side="start"]').last()
    t.check(
      'Chat: a card alone is drawn with no words, and is current',
      (await lastWrap.locator('.chat-turn').count()) === 0 &&
        (await lastWrap.getByTestId('status-card').count()) === 1 &&
        (await cards.nth(2).getAttribute('data-past')) === null &&
        (await cards.nth(1).getAttribute('data-past')) === 'true'
    )
    const chatAnswers = await answers(chat).allInnerTexts()
    t.check(
      'Chat: no answer but the one that quotes the format shows the block',
      chatAnswers.filter((text) => text.includes('clave-status')).length === 1,
      { chatAnswers }
    )

    /* Enclave. */
    await selectChatView(win, record.id, 'terminal')
    const term = win.locator('[data-testid="terminal-view"]')
    await term.waitFor()
    const termCards = term.getByTestId('status-card')
    await until(async () => ((await termCards.count()) === 3 ? true : null))
    const termAnswers = await answers(term).allInnerTexts()
    t.check(
      'Enclave: three cards, the last one current, the two before it past',
      (await termCards.nth(0).getAttribute('data-past')) === 'true' &&
        (await termCards.nth(1).getAttribute('data-past')) === 'true' &&
        (await termCards.nth(2).getAttribute('data-past')) === null
    )
    t.check(
      'Enclave: the card shows its fields, and only the quoting answer shows the block',
      (await termCards.nth(0).innerText()).includes('keep the old format?') &&
        termAnswers.filter((text) => text.includes('clave-status')).length === 1 &&
        termAnswers.some((text) => text.trim() === 'The export is ready.'),
      { termAnswers }
    )

    /* Folio: the last page holds the card alone; the first, the past card. */
    await selectChatView(win, record.id, 'lab')
    const folio = win.locator('[data-testid="folio-view"]')
    await folio.waitFor()
    const page = folio.locator('.folio-page')
    await until(async () => ((await page.getByTestId('status-card').count()) === 1 ? true : null))
    const lastCard = page.getByTestId('status-card')
    t.check(
      'Folio: the last page draws its card alone, current',
      (await lastCard.getAttribute('data-past')) === null &&
        (await lastCard.innerText()).includes('a card with no words') &&
        (await page.locator('.folio-prose').count()) === 0
    )
    for (let i = 0; i < 3; i++) await folio.locator('[aria-label="Previous page"]').click()
    await until(async () =>
      (await page.innerText()).includes('The export is ready.') ? true : null
    )
    const firstPage = page.getByTestId('status-card')
    const pageText = await page.locator('.folio-prose').first().innerText()
    t.check(
      'Folio: the first page draws its words and its past card, with no trace of the block',
      (await firstPage.getAttribute('data-past')) === 'true' &&
        (await firstPage.innerText()).includes('answer the question above') &&
        pageText.trim() === 'The export is ready.',
      { pageText }
    )
    const copy = page.getByRole('button', { name: 'Copy the answer' })
    if (await copy.count()) {
      await copy.click()
      const folioCopy = await win.evaluate(() => navigator.clipboard.readText())
      t.check(
        'Folio: the copy of the answer holds its words alone',
        folioCopy === 'The export is ready.',
        {
          folioCopy
        }
      )
    } else assert.fail('Folio: the finished page offers its copy')
  } finally {
    await close()
  }
}
