// Settings → Connections as a page of cards (PRDCT-4552), drawn for the
// owner's eye: the empty page, then two Claude accounts and three stored
// connections of two providers (two Moonshot, one without its key, and one
// DeepSeek), in the light and the dark theme, at the usual width and at a
// narrow one; a card's models unfolded, the connect form open in a card, a
// removal's question, and a Clave server's page. Every key, token and figure
// is made up; nothing reaches a provider or models.dev. The pictures go to
// CLAVE_E2E_SHOTS (default /tmp/harness-next/cards/shots), each named by
// what it shows; the checks are what the pictures cannot say.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { until } from './harness.mjs'
import { connectMac, fleetWorld, openServersPage, request } from './fixtures/fleet-world.mjs'

const SHOTS = process.env.CLAVE_E2E_SHOTS || '/tmp/harness-next/cards/shots'
const WORK_TOKEN = 'sk-ant-oat01-work-token-for-the-cards-shots-0123456789abcdef'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-for-the-cards-shots-0123456789abcdef'
const KIMI_KEY = 'sk-test-cards-kimi-' + 'k'.repeat(32)
const DEEPSEEK_KEY = 'sk-test-cards-deepseek-' + 'd'.repeat(32)

const model = (id, name) => ({ id, name, reasoning: true, toolCall: true })
const CATALOGUE = {
  fetchedAt: Date.now(),
  providers: [
    {
      id: 'kimi-code-plan-global',
      name: 'Kimi For Coding',
      env: ['KIMI_API_KEY'],
      models: [
        model('kimi-a', 'Kimi Coder'),
        model('kimi-b', 'Kimi Coder Thinking'),
        model('kimi-c', 'Kimi Turbo'),
        model('kimi-d', 'Kimi Long Context'),
        model('kimi-e', 'Kimi Mini'),
        model('kimi-f', 'Kimi Vision')
      ]
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      env: ['DEEPSEEK_API_KEY'],
      models: [model('ds-chat', 'DeepSeek Chat'), model('ds-reasoner', 'DeepSeek Reasoner')]
    },
    {
      id: 'zai-coding-plan',
      name: 'Z.ai Coding Plan',
      env: ['ZAI_API_KEY'],
      models: [model('glm-a', 'GLM Coder'), model('glm-b', 'GLM Air'), model('glm-c', 'GLM Flash')]
    },
    {
      id: 'mistral',
      name: 'Mistral',
      env: ['MISTRAL_API_KEY'],
      models: [
        model('m-a', 'Devstral'),
        model('m-b', 'Codestral'),
        model('m-c', 'Mistral Large'),
        model('m-d', 'Mistral Medium'),
        model('m-e', 'Mistral Small')
      ]
    },
    {
      id: 'minimax-coding-plan',
      name: 'MiniMax Coding Plan',
      env: ['MINIMAX_API_KEY'],
      models: [model('mm-a', 'MiniMax M')]
    },
    {
      id: 'alibaba-coding-plan',
      name: 'Alibaba Coding Plan',
      env: ['ALIBABA_CODING_PLAN_API_KEY'],
      models: [model('q-a', 'Qwen Coder Plus'), model('q-b', 'Qwen Coder Flash')]
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      env: ['OPENROUTER_API_KEY'],
      models: Array.from({ length: 9 }, (_, i) => model(`or-${i}`, `Router model ${i + 1}`))
    },
    {
      id: 'vercel',
      name: 'Vercel AI Gateway',
      env: ['AI_GATEWAY_API_KEY'],
      models: Array.from({ length: 7 }, (_, i) => model(`v-${i}`, `Gateway model ${i + 1}`))
    }
  ]
}

// Twenty-four pictures, each with the window resized under it.
export const deadlineMs = 8 * 60_000

const WIDE = { width: 1320, height: 900 }
const NARROW = { width: 860, height: 900 }

async function setSize(app, { width, height }) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(size.width, size.height)
    },
    { width, height }
  )
}

/** The app's own skin switch (Settings → Appearance's), not an attribute
 *  set by hand: a skin's tokens are applied on the root. */
async function setTheme(win, theme) {
  await win.evaluate((t) => window.electronAPI.skinsActivate(t), theme)
  await until(
    async () => (await win.evaluate(() => document.documentElement.dataset.theme)) === theme
  )
  await win.waitForTimeout(200)
}

/** The whole page: the window made as tall as the page, then put back. */
async function shootPage(app, win, name, size) {
  const height = await win.evaluate(() => {
    const scroller = document.querySelector('.settings-scroller')
    return scroller ? scroller.scrollHeight + 120 : 1200
  })
  await setSize(app, { width: size.width, height: Math.min(Math.max(height, size.height), 7000) })
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await setSize(app, size)
  await win.waitForTimeout(200)
}

async function shootEach(app, win, label, shoot) {
  for (const theme of ['light', 'dark']) {
    for (const [width, size] of [
      ['usual', WIDE],
      ['narrow', NARROW]
    ]) {
      await setTheme(win, theme)
      await setSize(app, size)
      await win.waitForTimeout(300)
      await shoot(`${label}--${theme}-${width}`, size)
    }
  }
}

/** A card in the middle of the pane, clear of the page's sticky header. */
async function centre(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }))
}

/** Pick a machine in the settings sidebar's picker (as `fleet-settings-machine`). */
async function pickMachine(win, name, value) {
  const picker = win.locator('[data-settings-select="settings-machine"]')
  const item = win.getByRole('menuitem', { name })
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.click()
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) await item.click({ timeout: 3000 }).catch(() => undefined)
    if ((await picker.getAttribute('data-value')) === value) return
    await win.keyboard.press('Escape')
  }
  throw new Error(`the machine picker never took ${String(name)}`)
}

export async function run(t) {
  mkdirSync(SHOTS, { recursive: true })
  const world = await fleetWorld('connections-cards-shots', { count: 1 })
  try {
    const [server] = world.servers
    writeFileSync(path.join(server.dataDir, 'models-catalog.json'), JSON.stringify(CATALOGUE))
    const mac = await world.mac('a')
    const { app, win } = mac
    writeFileSync(path.join(mac.dir, 'models-catalog.json'), JSON.stringify(CATALOGUE))
    await app.evaluate(
      (_electron, { WORK_TOKEN, PLAY_TOKEN }) => {
        // The machine login is never read here (as cap-words).
        const settings = globalThis.__claveE2E?.settings
        if (settings) {
          // What Pi and OpenCode tabs used today (PRDCT-4551), made up: the
          // "Kimi work" plan connection ran 12 requests, DeepSeek (pay per
          // use) 48.2K tokens for $0.37, every other connection nothing.
          const zero = {
            requests: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
            sessions: 0
          }
          const figuresOf = {
            'Kimi work': {
              ...zero,
              requests: 12,
              input: 9000,
              output: 1400,
              totalTokens: 10400,
              sessions: 2
            },
            DeepSeek: {
              ...zero,
              requests: 31,
              input: 40000,
              output: 8200,
              totalTokens: 48200,
              cost: 0.37,
              sessions: 3
            }
          }
          settings.harnessUsage.read = async ({ range }) => {
            const connections = await settings.providerConnections.list()
            const rows = connections.map((c) => ({
              ...(figuresOf[c.label] ?? zero),
              harness: 'pi',
              connectionId: c.id,
              label: c.label,
              billing:
                c.company === 'deepseek' ? 'payPerUse' : c.company === 'ollama' ? 'local' : 'plan',
              removed: false
            }))
            return { range, rows, unavailable: [] }
          }
          const readClaude = settings.usage.readClaude
          settings.usage.readClaude = async (accountId, force) =>
            accountId === undefined || accountId === 'default'
              ? { windows: [], fetchedAt: Date.now() }
              : readClaude(accountId, force)
        }
        const reset = (hours) => String(Math.floor(Date.now() / 1000) + hours * 3600)
        const windows = {
          [WORK_TOKEN]: { block: '0.2', week: '0.4', fable: true },
          [PLAY_TOKEN]: { block: '0.1', week: '0.1', fable: false }
        }
        const original = globalThis.fetch
        globalThis.fetch = async (url, init) => {
          const target = String(url)
          if (target.includes('models.dev')) throw new Error('models.dev is not reached here')
          if (target.includes('api.deepseek.com'))
            return new Response(
              JSON.stringify({
                is_available: true,
                balance_infos: [{ currency: 'USD', total_balance: '18.40' }]
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const w = windows[token]
          if (!w) return original(url, init)
          return new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': w.block,
              'anthropic-ratelimit-unified-5h-reset': reset(3),
              'anthropic-ratelimit-unified-5h-status': 'allowed',
              'anthropic-ratelimit-unified-7d-utilization': w.week,
              'anthropic-ratelimit-unified-7d-reset': reset(3 * 24 + 5),
              'anthropic-ratelimit-unified-7d-status': 'allowed',
              ...(w.fable
                ? {
                    'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
                    'anthropic-ratelimit-unified-7d_oi-reset': reset(2 * 24 + 5),
                    'anthropic-ratelimit-unified-7d_oi-status': 'rejected'
                  }
                : {})
            }
          })
        }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners

    await openServersPage(win)
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const page = win.locator('[data-settings-page="accounts"]')
    await page.locator('[data-provider-card="moonshot"]').waitFor()

    // ── The empty page ──
    t.equal(
      'the empty page lists every provider to connect: Anthropic, OpenAI and the ten',
      await page.locator('[data-provider-card]').count(),
      12
    )
    t.equal(
      'and nothing connected beyond the machine login',
      await page.locator('[data-connections-count]').getAttribute('data-connections-count'),
      '0'
    )
    await shootEach(app, win, '01-empty-page', (name, size) => shootPage(app, win, name, size))

    // ── Two accounts, three connections of two providers ──
    const seeded = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN, KIMI_KEY, DEEPSEEK_KEY }) => {
        const api = window.electronAPI
        const work = await api.claudeAccountAdd({ label: 'Work' })
        await api.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await api.claudeAccountAdd({ label: 'Play' })
        await api.claudeAccountSetToken(play.id, PLAY_TOKEN)
        const kimi = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi work' })
        await api.providerConnectionSetKey(kimi.id, KIMI_KEY)
        const spare = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi spare' })
        const ds = await api.providerConnectionAdd({ company: 'deepseek', label: 'DeepSeek' })
        await api.providerConnectionSetKey(ds.id, DEEPSEEK_KEY)
        // A Codex subscription handed to Clave, not signed in yet (no Codex here).
        const team = await api.codexAccountAdd({ label: 'Team', kind: 'chatgpt' })
        await api.getUsageLimits(work.id, { force: true })
        await api.getUsageLimits(play.id, { force: true })
        return {
          work: work.id,
          play: play.id,
          kimi: kimi.id,
          spare: spare.id,
          ds: ds.id,
          team: team.id
        }
      },
      { WORK_TOKEN, PLAY_TOKEN, KIMI_KEY, DEEPSEEK_KEY }
    )
    // The window read today's usage as the cards appeared, while the seeding
    // was still adding them, and keeps a read for 30 s: once it is stale, the
    // page opened again reads it anew, as a person coming back would.
    await win.waitForTimeout(31_000)
    await win.locator('[data-settings-nav-row="servers"]').click()
    await win.locator('[data-settings-page="servers"]').waitFor()
    await win.locator('[data-settings-nav-row="accounts"]').click()
    await page.locator(`[data-provider-connection-row="${seeded.kimi}"]`).waitFor()
    const workCard = page.locator(`[data-claude-account-row="${seeded.work}"]`)
    const kimiCard = page.locator(`[data-provider-connection-row="${seeded.kimi}"]`)
    const dsCard = page.locator(`[data-provider-connection-row="${seeded.ds}"]`)
    const read = await until(
      async () =>
        /Fable out/.test((await workCard.textContent()) ?? '') &&
        /18\.40 USD left/.test((await dsCard.textContent()) ?? '') &&
        (await kimiCard.locator('[data-connection-models]').count()) === 1,
      { tries: 80, gapMs: 250 }
    )
    t.check('the cards read their usage and their models', !!read, {
      work: (await workCard.textContent())?.slice(0, 200),
      ds: (await dsCard.textContent())?.slice(0, 200)
    })
    // ── The connection's own usage today (PRDCT-4551), apart from the provider's ──
    const ownOf = (id) => page.locator(`[data-connection-own-usage="${id}"]`)
    const ownText = async (id) => ((await ownOf(id).textContent()) ?? '').trim()
    await until(async () => (await ownText(seeded.ds)).includes('$0.37'), { tries: 80, gapMs: 250 })
    t.equal(
      'a plan connection: its tabs’ requests and tokens, no cost',
      await ownText(seeded.kimi),
      'Your tabs12 requests · 10.4K tokens today'
    )
    t.equal(
      'a pay-per-use connection: tokens and cost',
      await ownText(seeded.ds),
      'Your tabs48.2K tokens · $0.37 today'
    )
    t.equal(
      'a connection whose tabs ran nothing says so',
      await ownText(seeded.spare),
      'Your tabsNothing run today'
    )
    t.check(
      "the provider's own line stays on its own, named",
      /Provider\s*18\.40 USD left/.test((await dsCard.innerText()) ?? '') &&
        /Provider\s*Coding plan/.test((await kimiCard.innerText()) ?? ''),
      await dsCard.innerText()
    )
    t.equal(
      'a Claude account keeps its one line: no count of its own',
      await workCard.locator('[data-connection-own-usage]').count(),
      0
    )
    await shootEach(app, win, '07-usage-close-up', async (name) => {
      await centre(dsCard)
      await win.waitForTimeout(500)
      await dsCard.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    t.equal(
      'six connections now',
      await page.locator('[data-connections-count]').getAttribute('data-connections-count'),
      '6'
    )
    t.equal(
      'the Moonshot card offers another connection',
      (
        await page.locator('[data-provider-card="moonshot"] [data-connect-company]').textContent()
      )?.trim(),
      'Connect another'
    )
    t.equal(
      'the spare Moonshot connection says it needs a key',
      (
        await page.locator(`[data-provider-connection-key-state="${seeded.spare}"]`).textContent()
      )?.trim(),
      'Needs a key'
    )
    const pageText = await page.innerText()
    t.check(
      'no key or token reaches the page',
      ![WORK_TOKEN, PLAY_TOKEN, KIMI_KEY, DEEPSEEK_KEY].some((v) => pageText.includes(v))
    )
    await shootEach(app, win, '02-whole-page', (name, size) => shootPage(app, win, name, size))
    // The app's two other skins, at the usual width.
    for (const skin of ['coffee', 'charcoal']) {
      await setTheme(win, skin)
      await shootPage(app, win, `02-whole-page--${skin}-usual`, WIDE)
    }

    // ── One card unfolded ──
    await kimiCard.locator('[data-connection-models-toggle]').first().click()
    await kimiCard.locator('[data-connection-models-rest]').waitFor()
    t.check(
      'the unfolded card names every Kimi model',
      (await kimiCard.innerText()).includes('Kimi Vision')
    )
    await shootEach(app, win, '03-card-models-unfolded', async (name) => {
      await centre(kimiCard)
      await win.waitForTimeout(500)
      await kimiCard.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await kimiCard.locator('[data-connection-models-toggle]').first().click()

    // ── The connect form open in a card ──
    const routerCard = page.locator('[data-provider-card="openrouter"]')
    await routerCard.locator('[data-connect-company="openrouter"]').click()
    await routerCard.locator('[data-provider-add-form="openrouter"]').waitFor()
    t.check(
      'Connect opens the form in the card, labelled with the provider',
      (await routerCard.locator('[data-provider-add-label]').inputValue()) === 'OpenRouter'
    )
    await shootEach(app, win, '04-connect-form-in-card', async (name) => {
      await centre(routerCard)
      await win.waitForTimeout(600)
      await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await routerCard.locator('[data-provider-add-cancel]').click()

    // ── The removal's question ──
    await dsCard.locator(`[data-provider-remove="${seeded.ds}"]`).click()
    const question = dsCard.locator(`[data-connection-remove-question="${seeded.ds}"]`)
    await question.waitFor()
    t.check(
      'removing asks first, naming what goes and what keeps running',
      /Remove DeepSeek\?/.test(await question.innerText()) &&
        /Tabs running on it keep going until they are restarted/.test(await question.innerText()),
      await question.innerText()
    )
    await shootEach(app, win, '05-remove-question', async (name) => {
      await centre(dsCard)
      await win.waitForTimeout(600)
      await dsCard.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await dsCard.locator(`[data-connection-remove-cancel="${seeded.ds}"]`).click()
    t.check(
      'Cancel keeps the connection',
      !!(await until(async () => (await question.count()) === 0)) &&
        (await win.evaluate(() => window.electronAPI.providerConnectionsList())).some(
          (c) => c.company === 'deepseek'
        )
    )

    // ── The removal's question on a Codex card: its folder goes under a running tab ──
    const teamCard = page.locator(`[data-codex-account-row="${seeded.team}"]`)
    await teamCard.locator(`[data-codex-account-remove="${seeded.team}"]`).click()
    const codexQuestion = teamCard.locator(`[data-connection-remove-question="${seeded.team}"]`)
    await codexQuestion.waitFor()
    const codexWords = await codexQuestion.innerText()
    t.check(
      'a Codex removal says the folder goes and a running tab may fail, never that it keeps going',
      /Remove Team\?/.test(codexWords) &&
        /folder its tabs run from are deleted from this Mac/.test(codexWords) &&
        /may fail at its next request/.test(codexWords) &&
        !/keep going/.test(codexWords),
      codexWords
    )
    await shootEach(app, win, '05-remove-question-codex', async (name) => {
      await centre(teamCard)
      await win.waitForTimeout(600)
      await teamCard.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await teamCard.locator(`[data-connection-remove-cancel="${seeded.team}"]`).click()

    // ── A Clave server's page ──
    await request(server, '/connections/providers', { company: 'zai', label: 'GLM plan' })
    await pickMachine(win, /^Personal VPS 1/, owner.id)
    const serverPage = page.locator(`[data-server-settings="${owner.id}"]`)
    await serverPage.locator('[data-provider-card="zai"]').waitFor()
    await until(
      async () => (await serverPage.locator('[data-provider-connection-row]').count()) === 1
    )
    t.equal(
      "the server's page offers the ten providers, its subscriptions being signed in there",
      await serverPage.locator('[data-provider-card]').count(),
      10
    )
    // The server's own count, read on the server: its connection has no key
    // yet, so no tab ran on it there.
    const serverOwn = serverPage.locator('[data-connection-own-usage]')
    await until(
      async () => (await serverOwn.getAttribute('data-connection-own-usage-state')) === 'read'
    )
    t.equal(
      "the server's connection reads its own count, from the server",
      ((await serverOwn.textContent()) ?? '').trim(),
      'Your tabsNothing run today'
    )
    await shootEach(app, win, '06-server-page', (name, size) => shootPage(app, win, name, size))

    await pickMachine(win, 'This Mac', 'local')
    t.check('no page error', mac.errors.length === 0, mac.errors)
  } finally {
    await world.close()
  }
}
