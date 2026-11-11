import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchApp, seedWorkspaces, userDataDir, fixturePath, until } from './harness.mjs'

// Settings → Integrations on this Mac (PRDCT-4410): a pasted ElevenLabs key
// is sealed on the machine, checked against the account at once, and never
// written in the clear; the voice chosen holds across a reload; Remove
// forgets it; a refused key is kept and says so. ElevenLabs is a stub on a
// local port (`CLAVE_ELEVENLABS_BASE_URL`): nothing here reaches the
// service, and every key is invented. The page is this Mac's, so the spec
// runs in-process, where this Mac's settings are filed in the app's folder.

const DIR = userDataDir('settings-integrations')
const ROOT = fixturePath('settings-integrations-root')
const FILE = path.join(DIR, 'integrations.json')
const GOOD = 'xi-test-good'
const BAD = 'xi-bad'
const WS = {
  id: 'integrations-ws',
  name: 'Integrations',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const VOICES = [
  {
    voice_id: 'voice-a',
    name: 'Ada',
    category: 'premade',
    labels: { accent: 'british', use_case: 'narration' },
    preview_url: null
  },
  {
    voice_id: 'voice-b',
    name: 'Basil',
    category: 'premade',
    labels: { accent: 'american' },
    preview_url: null
  }
]

/** The stub: the account for the good key, 401 for any other; two voices.
 *  While `held` is set, the account answers wait until `release()`. */
function startStub() {
  const seen = []
  const waiting = []
  const state = { held: false }
  const server = createServer((req, res) => {
    const key = req.headers['xi-api-key']
    const { pathname } = new URL(req.url, 'http://stub')
    seen.push({ pathname, key })
    const json = (status, body) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (key !== GOOD) return json(401, { detail: { status: 'invalid_api_key' } })
    if (pathname === '/v1/user/subscription') {
      const answer = () =>
        json(200, {
          tier: 'creator',
          character_count: 1200,
          character_limit: 100000,
          status: 'active'
        })
      if (state.held) return waiting.push(answer)
      return answer()
    }
    if (pathname === '/v2/voices') return json(200, { voices: VOICES, has_more: false })
    return json(404, {})
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        state,
        waiting,
        release: () => {
          state.held = false
          for (const answer of waiting.splice(0)) answer()
        },
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

async function openIntegrations(win) {
  await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
  await win.locator('[data-settings-nav-row="integrations"]').click()
  const page = win.locator('[data-settings-page="integrations"]')
  await page.waitFor()
  const card = page.locator('[data-integration="elevenlabs"]')
  await card.waitFor()
  return { page, card }
}

/** Pick an option of a settings select; the menu animates in, so the open is waited for. */
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

const fileText = () => (existsSync(FILE) ? readFileSync(FILE, 'utf-8') : '')
const textOf = async (locator) => ((await locator.textContent()) ?? '').trim()

async function paste(card, key) {
  const field = card.locator('[data-testid="elevenlabs-key-input"]')
  await field.waitFor()
  await field.fill(key)
  await card.locator('[data-testid="elevenlabs-key-save"]').click()
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  const stub = await startStub()
  const errors = []
  const { app, win } = await launchApp(DIR, {
    env: { CLAVE_ELEVENLABS_BASE_URL: stub.url },
    server: 'in-process'
  })
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    let { card } = await openIntegrations(win)
    const field = card.locator('[data-testid="elevenlabs-key-input"]')
    t.equal('the field is a password field', await field.getAttribute('type'), 'password')
    t.equal('nothing fills it in', await field.inputValue(), '')

    // ── The good key: sealed, checked at once ──
    await paste(card, GOOD)
    const account = card.locator('[data-testid="elevenlabs-account"]')
    const line = await until(async () =>
      (await account.count()) ? (await textOf(account)) || null : null
    )
    t.check('the card shows the tier', /creator/.test(line ?? ''), line)
    t.check(
      'and the characters of the period',
      (line ?? '').includes('1,200 of 100,000 characters'),
      line
    )
    t.check(
      'the account was asked with the key, in the header',
      stub.seen.some((r) => r.pathname === '/v1/user/subscription' && r.key === GOOD),
      stub.seen
    )
    t.check('the document exists', existsSync(FILE), FILE)
    t.check('the stored document does not hold the key', !fileText().includes(GOOD))
    const status = await win.evaluate(() => window.electronAPI.integrationsRead())
    t.check('the window reads no key back', !JSON.stringify(status).includes(GOOD))
    t.equal('the field is gone once a key is set', await field.count(), 0)

    // ── A voice, held across a reload ──
    const voiceSelect = card.locator('[data-settings-select="elevenlabs-voice"]')
    await voiceSelect.waitFor()
    await until(async () => !(await voiceSelect.isDisabled()))
    await pick(win, voiceSelect, /^Basil/)
    await until(async () => (await voiceSelect.getAttribute('data-value')) === 'voice-b')
    t.equal('the select shows the pick', await voiceSelect.getAttribute('data-value'), 'voice-b')
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    ;({ card } = await openIntegrations(win))
    const reloaded = card.locator('[data-settings-select="elevenlabs-voice"]')
    await reloaded.waitFor()
    const held = await until(async () =>
      (await reloaded.getAttribute('data-value')) === 'voice-b' ? 'voice-b' : null
    )
    t.equal('the voice holds after a reload', held, 'voice-b')
    t.check(
      'its label is the voice and its labels',
      /Basil · american/.test(await textOf(reloaded)),
      await textOf(reloaded)
    )

    // ── Remove: the field is back, the document forgets it ──
    await card.locator('[data-testid="elevenlabs-remove"]').click()
    await card.locator('[data-testid="elevenlabs-key-input"]').waitFor()
    t.check(
      'the field is back',
      (await card.locator('[data-testid="elevenlabs-key-input"]').count()) === 1
    )
    const afterRemove = JSON.parse(fileText() || '{}')
    t.check('the document has no ElevenLabs entry', !('elevenLabs' in afterRemove), afterRemove)

    // ── Remove while the account is being checked: the Remove wins ──
    // (verifier round 2: the check used to write its stale copy back, and
    // the key came back configured.) The card waits on the save's check, so
    // the Remove goes through the window's own bridge, as a second window
    // or the speech's own check would race it.
    stub.state.held = true
    const asked = stub.seen.length
    await paste(card, GOOD)
    const holding = await until(
      async () => (stub.waiting.length && stub.seen.length > asked ? true : null),
      { tries: 100, gapMs: 50 }
    )
    t.check('the save is checking the account', holding === true, stub.seen.slice(asked))
    const removedMidCheck = await win.evaluate(() => window.electronAPI.elevenLabsRemove())
    t.equal('the Remove answers not configured', removedMidCheck?.elevenLabs?.configured, false)
    stub.release()
    await win.waitForTimeout(6000)
    const raced = await win.evaluate(() => window.electronAPI.integrationsRead())
    t.equal('6 s later the key is still removed', raced?.elevenLabs?.configured, false)
    const raceFile = JSON.parse(fileText() || '{}')
    t.check('the document still has no ElevenLabs entry', !('elevenLabs' in raceFile), raceFile)
    t.equal(
      'the card stays unconfigured: the field is there',
      await card.locator('[data-testid="elevenlabs-key-input"]').count(),
      1
    )

    // ── A refused key: kept, said, Replace offered ──
    await paste(card, BAD)
    const refused = card.locator('[data-testid="elevenlabs-check-error"]')
    const said = await until(async () =>
      (await refused.count()) ? (await textOf(refused)) || null : null
    )
    t.equal('the refusal is said', said, 'The key was refused by ElevenLabs.')
    t.check('the key stays stored', JSON.parse(fileText()).elevenLabs?.sealed !== undefined)
    t.check('and not in the clear', !fileText().includes(BAD))
    t.equal(
      'Replace is offered',
      await card.locator('[data-testid="elevenlabs-replace"]').count(),
      1
    )
    t.check('no page error', errors.length === 0, errors)
  } finally {
    await app.close()
    await stub.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
