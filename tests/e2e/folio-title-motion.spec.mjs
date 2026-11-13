import assert from 'node:assert/strict'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Folio's written title and motion (PRDCT-4412), on the real app with the
   echo adapter: the head shows the question's first sentence at once, then
   the title a helper wrote (CLAVE_E2E_PAGE_TITLE_REPLY, after the harness's
   beat). For a reader who asked for no motion the title swaps in with no
   frame of the reveal; without that ask, the reveal plays in place. The
   head's `data-revealing` is polled in the page every 16 ms through the
   change, so a single frame of the reveal is seen. */

const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const WRITTEN = 'The weather in Brussels'

async function ask(view, text) {
  const input = view.locator('textarea[aria-label="Message"]')
  await input.fill(text)
  await input.press('Enter')
}

/** Start sampling the head every 16 ms: its text, whether it is the
 *  stand-in or the written title, and whether a reveal frame is on it. */
async function startSampling(win) {
  await win.evaluate(() => {
    window.__titleSamples = []
    const timer = setInterval(() => {
      const heads = document.querySelectorAll('[data-testid="folio-view"] h2.folio-title')
      const head = heads[heads.length - 1]
      if (!head) return
      window.__titleSamples.push({
        title: head.getAttribute('data-title'),
        revealing: head.getAttribute('data-revealing')
      })
    }, 16)
    window.__stopTitleSamples = () => clearInterval(timer)
  })
}

/** Ask a question, sample the head through the change from the stand-in to
 *  the written title and a beat past it, and return the samples. */
async function sampleChange(win, view, question) {
  await startSampling(win)
  await ask(view, question)
  const title = view.locator('h2.folio-title').last()
  const written = await until(
    async () =>
      (await title.count()) &&
      (await title.getAttribute('data-title')) === 'written' &&
      (await title.getAttribute('data-revealing')) === null
        ? true
        : null,
    { tries: 80, gapMs: 100 }
  )
  assert.ok(written, 'the written title takes the stand-in’s place')
  assert.equal((await title.innerText()).trim(), WRITTEN)
  await new Promise((resolve) => setTimeout(resolve, 200))
  return win.evaluate(() => {
    window.__stopTitleSamples()
    return window.__titleSamples
  })
}

export async function run(t) {
  const chat = await openChat('folio-title-motion', FOLIO, READY, {
    CLAVE_E2E_PAGE_TITLE_REPLY: WRITTEN
  })
  const { win } = chat
  try {
    const view = win.locator('[data-testid="folio-view"]')

    await win.emulateMedia({ reducedMotion: 'reduce' })
    const still = await sampleChange(win, view, 'tell me about the weather in brussels please')
    assert.ok(
      still.some((s) => s.title === 'stand-in'),
      'the stand-in was on the head before the written title'
    )
    t.equal(
      'under reduced motion, the written title swaps in with no frame of the reveal',
      still.filter((s) => s.revealing === 'true').length,
      0
    )

    await win.emulateMedia({ reducedMotion: 'no-preference' })
    const moving = await sampleChange(win, view, 'and what about the weather in ghent tomorrow')
    assert.ok(
      moving.some((s) => s.title === 'stand-in'),
      'the stand-in was on the head before the written title'
    )
    t.check(
      'without reduced motion, the written title is revealed in place',
      moving.some((s) => s.revealing === 'true')
    )
  } finally {
    await chat.close()
  }
}
