// Settings → Connections, one card per provider (PRDCT-4552), drawn for the
// owner's eye. Three pages, in the light and the dark theme, at the usual
// width and at a narrow one:
//   - the empty page;
//   - the owner's own shape: six Claude accounts with different usage (one
//     out, one suggested) and one Moonshot connection with usage, nothing
//     else; one row's menu open, one removal's question open;
//   - the general case: two Claude accounts, one Codex, two Moonshot
//     connections, DeepSeek and Ollama; a card's models unfolded, the connect
//     form open in a card, a provider's and a Codex removal's question, the
//     usage close up, and a Clave server's page.
// Every key, token and figure is made up; nothing reaches a provider or
// models.dev. The pictures go to CLAVE_E2E_SHOTS (default
// /tmp/harness-next/cards/shots), each named by what it shows; the checks are
// what the pictures cannot say.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { until } from './harness.mjs'
import { connectMac, fleetWorld, openServersPage, request } from './fixtures/fleet-world.mjs'

const SHOTS = process.env.CLAVE_E2E_SHOTS || '/tmp/harness-next/cards/shots'
const token = (name) => `sk-ant-oat01-${name}-token-for-the-cards-shots-0123456789abcdef`
/** The six Claude accounts: label, token, and what their limits read. */
const CLAUDE = [
  { label: 'Work', token: token('work'), block: '0.2', week: '0.4', fable: true },
  { label: 'Play', token: token('play'), block: '0.1', week: '0.1' },
  { label: 'Studio', token: token('studio'), block: '0.3', week: '1.0', out: true },
  { label: 'Client A', token: token('clienta'), block: '0.5', week: '0.6' },
  { label: 'Client B', token: token('clientb'), block: '0.05', week: '0.25' },
  { label: 'Spare', token: token('spare'), block: '0.0', week: '0.05' }
]
const KIMI_KEY = 'sk-test-cards-kimi-' + 'k'.repeat(32)
const KIMI_SPARE_KEY = 'sk-test-cards-kimi-spare-' + 's'.repeat(32)
const DEEPSEEK_KEY = 'sk-test-cards-deepseek-' + 'd'.repeat(32)
const SECRETS = [...CLAUDE.map((c) => c.token), KIMI_KEY, KIMI_SPARE_KEY, DEEPSEEK_KEY]

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

// About fifty pictures, each with the window resized under it, and two waits
// for the usage read to go stale.
export const deadlineMs = 12 * 60_000

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
  // A menu closed with Escape hands the focus back to its trigger: the page
  // is drawn at rest.
  await win.evaluate(() => document.activeElement?.blur?.())
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

/** An element in the middle of the pane, clear of the page's sticky header. */
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

/** Open a row's menu; its entries, portalled, are the window's. */
async function openMenu(win, scope, id) {
  const entries = win.locator(`[data-connection-menu-entries="${id}"]`)
  for (let attempt = 0; attempt < 3; attempt++) {
    await scope.locator(`[data-connection-menu="${id}"]`).click()
    if (
      await entries.waitFor({ state: 'visible', timeout: 1500 }).then(
        () => true,
        () => false
      )
    )
      return entries
    await win.keyboard.press('Escape')
  }
  throw new Error(`the menu of ${id} never opened`)
}

/** The page opened again once the usage read is stale (30 s): what a person
 *  coming back reads. */
async function reopenStale(win, page, waitFor) {
  await win.waitForTimeout(31_000)
  await win.locator('[data-settings-nav-row="servers"]').click()
  await win.locator('[data-settings-page="servers"]').waitFor()
  await win.locator('[data-settings-nav-row="accounts"]').click()
  await page.locator(waitFor).waitFor()
}

const text = async (locator) => ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim()

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
      (_electron, { CLAUDE }) => {
        const settings = globalThis.__claveE2E?.settings
        if (settings) {
          // What Pi and OpenCode tabs used today (PRDCT-4551), made up: "Kimi
          // work" (a plan) 12 requests, DeepSeek (pay per use) 48.2K tokens for
          // $0.37, every other connection nothing.
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
            'Kimi work': { ...zero, requests: 12, input: 9000, output: 1400, totalTokens: 10400 },
            DeepSeek: {
              ...zero,
              requests: 31,
              input: 40000,
              output: 8200,
              totalTokens: 48200,
              cost: 0.37
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
          // The machine login is never read here (as cap-words).
          const readClaude = settings.usage.readClaude
          settings.usage.readClaude = async (accountId, force) =>
            accountId === undefined || accountId === 'default'
              ? { windows: [], fetchedAt: Date.now() }
              : readClaude(accountId, force)
        }
        const reset = (hours) => String(Math.floor(Date.now() / 1000) + hours * 3600)
        const byToken = Object.fromEntries(CLAUDE.map((c) => [c.token, c]))
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
          const sent = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const w = byToken[sent]
          if (!w) return original(url, init)
          return new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': w.block,
              'anthropic-ratelimit-unified-5h-reset': reset(3),
              'anthropic-ratelimit-unified-5h-status': 'allowed',
              'anthropic-ratelimit-unified-7d-utilization': w.week,
              // Each account's week renews on a day of its own (one is the soonest).
              'anthropic-ratelimit-unified-7d-reset': reset(24 * (1 + CLAUDE.indexOf(w)) + 5),
              'anthropic-ratelimit-unified-7d-status': w.out ? 'rejected' : 'allowed',
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
      { CLAUDE }
    )
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners

    await openServersPage(win)
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const page = win.locator('[data-settings-page="accounts"]')
    await page.locator('[data-provider-card="moonshot"]').waitFor()

    // ── 1. The empty page ──
    t.equal(
      'the empty page: the Anthropic card (the machine login) and eleven providers to connect',
      await page.locator('[data-provider-card]').count(),
      12
    )
    t.equal(
      'nothing connected beyond the machine login',
      await page.locator('[data-connections-count]').getAttribute('data-connections-count'),
      '0'
    )
    await shootEach(app, win, '01-empty-page', (name, size) => shootPage(app, win, name, size))

    // ── 2. The owner's shape: six Claude accounts, one Moonshot ──
    const ids = await win.evaluate(
      async ({ CLAUDE, KIMI_KEY }) => {
        const api = window.electronAPI
        const claude = {}
        for (const c of CLAUDE) {
          const made = await api.claudeAccountAdd({ label: c.label })
          await api.claudeAccountSetToken(made.id, c.token)
          claude[c.label] = made.id
        }
        const kimi = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi work' })
        await api.providerConnectionSetKey(kimi.id, KIMI_KEY)
        for (const id of Object.values(claude)) await api.getUsageLimits(id, { force: true })
        return { claude, kimi: kimi.id }
      },
      { CLAUDE, KIMI_KEY }
    )
    await reopenStale(win, page, `[data-provider-connection-row="${ids.kimi}"]`)
    const anthropic = page.locator('[data-provider-card="anthropic"]')
    const row = (label) => page.locator(`[data-claude-account-row="${ids.claude[label]}"]`)
    await until(async () => /out/.test(await text(row('Studio'))), { tries: 80, gapMs: 250 })
    t.equal(
      'one Anthropic card holds the seven connections as rows',
      await anthropic.locator('[data-claude-account-row]').count(),
      7
    )
    t.equal(
      'the Claude models are named once, on the card',
      await anthropic.locator('[data-connection-models]').count(),
      1
    )
    t.check(
      'the account that is out says so in its row',
      /out/.test(await text(row('Studio'))) &&
        /Limit reached/.test(await text(row('Studio'))) &&
        (await row('Studio').getAttribute('data-account-exhausted')) === 'true',
      await text(row('Studio'))
    )
    t.equal(
      'one row is suggested',
      await anthropic.locator('[data-connection-suggested]').count(),
      1
    )
    t.equal(
      'no row shows a row of icons: one Manage menu per row the person can change',
      await anthropic.locator('.btn-icon').count(),
      0
    )
    t.equal(
      'a connected provider is not offered again',
      await page.locator('[data-connection-offers] [data-provider-card="moonshot"]').count(),
      0
    )
    t.equal(
      'the Moonshot card connects another',
      await text(page.locator('[data-provider-card="moonshot"] [data-connect-company="moonshot"]')),
      'Connect another'
    )
    t.equal(
      "Moonshot's own tabs' usage, named apart from the provider's line",
      await text(page.locator(`[data-connection-own-usage="${ids.kimi}"]`)),
      'Your tabs 12 requests · 10.4K tokens today'
    )
    const pageText = await page.innerText()
    t.check('no key or token reaches the page', !SECRETS.some((v) => pageText.includes(v)))
    await shootEach(app, win, '10-owner-page', (name, size) => shootPage(app, win, name, size))

    // A row's menu, open: its entries in words.
    const clientA = ids.claude['Client A']
    const entries = await openMenu(win, page, clientA)
    const words = (await entries.innerText())
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    t.equal(
      "a Claude row's menu: every action in words, Remove apart and last",
      words.join(' | '),
      'Move up | Move down | Rename | Sign in again | Replace the token | Forget the sign-in | Remove'
    )
    await win.keyboard.press('Escape')
    await shootEach(app, win, '11-owner-row-menu', async (name) => {
      await centre(row('Client A'))
      await openMenu(win, page, clientA)
      await win.waitForTimeout(300)
      await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
      await win.keyboard.press('Escape')
      await win.waitForTimeout(200)
    })

    // A removal's question, open on the row.
    await openMenu(win, page, clientA)
    await win.locator(`[data-claude-account-remove="${clientA}"]`).click()
    const question = row('Client A').locator(`[data-connection-remove-question="${clientA}"]`)
    await question.waitFor()
    t.check(
      "the removal's question opens on the row, with its sentences",
      /Remove Client A\?/.test(await question.innerText()) &&
        /Its token is deleted from this Mac\. Tabs running on it keep going/.test(
          await question.innerText()
        ),
      await question.innerText()
    )
    await shootEach(app, win, '12-owner-remove-question', async (name) => {
      await centre(row('Client A'))
      await win.waitForTimeout(500)
      await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await row('Client A').locator(`[data-connection-remove-cancel="${clientA}"]`).click()

    // ── 3. The general case ──
    const general = await win.evaluate(
      async ({ remove, KIMI_SPARE_KEY, DEEPSEEK_KEY }) => {
        const api = window.electronAPI
        for (const id of remove) await api.claudeAccountRemove(id)
        const spare = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi spare' })
        await api.providerConnectionSetKey(spare.id, KIMI_SPARE_KEY)
        const ds = await api.providerConnectionAdd({ company: 'deepseek', label: 'DeepSeek' })
        await api.providerConnectionSetKey(ds.id, DEEPSEEK_KEY)
        const ollama = await api.providerConnectionAdd({
          company: 'ollama',
          label: 'Local Ollama',
          baseUrl: 'http://localhost:11434/v1'
        })
        // A Codex subscription handed to Clave, not signed in yet (no Codex here).
        const team = await api.codexAccountAdd({ label: 'Team', kind: 'chatgpt' })
        return { spare: spare.id, ds: ds.id, ollama: ollama.id, team: team.id }
      },
      {
        remove: ['Studio', 'Client A', 'Client B', 'Spare'].map((l) => ids.claude[l]),
        KIMI_SPARE_KEY,
        DEEPSEEK_KEY
      }
    )
    await reopenStale(win, page, `[data-provider-connection-row="${general.ds}"]`)
    const moonshot = page.locator('[data-provider-card="moonshot"]')
    const dsRow = page.locator(`[data-provider-connection-row="${general.ds}"]`)
    const teamRow = page.locator(`[data-codex-account-row="${general.team}"]`)
    await until(async () => /\$0\.37/.test(await text(dsRow)), { tries: 80, gapMs: 250 })
    t.equal(
      'one card per connected provider: Anthropic, OpenAI, Moonshot, DeepSeek, Ollama',
      await page
        .locator(
          '[data-connections-connected] [data-provider-group], [data-connections-connected] [data-provider-company-section]'
        )
        .count(),
      5
    )
    t.equal(
      'the Moonshot card holds its two connections',
      await moonshot.locator('[data-provider-connection-row]').count(),
      2
    )
    t.equal(
      'a pay-per-use row: the provider line and its tabs, named apart',
      await text(dsRow.locator('.connection-card-usage')),
      'Provider 18.40 USD left Your tabs 48.2K tokens · $0.37 today'
    )
    t.equal(
      'a row that needs a sign-in carries its one button',
      await text(teamRow.locator(`[data-connection-fix="${general.team}"]`)),
      'Sign in'
    )
    const dsWords = (await (await openMenu(win, page, general.ds)).innerText())
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    t.equal("a stored connection's menu", dsWords.join(' | '), 'Rename | Replace the key | Remove')
    await win.keyboard.press('Escape')
    const teamWords = (await (await openMenu(win, page, general.team)).innerText())
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    t.equal("a Codex row's menu", teamWords.join(' | '), 'Rename | Sign in | Remove')
    await win.keyboard.press('Escape')
    await shootEach(app, win, '20-general-page', (name, size) => shootPage(app, win, name, size))
    for (const skin of ['coffee', 'charcoal']) {
      await setTheme(win, skin)
      await shootPage(app, win, `20-general-page--${skin}-usual`, WIDE)
    }

    // A provider card's models unfolded.
    await moonshot.locator('[data-connection-models-toggle]').first().click()
    await moonshot.locator('[data-connection-models-rest]').waitFor()
    t.check(
      'the unfolded card names every Kimi model',
      (await moonshot.innerText()).includes('Kimi Vision')
    )
    await shootEach(app, win, '21-card-models-unfolded', async (name) => {
      await centre(moonshot)
      await win.waitForTimeout(500)
      await moonshot.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await moonshot.locator('[data-connection-models-toggle]').first().click()

    // The connect form open in a card: one to connect, then another of a connected one.
    const routerCard = page.locator('[data-provider-card="openrouter"]')
    await routerCard.locator('[data-connect-company="openrouter"]').click()
    await routerCard.locator('[data-provider-add-form="openrouter"]').waitFor()
    t.check(
      'Connect opens the form in the card, labelled with the provider',
      (await routerCard.locator('[data-provider-add-label]').inputValue()) === 'OpenRouter'
    )
    await shootEach(app, win, '22-connect-form-in-card', async (name) => {
      await centre(routerCard)
      await win.waitForTimeout(600)
      await win.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await routerCard.locator('[data-provider-add-cancel]').click()
    await moonshot.locator('[data-connect-company="moonshot"]').click()
    await moonshot.locator('[data-provider-add-form="moonshot"]').waitFor()
    t.check(
      'Connect another opens the form inside the connected card, a third label offered',
      (await moonshot.locator('[data-provider-add-label]').inputValue()) === 'Moonshot'
    )
    await shootEach(app, win, '23-connect-another-in-card', async (name) => {
      await centre(moonshot)
      await win.waitForTimeout(600)
      await moonshot.screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await moonshot.locator('[data-provider-add-cancel]').click()

    // The removal's questions: a stored connection's, a Codex one's.
    await openMenu(win, page, general.ds)
    await win.locator(`[data-provider-remove="${general.ds}"]`).click()
    const dsQuestion = dsRow.locator(`[data-connection-remove-question="${general.ds}"]`)
    await dsQuestion.waitFor()
    t.check(
      "a stored connection's removal keeps its sentence",
      /Remove DeepSeek\?/.test(await dsQuestion.innerText()) &&
        /Tabs running on it keep going until they are restarted/.test(await dsQuestion.innerText())
    )
    await shootEach(app, win, '24-remove-question-provider', async (name) => {
      await centre(dsRow)
      await win.waitForTimeout(600)
      await page
        .locator('[data-provider-card="deepseek"]')
        .screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await dsRow.locator(`[data-connection-remove-cancel="${general.ds}"]`).click()
    await openMenu(win, page, general.team)
    await win.locator(`[data-codex-account-remove="${general.team}"]`).click()
    const codexQuestion = teamRow.locator(`[data-connection-remove-question="${general.team}"]`)
    await codexQuestion.waitFor()
    t.check(
      "a Codex removal's sentence: the folder goes, a running tab may fail",
      /folder its tabs run from are deleted from this Mac/.test(await codexQuestion.innerText()) &&
        !/keep going/.test(await codexQuestion.innerText())
    )
    await shootEach(app, win, '25-remove-question-codex', async (name) => {
      await centre(teamRow)
      await win.waitForTimeout(600)
      await page
        .locator('[data-provider-card="openai"]')
        .screenshot({ path: path.join(SHOTS, `${name}.png`) })
    })
    await teamRow.locator(`[data-connection-remove-cancel="${general.team}"]`).click()
    t.check(
      'Cancel keeps both',
      (await win.evaluate(() => window.electronAPI.providerConnectionsList())).some(
        (c) => c.company === 'deepseek'
      )
    )

    // ── 4. A Clave server's page ──
    await request(server, '/connections/providers', { company: 'zai', label: 'GLM plan' })
    await pickMachine(win, /^Personal VPS 1/, owner.id)
    const serverPage = page.locator(`[data-server-settings="${owner.id}"]`)
    await serverPage.locator('[data-provider-card="zai"] [data-provider-connection-row]').waitFor()
    t.equal(
      "the server's page offers the nine providers not connected there",
      await serverPage.locator('[data-connection-offers] [data-provider-card]').count(),
      9
    )
    const serverOwn = serverPage.locator('[data-connection-own-usage]')
    await until(
      async () => (await serverOwn.getAttribute('data-connection-own-usage-state')) === 'read'
    )
    t.equal(
      "the server's connection reads its own count, from the server",
      await text(serverOwn),
      'Your tabs Nothing run today'
    )
    await shootEach(app, win, '26-server-page', (name, size) => shootPage(app, win, name, size))

    await pickMachine(win, 'This Mac', 'local')
    t.check('no page error', mac.errors.length === 0, mac.errors)
  } finally {
    await world.close()
  }
}
