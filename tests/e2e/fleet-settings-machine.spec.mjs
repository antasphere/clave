// The Agents group of Settings shows a connected server (PRDCT-4152, lane B
// of the server wave): one machine picker at the top of the group, and the
// same four pages read from the server when it is picked. Accounts on a
// server are read-only from the Mac, set on the server itself by
// `scripts/server-accounts.mjs`; the usage comes from the server's own
// reads (recorded here, never a real provider); Agents shows and edits the
// server's launch profiles; Activity says plainly that a server keeps no
// record. The Preferences stay this Mac's whatever is picked, the Servers
// overview leads to each page with the server picked, and a server removed
// or disconnected while picked falls back to this Mac.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { REPO } from './harness.mjs'
import {
  connectMac,
  eventually,
  fleetWorld,
  openServersPage,
  request
} from './fixtures/fleet-world.mjs'

const TOKEN = 'sk-ant-oat01-studio-token-for-the-e2e-run-0123456789'
const API_KEY = 'sk-codex-key-for-the-e2e-run-0123456789'

/** Pick a machine in the settings sidebar's picker: the menu is a popover
 *  that opens on the trigger's pointer-down, so the open is waited for. */
async function pickMachine(win, name, value) {
  const picker = win.locator('[data-settings-select="settings-machine"]')
  const item = win.getByRole('menuitem', { name })
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.click()
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    // The popover animates in; a click that lands mid-animation is retried.
    if (offered) await item.click({ timeout: 3000 }).catch(() => undefined)
    if ((await picker.getAttribute('data-value')) === value) return
    await win.keyboard.press('Escape')
  }
  throw new Error(`the machine picker never took ${String(name)}`)
}

/** The command a person runs on the server, against the harness's daemon. */
function serverAccounts(server, args, stdin = '') {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(REPO, 'scripts/server-accounts.mjs'), '--data-dir', server.dataDir, ...args],
      { encoding: 'utf8', timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    )
    child.stdin.end(stdin)
  })
}

export async function run(t) {
  const world = await fleetWorld('settings-machine', { count: 1, codexStub: true })
  try {
    const [a] = world.servers
    // The daemon's usage reads record instead of reaching a provider.
    await a.fixture.evaluate(() => {
      const { usageClock } = globalThis.__claveE2E
      if (!usageClock) throw new Error('the daemon has no usage clock fixture')
      globalThis.__reads = []
      for (const provider of ['claude', 'codex']) {
        usageClock[provider].source.read = async (accountId) => {
          globalThis.__reads.push({ provider, accountId })
          const now = Date.now()
          return {
            windows: [
              {
                key: 'session:Current session (5h)',
                label: 'Current session (5h)',
                kind: 'session',
                scope: null,
                usedPercentage: 40,
                resetsAt: now + 3_600_000,
                severity: null
              },
              {
                key: 'weekly_all:Weekly (all models)',
                label: 'Weekly (all models)',
                kind: 'weekly_all',
                scope: null,
                usedPercentage: 25,
                resetsAt: now + 86_400_000,
                severity: null
              }
            ],
            fetchedAt: now
          }
        }
      }
    })
    const reads = () => a.fixture.evaluate(() => globalThis.__reads)

    // ── The account is set on the server, by its own command ──
    const added = await serverAccounts(a, ['claude', 'add', 'Studio login'], TOKEN)
    t.equal(
      'the server command adds an account with the token on its input',
      added.code,
      0,
      added.stderr
    )
    t.check(
      'the command prints nothing of the token',
      !added.stdout.includes(TOKEN) && !added.stderr.includes(TOKEN)
    )
    const listed = await serverAccounts(a, ['claude', 'list'])
    t.check(
      'the command lists the account with its token held',
      listed.code === 0 && /Studio login.*yes/.test(listed.stdout),
      listed.stdout
    )
    const accounts = await request(a, '/accounts/claude')
    const studio = accounts.find((account) => account.label === 'Studio login')
    t.check('the server holds the account with a token', !!studio && studio.hasToken === true)

    // A refused token leaves nothing behind, and is never echoed.
    const junk = await serverAccounts(a, ['claude', 'add', 'Junk'], 'not a token at all')
    t.check(
      'a refused token is said in one line and leaves no account behind',
      junk.code === 1 &&
        junk.stderr.includes('Nothing was added.') &&
        !(await request(a, '/accounts/claude')).some((account) => account.label === 'Junk'),
      junk.stderr
    )
    t.check(
      'the refused paste is not echoed',
      !(junk.stdout + junk.stderr).includes('not a token at all')
    )

    // The one login a daemon takes: a Codex API key, through Codex's own
    // command on the server (a stand-in here), the key in no output.
    const keyed = await serverAccounts(a, ['codex', 'add-key', 'Billing key'], API_KEY)
    t.equal('the server command adds a Codex API-key account', keyed.code, 0, keyed.stderr)
    t.check('the key is printed nowhere', !(keyed.stdout + keyed.stderr).includes(API_KEY))
    const codexListed = await serverAccounts(a, ['codex', 'list'])
    t.check(
      'the Codex account holds its credential',
      codexListed.code === 0 && /Billing key.*yes/.test(codexListed.stdout),
      codexListed.stdout
    )
    const billing = (await request(a, '/accounts/codex')).find(
      (account) => account.label === 'Billing key'
    )
    t.check(
      "the daemon stored the credential in the account's own home",
      !!billing && billing.hasCredential === true
    )

    // ── The Mac ──
    const mac = await world.mac('a')
    const { win } = mac
    await connectMac(mac, world.servers, { ui: false })
    const [owner] = mac.owners
    await openServersPage(win)
    const picker = win.locator('[data-settings-select="settings-machine"]')
    t.equal(
      'the machine picker sits in the settings sidebar once a server is saved',
      await picker.count(),
      1
    )
    t.equal('the picker starts on this Mac', await picker.getAttribute('data-value'), 'local')

    // The overview on the Servers page leads to the Accounts page with the server picked.
    const row = win.locator(`[data-server-id="${owner.id}"]`)
    await eventually(
      async () => (await row.locator('[data-server-overview-link="accounts"]').count()) === 1,
      'the connected server shows its overview'
    )
    t.check(
      'the overview names the workspaces, the accounts, the agents, the usage and the activity',
      (await row.locator('[data-server-overview-link]').count()) === 5
    )
    await row.locator('[data-server-overview-link="accounts"]').click()
    t.equal('the overview link picks the server', await picker.getAttribute('data-value'), owner.id)
    const accountsPage = win.locator('[data-settings-page="accounts"]')
    await accountsPage.locator(`[data-server-settings="${owner.id}"]`).waitFor()
    await eventually(
      async () =>
        (await accountsPage.locator(`[data-server-claude-account="${studio.id}"]`).count()) === 1,
      "the server's accounts are listed"
    )
    t.equal(
      'the Default account comes first, as on this Mac',
      await accountsPage
        .locator('[data-server-claude-account]')
        .first()
        .getAttribute('data-server-claude-account'),
      'default'
    )
    t.check(
      'the server accounts are read-only: no add, log in, paste or remove',
      (await accountsPage
        .locator('[data-claude-add-account], [data-codex-add-account]')
        .count()) === 0 &&
        (await accountsPage
          .locator('[data-server-claude-accounts] button, [data-server-codex-accounts] button')
          .count()) === 0
    )
    t.check(
      'the page says where an account is signed in',
      (await accountsPage.innerText()).includes('Accounts are signed in on the server itself')
    )
    t.check('the token never reaches the page', !(await accountsPage.innerText()).includes(TOKEN))
    await eventually(
      async () =>
        (await accountsPage.locator(`[data-server-codex-account="${billing.id}"]`).count()) === 1,
      "the server's Codex account is listed"
    )
    t.check(
      'the Codex account reads as signed in, the key nowhere',
      !(
        await accountsPage.locator(`[data-server-codex-account="${billing.id}"]`).innerText()
      ).includes('Needs login') && !(await accountsPage.innerText()).includes(API_KEY)
    )

    // ── Usage, read on the server ──
    await win.locator('[data-settings-nav-row="usage"]').click()
    const usagePage = win.locator('[data-settings-page="usage"]')
    await usagePage.locator(`[data-server-settings="${owner.id}"]`).waitFor()
    t.equal(
      'a server offers Claude and Codex only',
      await usagePage.locator('.panel-tab').count(),
      2
    )
    await eventually(
      async () =>
        (await usagePage.locator(`[data-claude-account-usage="${studio.id}"]`).count()) === 1,
      "the server's account has its usage group"
    )
    await eventually(
      async () => (await reads()).some((r) => r.provider === 'claude' && r.accountId === studio.id),
      'the read was made on the server'
    )
    // The tightest window the server read is the session block at 40%.
    await eventually(
      async () => (await usagePage.innerText()).includes('40% used'),
      'the usage the server read is on the page'
    )
    t.equal(
      "the account's weekly cap is drawn from the server's read",
      await usagePage
        .locator(`[data-usage-chart="weekly"] [data-usage-account="${studio.id}"] .usage-column`)
        .count(),
      1
    )
    const before = (await reads()).length
    await usagePage.locator('[data-usage-refresh] button').click()
    await eventually(
      async () => (await reads()).length > before,
      'Refresh reads every account again on the server'
    )

    // ── Agents: the server's launch profiles ──
    await win.locator('[data-settings-nav-row="agents"]').click()
    const agentsPage = win.locator('[data-settings-page="agents"]')
    await agentsPage.locator('[data-launch-profile="fleet-title-fixture"]').waitFor()
    t.equal(
      "the server's own default profile is selected",
      await agentsPage.locator('[data-settings-select="global-claude"]').getAttribute('data-value'),
      'fleet-title-fixture'
    )
    t.equal(
      'a server has no workspace override row here',
      await agentsPage.locator('[data-settings-select="workspace-claude"]').count(),
      0
    )

    // ── Activity: nothing recorded on a server ──
    await win.locator('[data-settings-nav-row="activity"]').click()
    await win.locator('[data-testid="server-activity-unavailable"]').waitFor({ state: 'attached' })
    t.check(
      'Activity says the server keeps no record',
      (await win.locator('[data-settings-page="activity"]').innerText()).includes(
        'keeps no activity record yet'
      )
    )

    // ── Preferences stay this Mac's ──
    await win.locator('[data-settings-nav-row="general"]').click()
    await win.locator('[data-settings-page="general"]').waitFor()
    t.equal(
      "General is this Mac's whatever is picked",
      await win.locator('[data-server-settings]').count(),
      0
    )

    // ── A change on the server reaches the open page ──
    await win.locator('[data-settings-nav-row="accounts"]').click()
    await accountsPage.locator(`[data-server-settings="${owner.id}"]`).waitFor()
    const second = await request(a, '/accounts/claude', { label: 'Second login' })
    await eventually(
      async () =>
        (await accountsPage.locator(`[data-server-claude-account="${second.id}"]`).count()) === 1,
      'an account added on the server appears without a reload'
    )

    // ── The overview follows an account added on the server ──
    await win.locator('[data-settings-nav-row="servers"]').click()
    await win.locator('[data-settings-page="servers"]').waitFor()
    await eventually(
      async () => (await row.locator(`[data-server-login="${second.id}"]`).count()) === 1,
      'the overview shows the account added while the Accounts page was open'
    )
    const third = await request(a, '/accounts/codex', { label: 'Third key', kind: 'apiKey' })
    await eventually(
      async () => (await row.locator(`[data-server-login="${third.id}"]`).count()) === 1,
      'the overview follows an account added while it is on screen'
    )
    await win.locator('[data-settings-nav-row="accounts"]').click()
    await accountsPage.locator(`[data-server-settings="${owner.id}"]`).waitFor()

    // ── Back to this Mac ──
    await pickMachine(win, 'This Mac', 'local')
    await eventually(
      async () => (await picker.getAttribute('data-value')) === 'local',
      'This Mac is picked again'
    )
    await accountsPage.locator('[data-claude-add-account]').waitFor()
    t.check("this Mac's Accounts page is back, with its add buttons", true)

    // ── A disconnected server falls back to this Mac ──
    // The option's accessible name carries its hint (the connection state).
    await pickMachine(win, /^Personal VPS 1/, owner.id)
    await eventually(
      async () => (await picker.getAttribute('data-value')) === owner.id,
      'the server is picked'
    )
    await win.evaluate((id) => window.electronAPI.fleetDisconnect(id), owner.id)
    await eventually(
      async () => (await picker.getAttribute('data-value')) === 'local',
      'a disconnected server falls back to this Mac'
    )

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
