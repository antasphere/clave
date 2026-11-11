import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

/* Folio's player (PRDCT-4430), on the real app with the echo adapter (the
   agent answers with the reader's own words, here four paragraphs, so the
   page has four blocks):
   - the spoken rendering comes back block by block (CLAVE_E2E_SPOKEN_REPLY
     carries four numbered blocks, read by the real parser against the four
     blocks the page sends);
   - with the server's ElevenLabs voice: play lights block 1 and ElevenLabs
     is asked for block 1's words; pause pauses the element and the control
     offers Play; resume plays the same part on, asking nothing new; a click
     on block 3 asks for block 3's words and lights block 3; the bar has one
     tick per block, and a click on its second tick moves the reading there;
   - with no key, the system voice reads block by block and the light
     follows it; a click on block 4 speaks from block 4.
   ElevenLabs is a stub on a local port (`CLAVE_ELEVENLABS_BASE_URL`) that
   answers a second of silence (the stub of folio-elevenlabs.spec.mjs); every
   key is invented. In the page, audio playback is stubbed: `play` records
   and never ends by itself, `pause` records. The ElevenLabs half is pinned
   in-process: the integration set is this Mac's, the same process that
   speaks. */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SILENCE = readFileSync(path.join(HERE, 'fixtures', 'silence-1s.mp3'))
const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const GOOD = 'xi-test-folio-player'
const VOICES = [{ voice_id: 'voice-a', name: 'Ada', category: 'premade', labels: {} }]
const ANSWER = [
  'First block of the answer.',
  'Second block of the answer.',
  'Third block of the answer.',
  'Fourth block of the answer.'
].join('\n\n')
const SPOKEN = ['one', 'two', 'three', 'four'].map((w) => `Block ${w} spoken.`)
const REPLY = `<spoken>${SPOKEN.map((text, i) => `<b n="${i + 1}">${text}</b>`).join('\n')}</spoken>`

function startStub() {
  const seen = []
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
      seen.push({ method: req.method, pathname, body })
      const json = (status, value) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (key !== GOOD) return json(401, { detail: { status: 'invalid_api_key' } })
      if (pathname === '/v1/user/subscription')
        return json(200, { tier: 'creator', character_count: 10, character_limit: 100000 })
      if (pathname === '/v2/voices') return json(200, { voices: VOICES, has_more: false })
      if (req.method === 'POST' && /^\/v1\/text-to-speech\/[^/]+(\/stream)?$/.test(pathname))
        return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(SILENCE)
      return json(404, {})
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        speaks: () => seen.filter((r) => r.method === 'POST').map((r) => r.body?.text),
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

/** The page's audio, stubbed: `play` records its source and never ends by
 *  itself, `pause` records; the system voice speaks each utterance for
 *  `utteranceMs` and records it. */
async function stubPlayback(win, utteranceMs) {
  await win.evaluate((ms) => {
    window.__played = []
    window.__paused = 0
    window.__spoken = []
    window.__cancels = 0
    HTMLMediaElement.prototype.play = function play() {
      window.__played.push(this.src)
      return Promise.resolve()
    }
    HTMLMediaElement.prototype.pause = function pause() {
      window.__paused += 1
    }
    const stub = {
      speaking: false,
      pending: false,
      paused: false,
      speak(utterance) {
        window.__spoken.push(utterance.text)
        const at = window.__spoken.length
        const startAt = (window.__voiceFree ?? 0) > Date.now() ? window.__voiceFree : Date.now()
        window.__voiceFree = startAt + ms
        setTimeout(
          () => {
            if (window.__cancelledBefore >= at) return
            utterance.onstart?.()
            setTimeout(() => {
              if (window.__cancelledBefore >= at) return
              utterance.onend?.()
            }, ms - 20)
          },
          startAt - Date.now() + 10
        )
      },
      cancel() {
        window.__cancels += 1
        window.__cancelledBefore = window.__spoken.length
        window.__voiceFree = 0
      },
      pause: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true })
  }, utteranceMs)
}

async function ask(view, text) {
  const input = view.locator('textarea[aria-label="Message"]')
  await input.fill(text)
  await input.press('Enter')
}

/** The block lit on the page, or null. */
const litBlock = (view) =>
  view
    .locator('.folio-block[data-reading="true"]')
    .evaluateAll((els) => (els.length === 1 ? Number(els[0].dataset.block) : null))

async function waitLit(view, n, tries = 100) {
  return until(async () => ((await litBlock(view)) === n ? true : null), { tries, gapMs: 50 })
}

async function pageReady(view) {
  const read = view.locator('.folio-foot .folio-read')
  await until(async () => ((await read.count()) ? true : null))
  return until(async () => {
    const n = await view.locator('.folio-page .folio-block').count()
    return n === 4 ? true : null
  })
}

export async function run(t) {
  // ── The server's ElevenLabs voice ──
  {
    const stub = await startStub()
    const chat = await openChat(
      'folio-player',
      FOLIO,
      READY,
      { CLAVE_ELEVENLABS_BASE_URL: stub.url, CLAVE_E2E_SPOKEN_REPLY: REPLY },
      null,
      { server: 'in-process' }
    )
    const { win } = chat
    try {
      const view = win.locator('[data-testid="folio-view"]')
      await view.locator('textarea[aria-label="Message"]').waitFor()
      await stubPlayback(win, 600)
      await win.evaluate(
        async ([key]) => {
          await window.electronAPI.elevenLabsSetKey(key)
          await window.electronAPI.elevenLabsSetVoice('voice-a', 'Ada', undefined)
        },
        [GOOD]
      )
      await ask(view, ANSWER)
      assert.ok(await pageReady(view), 'the page shows its four blocks')
      t.equal(
        'the page renders one element per block, numbered 1 to 4',
        JSON.stringify(
          await view
            .locator('.folio-page .folio-block')
            .evaluateAll((els) => els.map((el) => el.dataset.block))
        ),
        '["1","2","3","4"]'
      )

      await view.getByRole('button', { name: 'Read it to me' }).click()
      const played = await until(
        async () => {
          const urls = await win.evaluate(() => window.__played)
          return urls.length ? urls : null
        },
        { tries: 100, gapMs: 50 }
      )
      assert.ok(played, 'an audio element played')
      t.check('play lights block 1', !!(await waitLit(view, 1)), await litBlock(view))
      t.equal("ElevenLabs was asked for block 1's words first", stub.speaks()[0], SPOKEN[0])
      const play = view.locator('[data-testid="folio-play"]')
      t.equal(
        'the control offers Pause while playing',
        await play.getAttribute('data-state'),
        'playing'
      )
      t.equal(
        'the scrub bar has one tick per block',
        await view.locator('[data-testid="folio-scrub-tick"]').count(),
        4
      )

      // Pause: the element pauses and the control offers Play.
      // The next part is asked as the first plays: let it come back first.
      await until(async () => (stub.speaks().length >= 2 ? true : null), { tries: 60, gapMs: 50 })
      const asked = stub.speaks().length
      const pausedBefore = await win.evaluate(() => window.__paused)
      await play.click()
      await until(
        async () => ((await play.getAttribute('data-state')) === 'paused' ? true : null),
        {
          tries: 40,
          gapMs: 25
        }
      )
      t.check(
        'pause pauses the element',
        (await win.evaluate(() => window.__paused)) > pausedBefore
      )
      t.equal(
        'and the control offers Play',
        (await play.innerText()).trim().split('\n')[0].trim(),
        'Play'
      )
      t.equal('block 1 stays lit while paused', await litBlock(view), 1)

      // Resume: the same part plays on, nothing new asked.
      await play.click()
      const resumed = await until(
        async () => {
          const urls = await win.evaluate(() => window.__played)
          return urls.length === 2 ? urls : null
        },
        { tries: 40, gapMs: 25 }
      )
      t.check('resume plays the same part on', !!resumed && resumed[1] === resumed[0], resumed)
      t.equal('resume asks ElevenLabs for nothing new', stub.speaks().length, asked)
      t.equal('the control offers Pause again', await play.getAttribute('data-state'), 'playing')

      // A click on block 3 reads from block 3.
      await view.locator('.folio-page .folio-block[data-block="3"]').click()
      const third = await until(async () => (stub.speaks().includes(SPOKEN[2]) ? true : null), {
        tries: 100,
        gapMs: 50
      })
      t.check("a click on block 3 asks for block 3's words", !!third, stub.speaks())
      t.check('and lights block 3', !!(await waitLit(view, 3)), await litBlock(view))
      const afterThree = await win.evaluate(() => window.__played.length)
      t.check('a new part played', afterThree >= 3, afterThree)

      // The bar: a click on its second tick moves the reading to block 2.
      const bar = view.locator('[data-testid="folio-scrub"]')
      const box = await bar.boundingBox()
      assert.ok(box, 'the bar is on screen')
      await win.mouse.click(box.x + box.width * 0.375, box.y + box.height / 2)
      t.check(
        'a click on the second tick lights block 2',
        !!(await waitLit(view, 2)),
        await litBlock(view)
      )

      // Stop: nothing lit, the control reads again.
      await view.locator('[data-testid="folio-stop"]').click()
      await until(async () => ((await litBlock(view)) === null ? true : null), {
        tries: 40,
        gapMs: 25
      })
      t.equal('stop lights nothing', await litBlock(view), null)
      t.check(
        'and the control offers to read again',
        (await view.getByRole('button', { name: 'Read it to me' }).count()) === 1
      )
    } finally {
      await chat.close()
      await stub.close()
    }
  }

  // ── No key: the system voice reads block by block ──
  {
    const chat = await openChat('folio-player-system', FOLIO, READY, {
      CLAVE_E2E_SPOKEN_REPLY: REPLY
    })
    const { win } = chat
    try {
      const view = win.locator('[data-testid="folio-view"]')
      await view.locator('textarea[aria-label="Message"]').waitFor()
      await stubPlayback(win, 900)
      await ask(view, ANSWER)
      assert.ok(await pageReady(view), 'the page shows its four blocks')
      await view.getByRole('button', { name: 'Read it to me' }).click()
      const spoken = await until(
        async () => {
          const said = await win.evaluate(() => window.__spoken)
          return said.length ? said : null
        },
        { tries: 100, gapMs: 50 }
      )
      t.equal(
        'the system voice is given each block as its own utterance',
        JSON.stringify(spoken),
        JSON.stringify(SPOKEN)
      )
      t.check('the system voice lights block 1', !!(await waitLit(view, 1)), await litBlock(view))
      t.check(
        'and the light follows it to block 2',
        !!(await waitLit(view, 2, 60)),
        await litBlock(view)
      )
      await view.locator('.folio-page .folio-block[data-block="4"]').click()
      const fourth = await until(
        async () => {
          const said = await win.evaluate(() => window.__spoken)
          return said.at(-1) === SPOKEN[3] && said.length > 4 ? said : null
        },
        { tries: 60, gapMs: 50 }
      )
      t.check('a click on block 4 speaks from block 4', !!fourth, fourth)
      t.check('and lights block 4', !!(await waitLit(view, 4)), await litBlock(view))
      t.equal(
        'the bar has four ticks on the system voice too',
        await view.locator('[data-testid="folio-scrub-tick"]').count(),
        4
      )
    } finally {
      await chat.close()
    }
  }
}
