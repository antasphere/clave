import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Folio reads a page in the ElevenLabs voice of the server the tab runs on
   (PRDCT-4411), on the real app with the echo adapter:
   - the key pasted and a voice chosen on this Mac's Integrations page, "Read
     it to me" prepares the spoken version, asks the server for its audio and
     plays it through an audio element; the control says "Reading with
     ElevenLabs"; ElevenLabs was asked with the pasted key, in its header, for
     the spoken text;
   - ElevenLabs answering 402 (the credits spent): the system voice reads the
     page and the control says why.
   ElevenLabs is a stub on a local port (`CLAVE_ELEVENLABS_BASE_URL`) that
   answers a second of silence; every key is invented. In the page, audio
   playback is stubbed (`play` resolves and `ended` fires 100 ms later) and so
   is the system voice; both record what they were asked. The spoken
   rendering comes from CLAVE_E2E_SPOKEN_REPLY. Pinned in-process: the
   Integrations page is this Mac's, the same process that speaks. */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SILENCE = readFileSync(path.join(HERE, 'fixtures', 'silence-1s.mp3'))
const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const GOOD = 'xi-test-folio-good'
const VOICES = [
  { voice_id: 'voice-a', name: 'Ada', category: 'premade', labels: {}, preview_url: null },
  { voice_id: 'voice-b', name: 'Basil', category: 'premade', labels: {}, preview_url: null }
]

/** The stub: the account and the voices for the good key; speech as a
 *  second of silence, or 402 once `quota` is set. */
function startStub() {
  const seen = []
  const state = { quota: false }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const key = req.headers['xi-api-key']
      const { pathname } = new URL(req.url, 'http://stub')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      seen.push({ method: req.method, pathname, key, body })
      const json = (status, value) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (key !== GOOD) return json(401, { detail: { status: 'invalid_api_key' } })
      if (pathname === '/v1/user/subscription')
        return json(200, { tier: 'creator', character_count: 10, character_limit: 100000 })
      if (pathname === '/v2/voices') return json(200, { voices: VOICES, has_more: false })
      if (req.method === 'POST' && /^\/v1\/text-to-speech\/[^/]+(\/stream)?$/.test(pathname)) {
        if (state.quota)
          return json(402, { detail: { status: 'payment_required', message: 'credits' } })
        return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(SILENCE)
      }
      return json(404, {})
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        state,
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

/** The page's audio and system voice, stubbed: each records what it plays. */
async function stubPlayback(win) {
  await win.evaluate(() => {
    window.__played = []
    window.__spoken = []
    window.__titles = []
    HTMLMediaElement.prototype.play = function play() {
      window.__played.push(this.src)
      setTimeout(() => this.dispatchEvent(new Event('ended')), 100)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function pause() {
      window.__paused = (window.__paused ?? 0) + 1
    }
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
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true })
    // Every title the read control takes, as it takes it: a reading of a
    // tenth of a second is over before a poll would see it.
    new MutationObserver(() => {
      const control = document.querySelector('.folio-foot .folio-read')
      const title = control?.getAttribute('title') ?? null
      if (title && window.__titles.at(-1) !== title) window.__titles.push(title)
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title']
    })
  })
}

async function pick(win, select, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await select.click()
    const item = win.getByRole('menuitem', { name })
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) {
      await item.click({ timeout: 3000 }).catch(() => undefined)
      return
    }
    await win.keyboard.press('Escape')
  }
  throw new Error(`the select never offered ${String(name)}`)
}

/** The key pasted and a voice chosen on this Mac's Integrations page. */
async function setUpVoice(win) {
  await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
  await win.locator('[data-settings-nav-row="integrations"]').click()
  const card = win.locator('[data-settings-page="integrations"] [data-integration="elevenlabs"]')
  await card.waitFor()
  await card.locator('[data-testid="elevenlabs-key-input"]').fill(GOOD)
  await card.locator('[data-testid="elevenlabs-key-save"]').click()
  const select = card.locator('[data-settings-select="elevenlabs-voice"]')
  await select.waitFor()
  await until(async () => !(await select.isDisabled()))
  await pick(win, select, /^Basil/)
  await until(async () => (await select.getAttribute('data-value')) === 'voice-b')
  await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
}

async function ask(view, text) {
  const input = view.locator('textarea[aria-label="Message"]')
  await input.fill(text)
  await input.press('Enter')
}

export async function run(t) {
  const stub = await startStub()
  const chat = await openChat(
    'folio-elevenlabs',
    FOLIO,
    READY,
    {
      CLAVE_ELEVENLABS_BASE_URL: stub.url,
      CLAVE_E2E_SPOKEN_REPLY: '<spoken>Spoken text.</spoken>'
    },
    null,
    { server: 'in-process' }
  )
  const { win } = chat
  try {
    await setUpVoice(win)
    const view = win.locator('[data-testid="folio-view"]')
    await view.locator('textarea[aria-label="Message"]').waitFor()
    await stubPlayback(win)

    // ── (a) The server's ElevenLabs voice reads the page ──
    await ask(view, 'tell me about the weather in brussels please')
    await view.getByRole('button', { name: 'Read it to me' }).click()
    const played = await until(
      async () => {
        const urls = await win.evaluate(() => window.__played)
        return urls.length ? urls : null
      },
      { tries: 100, gapMs: 50 }
    )
    assert.ok(played, 'an audio element played')
    t.check(
      'one part played, from a Blob URL',
      played.length === 1 && /^blob:/.test(played[0]),
      played
    )
    // The read ends once the part has played.
    const control = view.locator('.folio-foot .folio-read')
    await until(async () => ((await control.getAttribute('data-phase')) === null ? true : null), {
      tries: 60,
      gapMs: 50
    })
    const titles = await win.evaluate(() => window.__titles)
    const preparing = titles.indexOf('Preparing the spoken version…')
    const reading = titles.indexOf('Reading with ElevenLabs')
    t.check(
      'the control prepared, then read with ElevenLabs',
      preparing >= 0 && reading > preparing,
      titles
    )
    const speaks = stub.seen.filter(
      (r) => r.method === 'POST' && r.pathname === '/v1/text-to-speech/voice-b'
    )
    t.check('ElevenLabs was asked once, for the chosen voice', speaks.length === 1, stub.seen)
    t.equal('for the spoken text', speaks[0]?.body?.text, 'Spoken text.')
    t.equal('with the pasted key, in its header', speaks[0]?.key, GOOD)
    t.equal('on the chosen model', speaks[0]?.body?.model_id, 'eleven_flash_v2_5')
    t.equal('the system voice said nothing', (await win.evaluate(() => window.__spoken)).length, 0)
    t.check(
      'the window never saw the key',
      !JSON.stringify(await win.evaluate(() => window.electronAPI.integrationsRead())).includes(
        GOOD
      )
    )

    // ── (c) The credits spent: the system voice reads, and the control says why ──
    stub.state.quota = true
    await win.evaluate(() => {
      window.__titles = []
    })
    await ask(view, 'and what about tomorrow in ghent')
    const second = view.locator('.folio-foot .folio-read')
    await until(async () => ((await second.count()) ? true : null))
    await view.getByRole('button', { name: 'Read it to me' }).click()
    const spoken = await until(
      async () => {
        const said = await win.evaluate(() => window.__spoken)
        return said.length ? said : null
      },
      { tries: 100, gapMs: 50 }
    )
    t.check(
      'the system voice read the spoken version',
      JSON.stringify(spoken) === '["Spoken text."]',
      spoken
    )
    const why = await until(async () => {
      const seen = await win.evaluate(() => window.__titles)
      return seen.find((line) => line.includes('credits')) ?? null
    })
    t.equal(
      'the control says the credits are spent',
      why,
      'Reading with the system voice: the ElevenLabs credits are spent'
    )
    const after = await until(async () => {
      const line = await second.getAttribute('title')
      return line?.startsWith('Read with the system voice') ? line : null
    })
    t.equal(
      'and says it once read',
      after,
      'Read with the system voice: the ElevenLabs credits are spent'
    )
    t.equal('no second audio played', (await win.evaluate(() => window.__played)).length, 1)
  } finally {
    await chat.close()
    await stub.close()
  }
}
