// Folio's voice and the Integrations card, looked at (PRDCT-4409, 4410, 4411,
// 4412, 4430): the real built app in the four skins, every state of this
// lane's surfaces put on screen and shot, and a contact sheet that shows them
// all with their captions, so the owner opens one file:
//
//   - the page head while its title is written (the loader), and the title
//     caught mid-reveal (the animation frames held: the page's own
//     requestAnimationFrame is stubbed for the length of the shot);
//   - the read control preparing the spoken version; the player playing with
//     block 3 lit and the bar on tick 3; the player paused; the read control
//     once a page was read by the system voice (its hover title in the
//     caption: a native tooltip is drawn by the OS, never in a screenshot);
//   - Settings → Integrations: the card empty, checked, with a voice chosen,
//     and the Preview playing.
//
// And folio.css is held to the tokens at module scope: no literal colour, no
// literal size or duration (a container query's width is the one exception:
// a custom property cannot go there).
//
// ElevenLabs is a stub on a local port (CLAVE_ELEVENLABS_BASE_URL), every
// key is invented, and the page's audio and system voice are stubbed. The
// screenshots are written to a temporary folder outside the repository and
// never committed: FOLIO_VOICE_LOOK_DIR, or /tmp/folio-voice-look.
//
//   npm run build && node tests/visual/folio-voice.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChat } from '../e2e/chat-view.spec.mjs'
import { fixturePath, launchApp, seedWorkspaces, until, userDataDir } from '../e2e/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.FOLIO_VOICE_LOOK_DIR || '/tmp/folio-voice-look'
const SKINS = ['dark', 'light', 'coffee', 'charcoal']
const SILENCE = readFileSync(path.join(HERE, '..', 'e2e', 'fixtures', 'silence-1s.mp3'))
const GOOD = 'xi-test-folio-look'

// ── The token audit of folio.css ──
{
  const css = readFileSync(
    new URL('../../plugins/chat-view/src/lab/folio.css', import.meta.url),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('@container'))
    .join('\n')
  const literal = css.match(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|\b\d+(?:\.\d+)?(?:px|rem|ms)\b/gi)
  assert.equal(
    literal,
    null,
    `folio.css uses tokens, never a literal colour, size or duration: ${literal}`
  )
  console.log('PASS folio.css: no literal colour, size or duration')
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
/** Every shot, in the order the sheet shows them. */
const shots = []

/** The stub: the account and the voices for the good key, a voice's own
 *  record with its preview on the stub, and speech as a second of silence. */
function startStub() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://stub')
      const base = `http://127.0.0.1:${server.address().port}`
      const json = (status, value) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (pathname === '/preview/sample.mp3')
        return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(SILENCE)
      if (req.headers['xi-api-key'] !== GOOD)
        return json(401, { detail: { status: 'invalid_api_key' } })
      if (pathname === '/v1/user/subscription')
        return json(200, { tier: 'creator', character_count: 41250, character_limit: 100000 })
      const voices = [
        {
          voice_id: 'voice-a',
          name: 'Ada',
          category: 'premade',
          labels: { accent: 'british', use_case: 'narration' },
          preview_url: `${base}/preview/sample.mp3`
        },
        {
          voice_id: 'voice-b',
          name: 'Basil',
          category: 'premade',
          labels: { accent: 'american' },
          preview_url: `${base}/preview/sample.mp3`
        }
      ]
      if (pathname === '/v2/voices') return json(200, { voices, has_more: false })
      const one = /^\/v1\/voices\/([^/]+)$/.exec(pathname)
      if (one) return json(200, voices.find((v) => v.voice_id === one[1]) ?? {})
      if (req.method === 'POST' && /^\/v1\/text-to-speech\/[^/]+(\/stream)?$/.test(pathname))
        return res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(SILENCE)
      return json(404, {})
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

/** The page's audio and system voice, stubbed: an element plays and never
 *  ends by itself (the player stays where it is put); the system voice speaks
 *  each utterance for a quarter of a second. */
async function stubPlayback(win) {
  await win.evaluate(() => {
    HTMLMediaElement.prototype.play = () => Promise.resolve()
    HTMLMediaElement.prototype.pause = () => undefined
    const stub = {
      speaking: false,
      pending: false,
      paused: false,
      speak(utterance) {
        setTimeout(() => {
          utterance.onstart?.()
          setTimeout(() => utterance.onend?.(), 250)
        }, 10)
      },
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Shoot `locator` in each skin, filed under `name`, with its caption. The
 *  skin's own transitions are let settle first. Polled on a timer, never on
 *  animation frames, which a shot may be holding. */
async function shoot(win, name, locator, caption) {
  const files = []
  for (const skin of SKINS) {
    await win.evaluate((skin) => window.electronAPI.skinsActivate(skin), skin)
    await win.waitForFunction((skin) => localStorage.getItem('clave-theme') === skin, skin, {
      polling: 50
    })
    await pause(450)
    const bytes = await locator.screenshot({ animations: 'allow' })
    assert.ok(bytes.length > 1000, `${name} ${skin}: the shot is not empty`)
    const file = `${name}-${skin}.png`
    writeFileSync(path.join(OUT, file), bytes)
    files.push({ skin, file })
  }
  shots.push({ name, caption, files })
  console.log(`SHOT ${name}`)
}

// ── Folio: the head, the reveal, the read control and the player ──
const QUESTION = [
  'Walk me through how a build gets from beta to the stable channel.',
  'The release job tags the commit, and the **build** runs once for every platform.',
  'The beta channel gets it first; nothing reaches stable until it has run there for a week.',
  'Promoting it moves the same files: nothing is built twice.'
].join('\n\n')
const WRITTEN = 'How a build reaches stable'
/** A second page, as many blocks as the first, so the spoken reply fits it. */
const SECOND = [
  'And what happens when a beta build turns out to be broken?',
  'The channel is pointed back at the last good build.',
  'Nobody on beta has to reinstall: the next check offers it again.',
  'The broken build stays tagged, for the record.'
].join('\n\n')
const SECOND_REPLY = `<spoken>${SECOND.split('\n\n')
  .map((text, i) => `<b n="${i + 1}">${text}</b>`)
  .join('\n')}</spoken>`
const SPOKEN = [
  'Walk me through how a build gets from beta to the stable channel.',
  'The release job tags the commit, and the build runs once for every platform.',
  'The beta channel gets it first, and nothing reaches stable until it has run there for a week.',
  'Promoting it moves the same files. Nothing is built twice.'
]
const REPLY = `<spoken>${SPOKEN.map((text, i) => `<b n="${i + 1}">${text}</b>`).join('\n')}</spoken>`
{
  const stub = await startStub()
  const chat = await openChat(
    'folio-voice-look',
    ['--dev-echo-view=clave.chat-view/lab'],
    '[data-testid="folio-view"] textarea:not(:disabled)',
    {
      CLAVE_ELEVENLABS_BASE_URL: stub.url,
      CLAVE_E2E_SPOKEN_REPLY: REPLY,
      CLAVE_E2E_PAGE_TITLE_REPLY: WRITTEN,
      // The title and the spoken version take their time, so the loader and
      // the Preparing control are on screen long enough to be shot in four
      // skins.
      CLAVE_E2E_READ_BEAT_MS: '9000'
    },
    null,
    { server: 'in-process' }
  )
  const { app, win } = chat
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 860))
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    const view = win.locator('[data-testid="folio-view"]')
    await stubPlayback(win)
    await win.evaluate(async (key) => {
      await window.electronAPI.elevenLabsSetKey(key)
      await window.electronAPI.elevenLabsSetVoice('voice-a', 'Ada', undefined)
    }, GOOD)
    const input = view.locator('textarea[aria-label="Message"]')
    await input.fill(QUESTION)
    await input.press('Enter')

    // The head while the title is written: the loader after the stand-in.
    const head = view.locator('.folio-page .folio-head')
    await head.locator('.folio-loader').waitFor()
    await shoot(
      win,
      'head-loader',
      head,
      'The page head while its title is written: the stand-in (the question’s first sentence) and the loader after it, the pen going back over a line.'
    )

    // The title mid-reveal: the page's animation frames held, so the frame on
    // screen stays until it is shot; then let go.
    await win.evaluate(() => {
      const queue = []
      let id = 0
      window.__realRaf = window.requestAnimationFrame
      window.__realCaf = window.cancelAnimationFrame
      window.requestAnimationFrame = (cb) => {
        queue.push({ id: ++id, cb, at: performance.now() })
        return id
      }
      window.cancelAnimationFrame = (gone) => {
        const at = queue.findIndex((entry) => entry.id === gone)
        if (at >= 0) queue.splice(at, 1)
      }
      window.__rafStep = (ms) => {
        for (const entry of queue.splice(0)) entry.cb(entry.at + ms)
      }
      window.__rafRelease = () => {
        window.requestAnimationFrame = window.__realRaf
        window.cancelAnimationFrame = window.__realCaf
        for (const entry of queue.splice(0)) window.requestAnimationFrame(entry.cb)
      }
    })
    const title = head.locator('h2.folio-title')
    const revealing = await until(
      async () => ((await title.getAttribute('data-revealing')) === 'true' ? true : null),
      { tries: 300, gapMs: 50 }
    )
    assert.ok(revealing, 'the written title is revealed in place')
    await win.evaluate(() => window.__rafStep(230))
    await head.locator('.folio-title-pen').waitFor()
    await shoot(
      win,
      'title-reveal',
      head,
      `The title held mid-reveal (230 of 420 ms): “${WRITTEN}” inked in over the stand-in, the last characters still wet behind the pen, the pen’s line under them.`
    )
    await win.evaluate(() => window.__rafRelease())
    await until(
      async () =>
        (await title.getAttribute('data-revealing')) === null &&
        (await title.innerText()).trim() === WRITTEN
          ? true
          : null,
      { tries: 100, gapMs: 50 }
    )

    // The read control preparing the spoken version.
    const page = view.locator('.folio-page')
    const foot = page.locator('.folio-foot')
    const read = foot.locator('.folio-read')
    await read.waitFor()
    await read.click()
    await foot.locator('.folio-read[data-phase="preparing"] .folio-loader').waitFor()
    const preparingTitle = await foot.locator('.folio-read').getAttribute('title')
    await shoot(
      win,
      'read-preparing',
      foot,
      `The read control while the spoken version is prepared: Preparing and the loader; a click stops it. Hover title: “${preparingTitle}”.`
    )

    // The player: block 3 lit, the bar on tick 3.
    const lit = () =>
      page
        .locator('.folio-block[data-reading="true"]')
        .evaluateAll((els) => (els.length === 1 ? Number(els[0].dataset.block) : null))
    assert.ok(
      await until(async () => ((await lit()) === 1 ? true : null), { tries: 300, gapMs: 50 }),
      'the reading starts on block 1'
    )
    await page.locator('.folio-block[data-block="3"]').click()
    assert.ok(
      await until(async () => ((await lit()) === 3 ? true : null), { tries: 100, gapMs: 50 }),
      'a click on block 3 reads from it'
    )
    await page.hover({ position: { x: 4, y: 4 } })
    const playingTitle = await foot.locator('.folio-read').getAttribute('title')
    await shoot(
      win,
      'player-playing',
      view.locator('.folio-sheet'),
      `The player playing with block 3 lit (a wash of the accent and the pen’s rule in the margin) and the bar on tick 3 (the ringed dot where the voice is). Hover title: “${playingTitle}”.`
    )
    await shoot(win, 'player-playing-foot', foot, 'The same player, the foot alone, at full size.')

    // Paused.
    const play = foot.locator('[data-testid="folio-play"]')
    await play.click()
    await until(async () => ((await play.getAttribute('data-state')) === 'paused' ? true : null), {
      tries: 60,
      gapMs: 50
    })
    await page.hover({ position: { x: 4, y: 4 } })
    await shoot(win, 'player-paused', foot, 'The player paused: Play offered, block 3 still lit.')

    // The system voice: Stop, the key removed, a second page read (the first
    // page's parts are kept, and would play again without asking).
    await foot.locator('[data-testid="folio-stop"]').click()
    await win.evaluate(() => window.electronAPI.elevenLabsRemove())
    // Its own spoken words: a part already heard is kept by its words, and
    // would play again in the ElevenLabs voice without asking. The server is
    // in this process, and reads the reply at each ask.
    await app.evaluate((_electron, reply) => {
      process.env.CLAVE_E2E_SPOKEN_REPLY = reply
    }, SECOND_REPLY)
    await input.fill(SECOND)
    await input.press('Enter')
    const second = view.locator('.folio-page[aria-label^="Page 2"]')
    const secondFoot = second.locator('.folio-foot')
    await secondFoot.locator('.folio-read').waitFor({ timeout: 30000 })
    await secondFoot.getByRole('button', { name: 'Read aloud' }).click()
    const note = await until(
      async () => {
        const control = secondFoot.locator('.folio-read')
        if ((await control.getAttribute('data-phase')) !== null) return null
        const said = await control.getAttribute('title')
        return said && /System voice/.test(said) ? said : null
      },
      { tries: 600, gapMs: 50 }
    )
    assert.ok(note, 'the read control says the page was read by the system voice')
    await secondFoot.locator('.folio-read').hover()
    await shoot(
      win,
      'system-voice',
      secondFoot,
      `The read control, hovered, once the page was read by the system voice. Its hover title: “${note}”.`
    )
  } finally {
    await chat.close()
    await stub.close()
  }
}

// ── Settings → Integrations: empty, checked, a voice chosen, the Preview ──
{
  const DIR = userDataDir('folio-voice-look-settings')
  const ROOT = fixturePath('folio-voice-look-settings-root')
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'look', name: 'Integrations', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'look',
    fresh: true
  })
  const stub = await startStub()
  const { app, win } = await launchApp(DIR, {
    env: { CLAVE_ELEVENLABS_BASE_URL: stub.url },
    server: 'in-process'
  })
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 860))
    await stubPlayback(win)
    await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await win.locator('[data-settings-nav-row="integrations"]').click()
    const settings = win.locator('[data-settings-page="integrations"]')
    const card = settings.locator('[data-integration="elevenlabs"]')
    await card.locator('[data-testid="elevenlabs-key-input"]').waitFor()
    const shell = win.locator('body')
    await pause(1200)
    await shoot(
      win,
      'integrations-empty',
      shell,
      'Settings → Integrations with no key: the figure (a page, the line being read, the voice leaving it as a wave to the ringed dot) beside the key field. The sidebar row wears its new icon.'
    )

    await card.locator('[data-testid="elevenlabs-key-input"]').fill(GOOD)
    await card.locator('[data-testid="elevenlabs-key-save"]').click()
    const voice = card.locator('[data-settings-select="elevenlabs-voice"]')
    await voice.waitFor()
    await until(async () => ((await voice.isDisabled()) ? null : true))
    await shoot(
      win,
      'integrations-checked',
      settings,
      'The key checked: the figure small and still, the plan as a chip, the period’s characters as a meter and in words; the voice not chosen yet, the model under it.'
    )

    for (let attempt = 0; attempt < 3; attempt++) {
      await voice.click()
      const item = win.getByRole('menuitem', { name: /^Ada/ })
      if (
        await item.waitFor({ state: 'visible', timeout: 1500 }).then(
          () => true,
          () => false
        )
      ) {
        await item.click()
        break
      }
      await win.keyboard.press('Escape')
    }
    await until(async () => ((await voice.getAttribute('data-value')) === 'voice-a' ? true : null))
    await pause(300)
    await shoot(win, 'integrations-voice', settings, 'A voice chosen: Ada, with its labels.')

    const preview = card.locator('[data-testid="elevenlabs-preview"]')
    await preview.click()
    await until(async () => ((await preview.getAttribute('data-playing')) === 'true' ? true : null))
    await preview.hover()
    await shoot(
      win,
      'integrations-preview',
      card,
      'The Preview playing: three of the spine’s ticks breathing in turn, and Stop.'
    )
  } finally {
    await app.close()
    await stub.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}

// ── The contact sheet ──
const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
writeFileSync(
  path.join(OUT, 'index.html'),
  `<!doctype html>
<meta charset="utf-8">
<title>Folio voice, the look</title>
<style>
  body { margin: 32px; font: 13px/1.5 -apple-system, system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  p.lede { margin: 0 0 32px; color: #52525b; }
  section { margin: 0 0 40px; }
  h2 { font-size: 14px; font-weight: 500; margin: 0 0 2px; }
  section > p { margin: 0 0 12px; color: #52525b; max-width: 80ch; }
  .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  figure { margin: 0; }
  figure img { display: block; max-width: 100%; border: 1px solid #d4d4d8; border-radius: 6px; }
  figcaption { margin-top: 4px; color: #71717a; font-size: 12px; }
</style>
<h1>Folio voice, the look</h1>
<p class="lede">The real built app, in the four skins. ${shots.length} states, written ${new Date().toISOString()} by tests/visual/folio-voice.mjs.</p>
${shots
  .map(
    (shot) => `<section>
  <h2>${escape(shot.name)}</h2>
  <p>${escape(shot.caption)}</p>
  <div class="row">
${shot.files
  .map(
    (f) =>
      `    <figure><img src="${f.file}" alt="${escape(shot.name)}, ${f.skin}"><figcaption>${f.skin}</figcaption></figure>`
  )
  .join('\n')}
  </div>
</section>`
  )
  .join('\n')}
`
)
console.log(`PASS ${shots.length} states in ${SKINS.length} skins: ${path.join(OUT, 'index.html')}`)
