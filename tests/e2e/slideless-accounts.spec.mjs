// Settings › Slideless and « Create link » (PRDCT-4266), in the real app, on
// the in-process server, its Slideless command replaced by a stub through
// CLAVE_SLIDELESS_CLI (tests/e2e/fixtures/slideless-stub.mjs): the stub's
// world is a JSON file this spec writes, and every call it answers is one
// line of a journal (its arguments, and its input's length and hash, never
// the input), which is how a check proves a code, a key or a password went
// on the input and nowhere else, and which site each push and link reached.
// The previews are the real command's, which the stub imports.
//
// The page lists the machine's sites, then tries each sign-in (`--check`);
// a site is added; « New links go to » is set on the server; a site signs in
// with its e-mail code, a wrong code failing in the command's own words, not
// in the notice its failures open with; a key is pasted. On an agent's
// artefacts: a folder gets a link on the site chosen, then another on the
// same deck whatever « New links go to » says; two pages of one folder get
// two decks, pushed from two copies the server stages; a password and a
// pinned version reach the link; a link is revoked by its token; a deck gone
// from its site is made anew on the site chosen. A dead loopback site is
// removed. A folder whose link file names a site of no profile here is
// refused before anything is pushed: Clave never signs in at a site only a
// link file names. Last, with « New links go to » not chosen, the dialog says
// why it offers the first site, until the person picks one. Every site,
// address and key is invented.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  REPO,
  callMcp,
  fixturePath,
  launchApp,
  mcpEndpoint,
  mcpHttpClient,
  seedTrustedRoots,
  seedWorkspaces,
  serverDataDirOf,
  spawnAgentTabIn,
  toolErrored,
  userDataDir
} from './harness.mjs'

export const deadlineMs = 12 * 60 * 1000

const STUB = path.join(REPO, 'tests/e2e/fixtures/slideless-stub.mjs')
const DECKS = 'https://decks.example.test'
const CLOUD = 'https://cloud.example.test'
const LOCAL = 'http://127.0.0.1:3400'
const DEAD = 'http://127.0.0.1:3999'
/** A site no profile of the machine is: only a folder's link file names it. */
const ELSEWHERE = 'https://elsewhere.example.test'
const HUB = 'https://hub.example.test'
const EMAIL = 'someone@example.test'
const CODE = '271828'
const WRONG_CODE = '000000'
const KEY = 'sk-test-pasted-key-4266'
const REFUSED_KEY = 'sk-test-refused-key-4266'
const PASSWORD = 'hunter22'
const CHECK_FIX = { kind: 'check', argv: ['slideless', 'profiles', '--check'] }

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, tries = 100, gapMs = 100) {
  for (let i = 0; i < tries; i++) {
    const value = await fn()
    if (value) return value
    await sleep(gapMs)
  }
  return null
}
const text = (locator, timeout = 1500) =>
  locator
    .textContent({ timeout })
    .then((s) => (s ?? '').trim())
    .catch(() => '')

/** The stub's world: two sites, one signed in whose keys were never counted
 *  (`staleKeys: null`), the cloud as the command lists it on an empty
 *  machine; what `profiles add` knows of two loopback sites; the code the
 *  local one accepts and the key every site refuses. */
function world() {
  return {
    machine: 'test-machine',
    defaultSite: DECKS,
    environment: { url: null, key: false, hubUrl: null },
    logins: [],
    profiles: [
      {
        name: 'decks',
        default: true,
        saved: true,
        site: {
          origin: DECKS,
          name: 'Decks',
          hub: HUB,
          federated: true,
          cliVersion: '0.15.0',
          seenAt: '2026-11-25T10:00:00.000Z'
        },
        cliBehind: false,
        signIn: {
          state: 'signed_in',
          via: 'login',
          hub: HUB,
          email: EMAIL,
          staleKeys: null,
          fix: CHECK_FIX
        },
        environment: [],
        stub: {
          learn: { signIn: { staleKeys: 0, fix: null } },
          check: { checked: 'ok', person: { name: 'Some One', email: EMAIL, workspace: null } }
        }
      },
      {
        // The implicit cloud row before a check, then with no login (the real shapes, Amendment 1).
        name: 'cloud',
        default: false,
        saved: false,
        site: {
          origin: CLOUD,
          name: 'Cloud',
          hub: null,
          federated: null,
          cliVersion: null,
          seenAt: null
        },
        cliBehind: null,
        signIn: {
          state: 'unknown',
          via: null,
          hub: null,
          email: null,
          staleKeys: 0,
          fix: CHECK_FIX
        },
        environment: [],
        stub: {
          learn: {
            site: { federated: true, cliVersion: '0.15.0', seenAt: '2026-11-26T09:00:00.000Z' },
            signIn: {
              state: 'needs_login',
              fix: { kind: 'pick_hub', argv: ['slideless', '--api-url', CLOUD, 'login', '--hub'] }
            }
          },
          check: { checked: 'no_key', person: null }
        }
      }
    ],
    addable: {
      // A self-hosted site newer than the command: its failures open with the notice.
      [LOCAL]: {
        name: 'local',
        site: { name: null, hub: null, federated: false, cliVersion: '0.15.1', seenAt: null },
        cliBehind: true,
        signIn: {
          state: 'needs_login',
          staleKeys: 0,
          fix: { kind: 'email_code', argv: ['slideless', '--profile', 'local', 'login'] }
        },
        stub: { notice: true }
      },
      // A dead loopback site: after a check, unreachable, and the command offers its removal.
      [DEAD]: {
        name: 'dead',
        stub: {
          learn: {
            signIn: {
              state: 'needs_login',
              fix: { kind: 'remove_profile', argv: ['slideless', 'profiles', 'remove', 'dead'] }
            }
          },
          check: { checked: 'unreachable', person: null }
        }
      }
    },
    codes: { [LOCAL]: CODE },
    refusedKeys: [sha256(REFUSED_KEY)],
    keyEmail: EMAIL,
    // The deck a folder's link file names on a site of no profile here: a push
    // that named that site would land on it, as the real command's would.
    decks: {
      'deck-elsewhere': { site: ELSEWHERE, title: 'linked', version: 1, tokens: [], gone: false }
    },
    nextDeck: 1,
    nextToken: 1,
    // Long enough to read the page before its check answers.
    checkDelayMs: 4000
  }
}

async function fakeAgent(win, root, wsId) {
  writeFileSync(`${root}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
  chmodSync(`${root}/fake-agent.sh`, 0o755)
  await win.evaluate(
    async ({ root, ws }) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'slideless-accounts-fake-claude',
        name: 'Synthetic agent',
        family: 'claude',
        command: [root + '/fake-agent.sh'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(
        ws,
        'claude',
        'slideless-accounts-fake-claude'
      )
    },
    { root, ws: wsId }
  )
}

async function agentClient(app, win, dir) {
  const root = serverDataDirOf(dir)
  const agent = await spawnAgentTabIn(app, win, root)
  if (!agent?.token) return { agent: null, client: null }
  const config = JSON.parse(
    readFileSync(path.join(root, 'mcp-configs', `${agent.sessionId}.json`), 'utf8')
  )
  const client = mcpHttpClient(config.mcpServers?.clave?.url ?? mcpEndpoint(dir), agent.token)
  await client.init()
  return { agent, client }
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
      await win
        .locator('[role="menu"]')
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
      return
    }
    await win.keyboard.press('Escape')
  }
  throw new Error(`the select never offered ${String(name)}`)
}

export async function run(t) {
  const DIR = userDataDir('slideless-accounts')
  const ROOT = fixturePath('slideless-accounts-root')
  const STUB_DIR = fixturePath('slideless-accounts-stub')
  const STATE = path.join(STUB_DIR, 'state.json')
  const JOURNAL = path.join(STUB_DIR, 'journal.jsonl')
  const DECK = `${ROOT}/clave-e2e-deck`
  const PAGES = `${ROOT}/clave-e2e-pages`
  const ONE = `${PAGES}/one.html`
  const TWO = `${PAGES}/two.html`
  const LINKED = `${ROOT}/clave-e2e-linked`
  const FRESH = `${ROOT}/clave-e2e-fresh`
  for (const folder of [ROOT, STUB_DIR]) rmSync(folder, { recursive: true, force: true })
  for (const folder of [DECK, PAGES, LINKED, FRESH, STUB_DIR])
    mkdirSync(folder, { recursive: true })
  writeFileSync(`${FRESH}/index.html`, '<!doctype html><h1>no deck yet</h1>')
  writeFileSync(`${DECK}/index.html`, '<!doctype html><h1 id="t">first draft</h1>')
  writeFileSync(ONE, '<!doctype html><h1>one</h1>')
  writeFileSync(TWO, '<!doctype html><h1>two</h1>')
  writeFileSync(`${LINKED}/index.html`, '<!doctype html><h1>linked elsewhere</h1>')
  writeFileSync(
    `${LINKED}/.slideless.json`,
    `${JSON.stringify({ presentationId: 'deck-elsewhere', baseUrl: ELSEWHERE }, null, 2)}\n`
  )
  writeFileSync(STATE, JSON.stringify(world(), null, 2))
  const readWorld = () => JSON.parse(readFileSync(STATE, 'utf8'))
  const writeWorld = (next) => writeFileSync(STATE, JSON.stringify(next, null, 2))

  /** The journal's calls, from line `from` on; each `{ argv, stdin, stdinSha256 }`. */
  const journal = (from = 0) =>
    (existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean) : [])
      .slice(from)
      .map((line) => JSON.parse(line))
  const mark = () => journal().length
  const has = (call, ...words) => words.every((word) => call.argv.includes(word))
  const optionOf = (call, name) => {
    const at = call.argv.indexOf(name)
    return at >= 0 ? call.argv[at + 1] : undefined
  }
  const after = (call, word) => call.argv[call.argv.indexOf(word) + 1]

  const WS = {
    id: 'aaaa0000-0000-4000-8000-000000004266',
    name: 'Slideless accounts',
    rootDir: ROOT,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    env: {
      CLAVE_SLIDELESS_CLI: STUB,
      CLAVE_TEST_SLIDELESS_REGISTRY: '',
      SLIDELESS_STUB_STATE: STATE,
      SLIDELESS_STUB_JOURNAL: JOURNAL
    }
  })
  let agentId = null

  const toSlideless = async () => {
    const navRow = win.locator('[data-settings-nav-row="slideless"]')
    if (!(await navRow.isVisible().catch(() => false)))
      await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await navRow.click()
    const page = win.locator('[data-settings-page="slideless"]')
    await page.waitFor({ state: 'visible', timeout: 10000 })
    return page
  }
  // The Settings view stays mounted under the sessions: it is hidden, not gone.
  const toSessions = async () => {
    await win.locator('[aria-label="Back to sessions"]').click()
    await win
      .locator('[data-settings-page="slideless"]')
      .waitFor({ state: 'hidden', timeout: 5000 })
  }
  const newLinksOnServer = async (origin) =>
    until(async () => {
      const accounts = await win.evaluate(() => window.electronAPI.artefacts.slidelessAccounts())
      return accounts.newLinksSite === origin ? accounts : null
    }, 50)

  const panelTitle = win.locator(
    '[data-testid="artefact-panel"] .pane-header-lead .pane-header-title'
  )
  const dialog = win.locator('[data-testid="create-link-dialog"]')
  const siteSelect = dialog.locator('[data-settings-select="create-link-site"]')
  /** Open « Create link » on the artefact titled `title`, once the panel shows it and the deck is read. */
  const openDialog = async (title) => {
    await until(async () => (await text(panelTitle)) === title, 150)
    const button = win.locator('[data-create-link-open]')
    await until(async () => button.isEnabled().catch(() => false), 150)
    await button.click()
    await dialog.waitFor({ state: 'visible', timeout: 10000 })
    await until(
      async () =>
        (await text(dialog.locator('[data-create-link-subtitle]'))) === title &&
        (await dialog.getByText('Reading the deck…').count()) === 0,
      150
    )
  }
  const closeDialog = async () => {
    await dialog.locator('[data-create-link-cancel]').click()
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
  }
  /** Create link, and what the dialog answers: the link's URL, a refusal, or a deck gone. */
  const submit = async () => {
    await dialog.locator('[data-create-link-submit]').click()
    return until(async () => {
      const url = await dialog
        .locator('[data-create-link-url]')
        .inputValue({ timeout: 300 })
        .catch(() => '')
      if (url) return { url }
      const refusal = await text(dialog.locator('[data-create-link-refusal]'), 300)
      if (refusal) return { refusal }
      const gone = await text(dialog.locator('[data-create-link-gone]'), 300)
      return gone ? { gone } : null
    }, 200)
  }

  try {
    const ready = await until(async () => {
      const state = await win.evaluate(() => window.electronAPI.artefacts.slidelessState())
      return state.phase === 'ready' ? state : null
    }, 300)
    t.check(
      'the server runs the stub named by CLAVE_SLIDELESS_CLI',
      ready?.override === true,
      ready
    )

    // ── 1. The listing at once, then the check ──
    const page = await toSlideless()
    const row = (origin) => page.locator(`[data-slideless-profile="${origin}"]`)
    const line = (origin, name) => row(origin).locator(`[data-line="${name}"]`)
    const heading = page.locator('[data-slideless-heading]')
    t.check(
      '1. the page names the machine and its command, verbatim from the listing',
      !!(await until(
        async () => (await text(heading)) === 'Accounts on test-machine · Slideless 0.15.0'
      )),
      await text(heading)
    )
    const names = page.locator('[data-slideless-profile] [data-slideless-name]')
    await until(async () => (await names.count()) === 2)
    t.check(
      '1. two sites, each by its name',
      JSON.stringify(await names.allTextContents()) === JSON.stringify(['Decks', 'Cloud']),
      await names.allTextContents()
    )
    t.equal(
      '1. a site whose keys were never counted reads « Not checked yet » before the check',
      await text(line(DECKS, 'sign-in')),
      'Not checked yet'
    )
    t.equal(
      '1. its check line reads « Checking… » while the check runs',
      await text(line(DECKS, 'check')),
      'Checking…'
    )
    t.check(
      '1. the command’s default carries the badge',
      (await row(DECKS).locator('[data-slideless-default]').count()) === 1 &&
        (await row(CLOUD).locator('[data-slideless-default]').count()) === 0
    )
    t.check(
      '1. the check answers: the site says who the key is',
      !!(await until(
        async () => (await text(line(DECKS, 'check'))) === 'Answers as Some One',
        150
      )),
      await text(line(DECKS, 'check'))
    )
    t.check(
      '1. the check ran on the machine (profiles --check --json)',
      journal().some((call) => has(call, 'profiles', '--check', '--json')),
      journal().map((call) => call.argv)
    )
    t.equal(
      '1. checked, the site says how it signs in',
      await text(line(DECKS, 'sign-in')),
      `Signed in as ${EMAIL} through hub.example.test`
    )
    t.check(
      '1. the cloud, checked with no login: not signed in, no key, a sign-in and a pasted key offered',
      (await text(line(CLOUD, 'sign-in'))) === 'Not signed in' &&
        (await text(line(CLOUD, 'check'))) === 'No key to check' &&
        (await text(row(CLOUD).locator('[data-slideless-status]'))) === 'Sign-in needed' &&
        (await row(CLOUD).locator('[data-slideless-action="sign_in"]').count()) === 1 &&
        (await row(CLOUD).locator('[data-slideless-action="paste_key"]').count()) === 1,
      await text(row(CLOUD))
    )
    // The rest reads the page without waiting on a check.
    writeWorld({ ...readWorld(), checkDelayMs: 0 })

    // ── 2. Add a site ──
    const addInput = page.locator('[data-slideless-add-input]')
    await addInput.fill(DECKS)
    await page.locator('[data-slideless-add]').click()
    const addError = page.locator('[data-slideless-add-error]')
    t.check(
      '2. a site already there is refused in the command’s own words, under the field',
      !!(await until(async () =>
        (await text(addError)).includes('is already a site of this machine')
      )),
      await text(addError)
    )
    const beforeAdd = mark()
    await addInput.fill(LOCAL)
    await page.locator('[data-slideless-add]').click()
    t.check(
      '2. Add a site adds a third',
      !!(await until(async () => (await names.count()) === 3 && (await row(LOCAL).count()) === 1)),
      await names.allTextContents()
    )
    const adds = journal(beforeAdd).filter((call) => has(call, 'profiles', 'add'))
    t.check(
      '2. … with profiles add <url> --json, and no --api-url',
      adds.length === 1 && has(adds[0], LOCAL, '--json') && !has(adds[0], '--api-url'),
      adds.map((call) => call.argv)
    )
    t.equal('2. the field is emptied once the site is added', await addInput.inputValue(), '')
    t.check(
      '2. the new site says what it is: a key to sign in with, and a command older than it',
      (await text(line(LOCAL, 'sign-in'))) === 'Not signed in' &&
        (await text(line(LOCAL, 'behind'))).includes(
          "Clave's Slideless 0.15.0 is older than this site's 0.15.1"
        ),
      await text(row(LOCAL))
    )
    // The add answers the plain listing: the page then checks every sign-in, as Refresh does.
    t.check(
      '2. … then the page checks every sign-in again (profiles --check), as Refresh does',
      !!(await until(() => journal(beforeAdd).some((call) => has(call, 'profiles', '--check')))),
      journal(beforeAdd).map((call) => call.argv)
    )
    t.check(
      '2. … and every row keeps its check line',
      !!(await until(
        async () =>
          (await text(line(DECKS, 'check'))) === 'Answers as Some One' &&
          (await text(line(LOCAL, 'check'))) === 'No key to check',
        150
      )),
      { decks: await text(line(DECKS, 'check')), local: await text(line(LOCAL, 'check')) }
    )

    // ── 3. New links go to ──
    const newLinks = page.locator('[data-settings-select="slideless-new-links"]')
    t.equal('3. « New links go to » starts « Not chosen »', await text(newLinks), 'Not chosen')
    await pick(win, newLinks, 'Cloud')
    t.check(
      '3. « New links go to » set to the cloud is answered by the server',
      !!(await newLinksOnServer(CLOUD)),
      await win.evaluate(() => window.electronAPI.artefacts.slidelessAccounts())
    )
    t.check(
      '3. and the select shows it',
      !!(await until(async () => (await newLinks.getAttribute('data-value')) === CLOUD))
    )
    // The decks site for the folder's first link.
    await pick(win, newLinks, 'Decks')
    t.check(
      '3. set to the decks site, the server answers it too',
      !!(await newLinksOnServer(DECKS))
    )

    // ── 4. A refused key, then the e-mail code ──
    const local = row(LOCAL)
    await local.locator('[data-slideless-action="paste_key"]').click()
    const keyField = local.locator('[data-slideless-key-input]')
    await keyField.fill(REFUSED_KEY)
    const beforeRefused = mark()
    await local.locator('[data-slideless-key-save]').click()
    const keyRefusal = local.locator('.slideless-paste-key [role="alert"]')
    t.check(
      '4. a refused key says the site’s refusal, not the notice its errors open with',
      !!(await until(async () => {
        const said = await text(keyRefusal)
        return said.includes('The site refused this key.') && !said.includes('older than')
      })),
      await text(keyRefusal)
    )
    t.equal('4. the key field is empty after the call', await keyField.inputValue(), '')
    const refusedCall = journal(beforeRefused).find((call) => has(call, 'login'))
    t.check(
      '4. the refused key went on the input only',
      !!refusedCall &&
        has(refusedCall, '--api-key-stdin') &&
        !refusedCall.argv.some((arg) => arg.includes(REFUSED_KEY)) &&
        refusedCall.stdinSha256 === sha256(`${REFUSED_KEY}\n`),
      refusedCall
    )
    await local.locator('.slideless-paste-key').getByRole('button', { name: 'Cancel' }).click()

    const beforeSignIn = mark()
    await local.locator('[data-slideless-action="sign_in"]').click()
    const address = local.locator('[data-slideless-signin-address]')
    await address.fill(EMAIL)
    await local.locator('[data-slideless-signin-send]').click()
    const form = local.locator('.slideless-sign-in')
    t.check(
      '4. the code is asked: the form says where it went',
      !!(await until(async () => (await text(form)).includes(`A code was sent to ${EMAIL}.`), 150)),
      await text(form)
    )
    const codeField = local.locator('[data-slideless-signin-code]')
    t.equal(
      '4. the code field is a one-time code',
      await codeField.getAttribute('autocomplete'),
      'one-time-code'
    )
    await codeField.fill(WRONG_CODE)
    await local.locator('[data-slideless-signin-submit]').click()
    const failure = local.locator('[data-slideless-signin-failure]')
    t.check(
      '4. a wrong code fails in the command’s Error line, not its notice',
      !!(await until(async () => {
        const said = await text(failure)
        return said === 'That code is not the one that was sent.'
      }, 150)),
      await text(failure)
    )
    await local.locator('[data-slideless-signin-retry]').click()
    t.equal('4. Try again keeps the address', await address.inputValue(), EMAIL)
    await local.locator('[data-slideless-signin-send]').click()
    await until(async () => (await codeField.count()) === 1, 150)
    await codeField.fill(CODE)
    await local.locator('[data-slideless-signin-submit]').click()
    t.check(
      '4. the right code signs the row in, and the form goes',
      !!(await until(
        async () =>
          (await local.getAttribute('data-slideless-state')) === 'signed_in' &&
          (await form.count()) === 0,
        150
      )),
      { state: await local.getAttribute('data-slideless-state'), row: await text(local) }
    )
    t.equal(
      '4. the row says how it signs in now',
      await text(line(LOCAL, 'sign-in')),
      `Signed in with its own key as ${EMAIL}`
    )
    const logins = journal(beforeSignIn).filter(
      (call) => has(call, 'login') && !has(call, '--api-key-stdin')
    )
    t.check(
      '4. both sign-ins named the site with --api-url',
      logins.length === 2 && logins.every((call) => optionOf(call, '--api-url') === LOCAL),
      logins.map((call) => call.argv)
    )
    t.check(
      '4. no code is ever on a command line',
      logins.every(
        (call) => !call.argv.some((arg) => arg.includes(CODE) || arg.includes(WRONG_CODE))
      ),
      logins.map((call) => call.argv)
    )
    const signedWith = logins.find((call) => call.stdinSha256 === sha256(`${CODE}\n`))
    t.check(
      '4. the code went on the input: its length is the code’s plus one',
      signedWith?.stdin === CODE.length + 1,
      logins.map((call) => ({ stdin: call.stdin }))
    )

    // ── 5. A pasted key ──
    const cloud = row(CLOUD)
    await cloud.locator('[data-slideless-action="paste_key"]').click()
    const cloudKey = cloud.locator('[data-slideless-key-input]')
    t.equal('5. the key field hides what is typed', await cloudKey.getAttribute('type'), 'password')
    await cloudKey.fill(KEY)
    const beforeKey = mark()
    await cloud.locator('[data-slideless-key-save]').click()
    t.check(
      '5. the pasted key signs the cloud in, and its form goes',
      !!(await until(
        async () =>
          (await cloud.getAttribute('data-slideless-state')) === 'signed_in' &&
          (await cloud.locator('[data-slideless-key-input]').count()) === 0,
        150
      )),
      await text(cloud)
    )
    const keyed = journal(beforeKey).filter((call) => has(call, 'login'))
    t.check(
      '5. the key went with --api-key-stdin to the cloud, never on the command line',
      keyed.length === 1 &&
        has(keyed[0], '--api-key-stdin') &&
        optionOf(keyed[0], '--api-url') === CLOUD &&
        !keyed[0].argv.some((arg) => arg.includes(KEY)),
      keyed.map((call) => call.argv)
    )
    t.equal('5. the input carried the key’s line', keyed[0]?.stdinSha256, sha256(`${KEY}\n`))

    // ── 6. A folder artefact: a link on the decks site, then another on the same deck ──
    await toSessions()
    await fakeAgent(win, ROOT, WS.id)
    const { agent, client } = await agentClient(app, win, DIR)
    agentId = agent?.sessionId ?? null
    t.check('an agent tab with its own MCP token', !!agent?.token)
    if (!client) return
    t.check(
      '6. the agent opens the folder as its artefact',
      !toolErrored(await client.call('clave_open_artefact', { path: DECK }))
    )
    await win
      .locator('[data-testid="artefact-panel"]')
      .waitFor({ state: 'visible', timeout: 20000 })
    t.check(
      '6. the bar offers Create link, and so does the menu, first',
      !!(await until(
        async () =>
          win
            .locator('[data-create-link-open]')
            .isEnabled()
            .catch(() => false),
        150
      )) &&
        (await (async () => {
          await win.getByRole('button', { name: 'Artefact menu' }).click()
          const first = await text(
            win.locator('[aria-label="Artefact menu"][role="menu"] [role="menuitem"]').first()
          )
          await win.keyboard.press('Escape')
          await win
            .locator('[role="menu"]')
            .waitFor({ state: 'detached', timeout: 5000 })
            .catch(() => {})
          return first === 'Create link…'
        })())
    )
    await openDialog('clave-e2e-deck')
    t.check(
      '6. a page with no deck offers its site, « New links go to » first',
      !!(await until(async () => (await siteSelect.getAttribute('data-value')) === DECKS)),
      await siteSelect.getAttribute('data-value')
    )
    const beforeFirst = mark()
    const first = await submit()
    t.check(
      '6. Create link shows the link',
      /^https:\/\/decks\.example\.test\/s\/tok-\d+$/.test(first?.url ?? ''),
      first
    )
    t.equal(
      '6. once a link is made, the primary reads « Create another link »',
      await text(dialog.locator('[data-create-link-submit]')),
      'Create another link'
    )
    const firstToken = (first?.url ?? '').split('/s/')[1]
    const firstPushes = journal(beforeFirst).filter((call) => has(call, 'push'))
    t.check(
      '6. pushed from the folder to the decks site, a new deck',
      firstPushes.length === 1 &&
        optionOf(firstPushes[0], '--api-url') === DECKS &&
        has(firstPushes[0], '--new', DECK),
      firstPushes.map((call) => call.argv)
    )
    const firstShare = journal(beforeFirst).find((call) => has(call, 'share'))
    const deckId = firstShare ? after(firstShare, 'share') : null
    t.check(
      '6. shared with the defaults: its name, no switch, no input',
      !!firstShare &&
        optionOf(firstShare, '--api-url') === DECKS &&
        JSON.stringify(firstShare.argv.slice(firstShare.argv.indexOf('share'))) ===
          JSON.stringify(['share', deckId, '--name', 'Clave']) &&
        firstShare.stdin === null,
      firstShare
    )
    t.equal(
      '6. the link file is the folder’s own, as the command writes it',
      existsSync(`${DECK}/.slideless.json`) &&
        JSON.parse(readFileSync(`${DECK}/.slideless.json`, 'utf8')).presentationId,
      deckId
    )
    await closeDialog()

    const beforeBack = mark()
    await toSlideless()
    t.check(
      '6. Settings shown again: the page lists and checks the sites again, as on open',
      !!(await until(() => journal(beforeBack).some((call) => has(call, 'profiles', '--check')))),
      journal(beforeBack).map((call) => call.argv)
    )
    await pick(win, page.locator('[data-settings-select="slideless-new-links"]'), 'Cloud')
    t.check('6. « New links go to » changed to the cloud', !!(await newLinksOnServer(CLOUD)))
    await toSessions()
    writeFileSync(`${DECK}/index.html`, '<!doctype html><h1 id="t">second draft</h1>')
    await openDialog('clave-e2e-deck')
    const where = dialog.locator('[data-create-link-where]')
    t.check(
      '6. a deck already made says where it is, and offers no site',
      !!(await until(async () => (await text(where)) === `On Decks (${DECKS}) · version 1`)) &&
        (await siteSelect.count()) === 0,
      await text(where)
    )
    const beforeSecond = mark()
    const second = await submit()
    t.check(
      '6. Create link again shows a new link',
      !!second?.url && second.url !== first?.url,
      second
    )
    const secondPushes = journal(beforeSecond).filter((call) => has(call, 'push'))
    t.check(
      '6. pushed again to the same deck on its own site',
      secondPushes.length === 1 &&
        optionOf(secondPushes[0], '--id') === deckId &&
        optionOf(secondPushes[0], '--api-url') === DECKS &&
        !has(secondPushes[0], '--new'),
      secondPushes.map((call) => call.argv)
    )
    t.check(
      '6. never the cloud',
      journal(beforeSecond).every((call) => optionOf(call, '--api-url') !== CLOUD),
      journal(beforeSecond).map((call) => call.argv)
    )
    await closeDialog()

    // ── 7. Two pages of one folder: two decks, pushed from two staged copies ──
    const beforePages = mark()
    t.check(
      '7. the agent opens a first page of a folder',
      !toolErrored(await client.call('clave_open_artefact', { path: ONE }))
    )
    await openDialog('one.html')
    const one = await submit()
    t.check('7. the first page gets a link', !!one?.url, one)
    await closeDialog()
    t.check(
      '7. the agent opens a second page of the same folder',
      !toolErrored(await client.call('clave_open_artefact', { path: TWO }))
    )
    await openDialog('two.html')
    const two = await submit()
    t.check('7. the second page gets a link of its own', !!two?.url && two.url !== one?.url, two)
    await closeDialog()
    const pagePushes = journal(beforePages).filter((call) => has(call, 'push'))
    const pushedPaths = pagePushes.map((call) => after(call, 'push'))
    const staged = path.join(realpathSync(serverDataDirOf(DIR)), 'slideless', 'staged')
    const real = (p) => (existsSync(p) ? realpathSync(p) : p)
    t.check(
      '7. two pushes from two different staged copies under the server’s data folder',
      pagePushes.length === 2 &&
        pushedPaths[0] !== pushedPaths[1] &&
        pushedPaths.every((p) => real(p).startsWith(`${staged}/`)) &&
        path.basename(pushedPaths[0]) === 'one.html' &&
        path.basename(pushedPaths[1]) === 'two.html' &&
        pagePushes.every((call) => has(call, '--new')),
      pushedPaths
    )
    t.check(
      '7. a page with no deck goes where « New links go to » says now: the cloud, not the first site',
      pagePushes.length === 2 && pagePushes.every((call) => optionOf(call, '--api-url') === CLOUD),
      pagePushes.map((call) => call.argv)
    )
    const pageDecks = journal(beforePages)
      .filter((call) => has(call, 'share'))
      .map((call) => after(call, 'share'))
    t.check(
      '7. two links on two different decks',
      pageDecks.length === 2 && pageDecks[0] !== pageDecks[1] && !pageDecks.includes(deckId),
      pageDecks
    )
    t.check('7. no link file in the folder they share', !existsSync(`${PAGES}/.slideless.json`))

    // ── 8. A password and a pinned version ──
    t.check(
      '8. the agent opens the folder again',
      !toolErrored(await client.call('clave_open_artefact', { path: DECK }))
    )
    await openDialog('clave-e2e-deck')
    await dialog.locator('[data-create-link-password]').fill('abc')
    t.check(
      '8. a password under four characters is refused before anything runs',
      (await text(dialog.locator('[data-create-link-refusal]'))) ===
        'A password is at least 4 characters long.' &&
        (await dialog.locator('[data-create-link-submit]').isDisabled())
    )
    await dialog.locator('[data-create-link-password]').fill(PASSWORD)
    await dialog.locator('button[role="switch"][aria-label="Stays on this version"]').click()
    const beforePinned = mark()
    const pinned = await submit()
    t.check('8. the link is made', !!pinned?.url, pinned)
    const pinnedPush = journal(beforePinned).find((call) => has(call, 'push'))
    const pinnedShare = journal(beforePinned).find((call) => has(call, 'share'))
    t.check(
      '8. the password went with --password-stdin, its line on the input, never on the command line',
      !!pinnedShare &&
        has(pinnedShare, '--password-stdin') &&
        !pinnedShare.argv.some((arg) => arg.includes(PASSWORD)) &&
        pinnedShare.stdin === PASSWORD.length + 1 &&
        pinnedShare.stdinSha256 === sha256(`${PASSWORD}\n`),
      pinnedShare
    )
    t.check(
      '8. the link stays on the version just pushed',
      !!pinnedPush &&
        optionOf(pinnedPush, '--id') === deckId &&
        optionOf(pinnedShare, '--to-version') === '3',
      { push: pinnedPush?.argv, share: pinnedShare?.argv }
    )
    t.equal(
      '8. the dialog says the site and the version',
      await text(dialog.locator('[data-create-link-where]')),
      `On Decks (${DECKS}) · version 3`
    )
    t.equal(
      '8. the password field is cleared once the link is made',
      await dialog.locator('[data-create-link-password]').inputValue(),
      ''
    )
    const newest = dialog.locator('[data-create-link-links] li').first()
    t.check(
      '8. the new link says it has a password and stays on version 3',
      /Password/.test(await text(newest)) && /Version 3/.test(await text(newest)),
      await text(newest)
    )

    // ── 9. Revoke ──
    const revoked = dialog.locator(`[data-create-link-token="${firstToken}"]`)
    t.check('9. the first link is listed', (await revoked.count()) === 1, firstToken)
    await revoked.locator('[data-create-link-revoke]').click()
    const beforeRevoke = mark()
    await revoked.locator('[data-create-link-revoke-confirm]').click()
    t.check(
      '9. the link leaves the dialog',
      !!(await until(async () => (await revoked.count()) === 0, 150))
    )
    const unshares = journal(beforeRevoke).filter((call) => has(call, 'unshare'))
    t.check(
      '9. revoked by its token: unshare <deck> --token <token>',
      unshares.length === 1 &&
        after(unshares[0], 'unshare') === deckId &&
        optionOf(unshares[0], '--token') === firstToken &&
        optionOf(unshares[0], '--api-url') === DECKS,
      unshares.map((call) => call.argv)
    )
    await closeDialog()

    // ── 10. A deck gone from its site ──
    const gone = readWorld()
    gone.decks[deckId].gone = true
    writeWorld(gone)
    await openDialog('clave-e2e-deck')
    const beforeGone = mark()
    const said = await submit()
    t.equal(
      '10. the dialog says the deck is no longer on its site',
      said?.gone,
      `The deck ${deckId} is no longer on Decks.`
    )
    t.check('10. and offers the site again', (await siteSelect.count()) === 1)
    t.check(
      '10. the push it tried went to that deck, and was refused as gone',
      journal(beforeGone).some((call) => has(call, 'push') && optionOf(call, '--id') === deckId),
      journal(beforeGone).map((call) => call.argv)
    )
    await pick(win, siteSelect, 'Cloud')
    const beforeNew = mark()
    const remade = await submit()
    t.check(
      '10. Make a new deck makes the link on the site chosen',
      /^https:\/\/cloud\.example\.test\/s\/tok-\d+$/.test(remade?.url ?? ''),
      remade
    )
    const newPushes = journal(beforeNew).filter((call) => has(call, 'push'))
    t.check(
      '10. … pushing --new to the cloud',
      newPushes.length === 1 &&
        has(newPushes[0], '--new', DECK) &&
        optionOf(newPushes[0], '--api-url') === CLOUD,
      newPushes.map((call) => call.argv)
    )
    await closeDialog()

    // ── 11. A dead loopback site, removed where the command offers it ──
    const settings = await toSlideless()
    await settings.locator('[data-slideless-add-input]').fill(DEAD)
    await settings.locator('[data-slideless-add]').click()
    const dead = settings.locator(`[data-slideless-profile="${DEAD}"]`)
    await until(async () => (await dead.count()) === 1)
    await settings.locator('[data-slideless-refresh]').click()
    t.check(
      '11. checked, the dead site does not answer, and its removal is offered',
      !!(await until(
        async () =>
          (await text(dead.locator('[data-line="check"]'))) === 'The site did not answer' &&
          (await dead.locator('[data-slideless-action="remove"]').count()) === 1,
        150
      )),
      await text(dead)
    )
    await dead.locator('[data-slideless-action="remove"]').click()
    t.equal(
      '11. Remove asks first',
      await text(dead.locator('.settings-callout-text')),
      `Forget ${DEAD} on this machine? Its keys are revoked on its site first.`
    )
    const beforeRemove = mark()
    await dead.locator('[data-slideless-remove-confirm]').click()
    t.check(
      '11. the site leaves the page',
      !!(await until(async () => (await dead.count()) === 0, 150))
    )
    const removes = journal(beforeRemove).filter((call) => has(call, 'profiles', 'remove'))
    t.check(
      '11. the command’s own fix ran, at that site',
      removes.length === 1 && has(removes[0], 'dead') && optionOf(removes[0], '--api-url') === DEAD,
      removes.map((call) => call.argv)
    )

    // ── 12. A folder whose link file names a site of no profile here ──
    await toSessions()
    t.check(
      '12. the agent opens a folder whose link file names a site the machine does not list',
      !toolErrored(await client.call('clave_open_artefact', { path: LINKED }))
    )
    await openDialog('clave-e2e-linked')
    const beforeLinked = mark()
    const linked = await submit()
    t.equal(
      '12. Create link refuses it: Clave never signs in at a site only a link file names',
      linked?.refusal,
      `This folder is linked to a deck on ${ELSEWHERE}, which is not one of this machine's Slideless sites: add it with « Add a site » in Settings › Slideless first.`
    )
    t.check(
      '12. nothing was pushed: the journal holds no push',
      journal(beforeLinked).every((call) => !has(call, 'push')),
      journal(beforeLinked).map((call) => call.argv)
    )
    await closeDialog()

    // ── 13. « New links go to » not chosen: the dialog says why it offers the first site ──
    // Settings offers no « Not chosen » once a site is chosen: the setting is cleared on the server.
    t.check(
      '13. « New links go to » cleared on the server',
      (await win.evaluate(() => window.electronAPI.artefacts.setNewLinksSite(null)))
        .newLinksSite === null
    )
    t.check(
      '13. the agent opens a page with no deck yet',
      !toolErrored(await client.call('clave_open_artefact', { path: FRESH }))
    )
    await openDialog('clave-e2e-fresh')
    const firstSite = dialog.locator('[data-create-link-first-site]')
    t.check(
      '13. « New links go to » not chosen: the first site is offered, and a line under it says why',
      !!(await until(
        async () =>
          (await text(firstSite)) ===
          '« New links go to » is not chosen in Settings › Slideless: the first site is offered.'
      )) && (await siteSelect.getAttribute('data-value')) === DECKS,
      { line: await text(firstSite), site: await siteSelect.getAttribute('data-value') }
    )
    await pick(win, siteSelect, 'Cloud')
    t.check(
      '13. once the person picks a site, the line goes',
      !!(await until(
        async () =>
          (await siteSelect.getAttribute('data-value')) === CLOUD && (await firstSite.count()) === 0
      )),
      { line: await text(firstSite), site: await siteSelect.getAttribute('data-value') }
    )
    await closeDialog()

    // Nothing of a secret in the journal's arguments, ever.
    const everything = JSON.stringify(journal().map((call) => call.argv))
    t.check(
      'no code, key or password appears in any call’s arguments',
      ![CODE, WRONG_CODE, KEY, REFUSED_KEY, PASSWORD].some((secret) => everything.includes(secret))
    )
  } finally {
    if (agentId) await callMcp(app, 'closeSession', { sessionId: agentId }).catch(() => {})
    await app.close()
  }
}
