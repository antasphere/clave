// Claude accounts (PRDCT-2296): a subscription pasted once as a token, its
// usage read on its own, a session started on it from the launcher, from an
// agent's clave_open_session, and named in the session's menu and the foot.
//
// What this spec proves that nothing else can: the account reaches the
// PROCESS. A dropped spawn field renders a perfect UI and runs on the wrong
// subscription, so the check is the token printed by the session's own shell,
// not a badge.
//
// The machine's own login is never read: the Default account's channel is
// stubbed, and the probe a token account reads with is a stubbed fetch in the
// main process answering the unified rate-limit headers per token.
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir
} from './harness.mjs'

const DIR = userDataDir('claude-accounts')
const ROOT = '/tmp/clave-e2e-claude-accounts-root'
const WS = { id: 'accounts-ws', name: 'Accounts', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-for-the-e2e-run-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-for-the-e2e-run-0123456789'

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR)
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(
      ({ ipcMain }, { WORK_TOKEN, PLAY_TOKEN }) => {
        const state = (globalThis.__accountsFixture = { probes: [], defaultReads: 0 })
        // The Default account is the machine login: never read here. Every
        // other account goes through the real manager and the stubbed probe.
        const handlers = ipcMain._invokeHandlers
        const original = handlers.get('usage:get-limits')
        handlers.set('usage:get-limits', (event, accountId, options) => {
          if (!accountId || accountId === 'default') {
            state.defaultReads++
            return {
              windows: [
                {
                  key: 'session:Current session (5h)',
                  label: 'Current session (5h)',
                  kind: 'session',
                  scope: null,
                  usedPercentage: 30,
                  resetsAt: Date.now() + 3600_000,
                  severity: null
                }
              ],
              fetchedAt: Date.now()
            }
          }
          return original(event, accountId, options)
        })
        // The probe: a one-token message whose headers carry the quota. Which
        // account answered is decided by the bearer token, as the API does.
        const byToken = {
          [WORK_TOKEN]: { fiveHour: '0.10', sevenDay: '0.05', status: 'allowed' },
          [PLAY_TOKEN]: { fiveHour: '0.85', sevenDay: '0.40', status: 'allowed_warning' }
        }
        globalThis.fetch = async (url, init) => {
          const auth = init?.headers?.Authorization ?? ''
          const token = auth.replace(/^Bearer /, '')
          state.probes.push({ url: String(url), method: init?.method ?? 'GET', token })
          const quota = byToken[token]
          if (!quota) {
            return new Response(JSON.stringify({ type: 'error' }), {
              status: 401,
              headers: { 'content-type': 'application/json' }
            })
          }
          const reset = String(Math.floor(Date.now() / 1000) + 3 * 3600)
          return new Response(JSON.stringify({ type: 'message', content: [] }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': quota.fiveHour,
              'anthropic-ratelimit-unified-5h-reset': reset,
              'anthropic-ratelimit-unified-5h-status': quota.status,
              'anthropic-ratelimit-unified-7d-utilization': quota.sevenDay,
              'anthropic-ratelimit-unified-7d-reset': String(Number(reset) + 86400 * 4),
              'anthropic-ratelimit-unified-7d-status': 'allowed',
              'anthropic-ratelimit-unified-status': quota.status
            }
          })
        }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    await win.reload()
    await win.waitForSelector('.sidebar-footer-line[data-usage-provider="claude"]')
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    // Never a token in a failure detail: a real one could be read alongside.
    const mask = (token) => (token ? `${token.slice(0, 14)}…(${token.length})` : '(none)')
    const fixture = async () => {
      const f = await app.evaluate(() => globalThis.__accountsFixture)
      return { ...f, probes: f.probes.map((p) => ({ ...p, masked: mask(p.token) })) }
    }
    const footer = () => win.locator('.sidebar-footer-line')
    const textIs = async (text) =>
      !!(await until(async () => (await footer().textContent())?.includes(text)))
    const back = () => win.getByRole('button', { name: 'Back to sessions', exact: true }).click()

    // ── Settings: paste a token, see it proven ───────────────────────────
    await footer().click()
    const claudePanel = win.locator('div[data-usage-provider="claude"]')
    await claudePanel.waitFor()
    t.equal(
      'one account: the Claude tab shows the machine login alone',
      await claudePanel.locator('[data-claude-account-usage]').count(),
      1
    )
    await claudePanel.getByRole('button', { name: 'Add account', exact: true }).click()
    const form = claudePanel.locator('[data-claude-token-form]')
    await form.waitFor()
    await form.getByLabel('Account name').fill('Work')
    await form.getByLabel('Claude Code token').fill(WORK_TOKEN)
    await form.getByRole('button', { name: 'Add account', exact: true }).click()
    await form.locator('[data-claude-token-note]').waitFor()
    const note = await form.locator('[data-claude-token-note]').textContent()
    t.equal('the paste was accepted', await form.locator('[data-claude-token-note]').getAttribute('data-claude-token-note'), 'ok')
    t.check('the paste is proven by a read: 90% left on the 5-hour window', note.includes('90% left'), note)
    t.check('the note says which window', note.includes('session'), note)
    let probes = (await fixture()).probes
    t.equal('the read went through the probe with that token', probes.length, 1)
    t.check('the probe carries the token as a bearer', probes[0].token === WORK_TOKEN, probes[0].masked)
    t.check('the probe is a message, not the usage endpoint', probes[0].url.endsWith('/v1/messages') && probes[0].method === 'POST', { url: probes[0].url, method: probes[0].method })
    await form.getByRole('button', { name: 'Done', exact: true }).click()

    t.equal(
      'two accounts: two cards on the Claude tab',
      await claudePanel.locator('[data-claude-account-usage]').count(),
      2
    )
    const workCard = claudePanel.locator('[data-claude-account-usage]').nth(1)
    await workCard.locator('[data-usage-window]').first().waitFor()
    t.equal(
      "the Work card shows the Work account's windows",
      await workCard.locator('[data-usage-window="session:Current session (5h)"] [aria-label]').getAttribute('aria-label'),
      '10% used'
    )
    t.check('the Work card names the account and its credential', (await workCard.textContent()).includes('Work') && (await workCard.textContent()).includes('Token'))

    // A refused token leaves no half-account behind.
    await claudePanel.getByRole('button', { name: 'Add account', exact: true }).click()
    await form.getByLabel('Account name').fill('Broken')
    await form.getByLabel('Claude Code token').fill('not-a-token')
    await form.getByRole('button', { name: 'Add account', exact: true }).click()
    await form.locator('[data-claude-token-note="error"]').waitFor()
    t.check(
      'a value that is not a token is refused with a reason',
      (await form.locator('[data-claude-token-note]').textContent()).includes('does not look like')
    )
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    t.equal(
      'the refused account was not kept',
      await claudePanel.locator('[data-claude-account-row]').count(),
      2
    )
    const accounts = await win.evaluate(() => window.electronAPI.claudeAccountsList())
    t.equal('main knows the two accounts', accounts.length, 2)
    t.check('the renderer never sees the token', !JSON.stringify(accounts).includes(WORK_TOKEN))
    const work = accounts.find((a) => a.label === 'Work')
    t.check('the account reports it holds a token', work?.hasToken === true, work)
    await back()

    // ── An agent opens a tab on the account, and the process gets the token ─
    // A launch profile whose "claude" prints the token the session started
    // with: the one check a badge cannot fake.
    // The workspace default for claude, resolved in main at the spawn: the
    // renderer's copy of the launch profiles is not what runs.
    await win.evaluate(async (workspaceId) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-printenv',
        name: 'printenv',
        family: 'claude',
        command: ['sh', '-c', 'printf "TOKEN=%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"; sleep 60'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(workspaceId, 'claude', 'e2e-printenv')
    }, WS.id)
    let rejected = null
    try {
      await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', account: 'Nobody' })
    } catch (e) {
      rejected = e.message
    }
    t.check('an unknown account is refused, naming the ones that exist', rejected?.includes('Unknown Claude account "Nobody"') && rejected.includes('"Work"'), rejected)
    let wrongMode = null
    try {
      await callMcp(app, 'openSession', { cwd: ROOT, mode: 'codex', account: 'Work' })
    } catch (e) {
      wrongMode = e.message
    }
    t.check('an account on another agent is refused', wrongMode?.includes('claude mode only'), wrongMode)

    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Work',
      name: 'On Work'
    })
    await callMcp(app, 'focus', { sessionId: opened.sessionId })
    const printed = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: opened.sessionId, lines: 40, callerSessionId: opened.sessionId })
        // The terminal wraps a long line at its width: read it unwrapped.
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes(`TOKEN=${WORK_TOKEN}`) ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the session started on the account got its token in the environment', !!printed)
    const listed = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === opened.sessionId)
    t.check('clave_list names the account the tab runs on', listed?.account?.label === 'Work' && listed.account.id === work.id, listed?.account)

    t.check('the foot follows the focused tab onto its account', await textIs('90% left'))
    t.check('the foot names the account', (await footer().textContent()).includes('Work'))
    t.equal('the foot carries the account for the tests', await footer().getAttribute('data-usage-account'), 'Work')

    // The Default account: the machine login, never probed.
    const onDefault = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', account: 'default', name: 'On Default' })
    await callMcp(app, 'focus', { sessionId: onDefault.sessionId })
    t.check('back on the machine login, the foot reads its own window', await textIs('70% left'))
    const defaultPrinted = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: onDefault.sessionId, lines: 40, callerSessionId: onDefault.sessionId })
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes('TOKEN=') ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the Default tab printed its (empty) token line', !!defaultPrinted, defaultPrinted?.slice(0, 200))
    t.check('the Default account injects no token', !(defaultPrinted ?? '').includes('sk-ant-'), defaultPrinted?.slice(0, 200))

    // ── The session's menu says which account ───────────────────────────
    const workRow = win.locator('.sidebar-item', { hasText: 'On Work' }).first()
    await workRow.click({ button: 'right' })
    const header = win.locator('[data-claude-account-header]')
    await header.waitFor()
    t.equal('the menu header carries the account id', await header.getAttribute('data-claude-account-header'), work.id)
    const headerText = await header.textContent()
    t.check('the menu header names the account, its credential and its headroom', headerText.includes('Work') && headerText.includes('Token') && headerText.includes('90% left'), headerText)
    await win.keyboard.press('Escape')

    // ── The launcher: aligned on the agent button, accounts on hover ─────
    await win.click('.launcher-caret')
    const menu = win.locator('[role="menu"]').first()
    await menu.waitFor()
    const [menuBox, buttonBox] = await Promise.all([
      menu.boundingBox(),
      win.locator('[data-launcher-agent]').boundingBox()
    ])
    // A .menu-item's logo sits 13px into the menu, the button's 8px into the
    // button: the menu's left edge is 5px left of the button's.
    const drift = Math.abs(menuBox.x + 5 - buttonBox.x)
    t.check('the menu hangs off the agent button, logos on one vertical', drift <= 1.5, { menu: menuBox.x, button: buttonBox.x })
    const claudeEntry = win.locator('[data-claude-entry="Claude Code"]')
    await claudeEntry.hover()
    const rows = win.locator('[data-claude-account]')
    await until(async () => (await rows.count()) === 2)
    t.equal('hovering Claude Code offers both accounts', await rows.count(), 2)
    const workRowText = await win.locator(`[data-claude-account="${work.id}"]`).textContent()
    t.check("the account row shows the account's headroom", workRowText.includes('Work') && workRowText.includes('90% left'), workRowText)
    await win.locator(`[data-claude-account="${work.id}"]`).click()
    const spawned = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const fresh = list.sessions.filter((s) => s.account?.label === 'Work')
      return fresh.length >= 2 ? fresh : null
    })
    t.check('picking the row starts a session on that account', !!spawned)

    // ── Nothing but a token account is ever probed ──────────────────────
    probes = (await fixture()).probes
    t.check('the Default account was never probed', probes.every((p) => p.token !== ''), probes.map((p) => p.masked))
    t.check('every probe went out with a pasted token, never the machine login', probes.every((p) => p.token === WORK_TOKEN || p.token === PLAY_TOKEN), probes.map((p) => p.masked))

    t.equal('no renderer exceptions', errors.length, 0, errors)
  } finally {
    await app.close()
  }
}
