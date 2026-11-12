import assert from 'node:assert/strict'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Folio's written titles and its spoken read-aloud, on the real app with the
   echo adapter (the agent answers with the reader's own words):
   - a page's head shows the first sentence of the question at once, then
     the title a helper wrote in its place (PRDCT-4412); the contents list
     shows the same;
   - the voice card's Listen rewrites the answer for the voice first ("Rewriting
     for the voice"), then speaks it, never the page as written (PRDCT-4409);
   - a spoken version that cannot be had (switched off) reads the page as
     written, and the card says why;
   - with no ElevenLabs key on the server, the Mac's voice reads the page,
     and the card says so, then offers to listen again (PRDCT-4411; the
     ElevenLabs voice itself is folio-elevenlabs.spec.mjs).
   Under the harness no model runs: the helpers' replies come from
   CLAVE_E2E_PAGE_TITLE_REPLY and CLAVE_E2E_SPOKEN_REPLY, after a beat, read
   by the real parsers. The system voice is stubbed in the page: it records
   what it is asked to say and plays each utterance for a moment. */

const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'

/** The system voice, as the page sees it: every utterance asked is kept. */
async function stubVoice(win) {
  await win.evaluate(() => {
    window.__spoken = []
    const stub = {
      speaking: false,
      pending: false,
      paused: false,
      speak(utterance) {
        window.__spoken.push(utterance.text)
        setTimeout(() => {
          utterance.onstart?.()
          setTimeout(() => utterance.onend?.(), 1200)
        }, 50)
      },
      // The page never pauses or lists voices; a cancel has nothing to stop.
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true })
  })
}

async function ask(view, text) {
  const input = view.locator('textarea[aria-label="Message"]')
  await input.fill(text)
  await input.press('Enter')
}

export async function run(t) {
  {
    const chat = await openChat('folio-voice', FOLIO, READY, {
      CLAVE_E2E_PAGE_TITLE_REPLY: 'The weather in Brussels',
      CLAVE_E2E_SPOKEN_REPLY: '<spoken>Spoken text.</spoken>'
    })
    const { win } = chat
    try {
      const view = win.locator('[data-testid="folio-view"]')
      await stubVoice(win)
      const question = 'tell me about the weather in brussels please'
      await ask(view, question)
      const title = view.locator('h2.folio-title')
      // The stand-in first: the question's first sentence, at once.
      const standIn = await until(
        async () =>
          (await title.count()) && (await title.innerText()).trim() === question ? true : null,
        { tries: 40, gapMs: 25 }
      )
      assert.ok(standIn, 'the head shows the question as its title at once')
      t.check('a page shows the first sentence of its question as its title at once', true)

      const started = Date.now()
      const written = await until(
        async () => ((await title.innerText()).trim() === 'The weather in Brussels' ? true : null),
        { tries: 50, gapMs: 100 }
      )
      assert.ok(written && Date.now() - started <= 5000, 'the written title within 5 s')
      assert.equal(await title.getAttribute('data-title'), 'written')
      assert.equal(await title.locator('.folio-loader').count(), 0)
      // Under a written title, the reader's own words are shown whole.
      assert.equal((await view.locator('.folio-brief').innerText()).trim(), question)
      t.check('the title a helper wrote replaces the stand-in in place', true)

      await view.getByRole('button', { name: 'Contents', exact: true }).click()
      const contents = win.locator('.folio-contents-title')
      await contents.first().waitFor()
      assert.deepEqual(
        (await contents.allInnerTexts()).map((s) => s.trim()),
        ['The weather in Brussels']
      )
      await win.keyboard.press('Escape')
      t.check('the contents list the written title', true)

      // Listen: the answer is rewritten for the voice, then spoken.
      const card = view.locator('[data-testid="folio-voice-card"]')
      const state = () => card.getAttribute('data-voice-state')
      await card.locator('.folio-voice-listen').click()
      const rewriting = await until(
        async () =>
          (await state()) === 'rewriting'
            ? (await card.locator('[data-testid="folio-voice-line"]').innerText()).trim()
            : null,
        { tries: 40, gapMs: 25 }
      )
      assert.match(rewriting ?? '', /^Rewriting for the voice\s*\d+s$/)
      assert.equal(
        await card.locator('[data-step="rewriting"]').getAttribute('data-lit'),
        'true',
        'step 1 of 2 is lit'
      )
      const why = await until(
        async () =>
          (await state()) === 'playing'
            ? (await card.locator('[data-testid="folio-voice-why"]').innerText()).trim()
            : null,
        { tries: 50, gapMs: 50 }
      )
      // No ElevenLabs key on this server (PRDCT-4411): the Mac's voice reads
      // it, and the card says so.
      assert.equal(why, "Reading with the Mac's voice: no ElevenLabs on this server")
      const spoken = await win.evaluate(() => window.__spoken)
      assert.deepEqual(spoken, ['Spoken text.'])
      t.check('reading a page aloud rewrites it for the voice, then speaks it', true)
      const again = await until(async () =>
        (await state()) === 'idle'
          ? (await card.locator('.folio-voice-listen').innerText()).trim()
          : null
      )
      t.equal('once read, the card offers to listen again', again, 'Listen again')
      t.equal(
        "with no ElevenLabs on the server, the card says the Mac's voice read it, and why",
        (await card.locator('[data-testid="folio-voice-why"]').innerText()).trim(),
        'No ElevenLabs on this server'
      )
    } finally {
      await chat.close()
    }
  }
  {
    const chat = await openChat('folio-voice-fallback', FOLIO, READY, {
      CLAVE_E2E_SPOKEN_REPLY: 'E2E_FAIL:disabled'
    })
    const { win } = chat
    try {
      const view = win.locator('[data-testid="folio-view"]')
      await stubVoice(win)
      await ask(view, 'read this one as it is written')
      const card = view.locator('[data-testid="folio-voice-card"]')
      await card.locator('.folio-voice-listen').click()
      const spoken = await until(async () => {
        const said = await win.evaluate(() => window.__spoken)
        return said.length ? said : null
      })
      assert.deepEqual(spoken, ['read this one as it is written.'])
      const why = await until(async () => {
        if ((await card.getAttribute('data-voice-state')) !== 'idle') return null
        const line = card.locator('[data-testid="folio-voice-why"]')
        if (!(await line.count())) return null
        const said = (await line.innerText()).trim()
        return said.startsWith('Read as written') ? said : null
      })
      assert.ok(why, 'the card says the page was read as written')
      assert.equal(why, 'Read as written: spoken versions are switched off in Settings.')
      t.check('a page with no spoken version is read as written, and the card says why', true)
    } finally {
      await chat.close()
    }
  }
}
