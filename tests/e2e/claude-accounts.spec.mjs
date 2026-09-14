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
import { mkdirSync, rmSync } from 'node:fs'
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
  // The launch profiles this spec makes persist in its user-data dir: start
  // from nothing, or a previous run's profiles multiply the menu's rows.
  rmSync(DIR, { recursive: true, force: true })
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
        // The first boot, before this fixture, read the machine login for
        // real; a window primes from main's snapshot, so that read must not
        // reach the renderer under test either.
        const snapshot = handlers.get('usage:claude-snapshot')
        handlers.set('usage:claude-snapshot', async (event) => {
          const all = await snapshot(event)
          delete all.default
          return all
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
    // The workspace default for claude, resolved in main at the spawn and,
    // after the reload below, known to the renderer's launcher too: a "claude"
    // that prints the token the session started with, the one check a badge
    // cannot fake.
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
    t.check('back on the machine login, the foot reads its own window', await textIs('70% left'), {
      foot: await footer().textContent(),
      snapshot: await win.evaluate(() => window.electronAPI.getClaudeUsageSnapshot()),
      defaultReads: (await fixture()).defaultReads,
      probes: (await fixture()).probes.map((p) => `${p.method} ${p.url} ${p.masked}`)
    })
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
    // A launch just made leaves the caret disabled for a beat; open it once
    // it is back, and retry the click until the menu is there.
    const openCaret = async () => {
      for (let i = 0; i < 10; i++) {
        // Never toggle a menu that is still open or still fading: the click
        // would close it and the entries would be read off the exit animation.
        await win.keyboard.press('Escape')
        await until(async () => (await win.locator('[role="menu"]').count()) === 0, {
          tries: 30,
          gapMs: 100
        })
        await win.locator('.launcher-caret:not([disabled])').waitFor()
        await win.click('.launcher-caret')
        const shown = await win
          .locator('[data-claude-entry="Claude Code"]')
          .waitFor({ timeout: 1_500 })
          .then(() => true, () => false)
        if (shown && (await win.locator('.launcher-caret').getAttribute('data-state')) === 'open') return
      }
      throw new Error('the caret menu never opened')
    }
    await openCaret()
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
    // Two launch profiles (the built-in claude and printenv), so the submenu
    // groups the accounts under each; the rows read are printenv's.
    const accountGroup = (menu) =>
      menu.locator('div').filter({ has: win.locator('.menu-label', { hasText: 'printenv' }) })
    const rows = accountGroup(win.locator('[role="menu"]').last()).locator('[data-claude-account]')
    await until(async () => (await rows.count()) === 2)
    t.equal('hovering Claude Code offers both accounts', await rows.count(), 2)
    const workRowText = await rows.filter({ hasText: 'Work' }).first().textContent()
    t.check("the account row shows the account's headroom", workRowText.includes('Work') && workRowText.includes('90% left'), workRowText)
    await rows.filter({ hasText: 'Work' }).first().click()
    const spawned = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const fresh = list.sessions.filter((s) => s.account?.label === 'Work')
      return fresh.length >= 2 ? fresh : null
    })
    t.check('picking the row starts a session on that account', !!spawned)

    // ── A claude agents tab, and its duplicate, run on the account too ──
    // Round 2 of verification: the clone of an agents tab was on the machine
    // login. Started from the launcher's own submenu, as a user would.
    await win.keyboard.press('Escape')
    const idsBeforeAgents = new Set((await callMcp(app, 'list', {})).sessions.map((s) => s.id))
    await openCaret()
    try {
      await win.locator('[data-claude-entry="Claude Agents"]').hover({ timeout: 8_000 })
    } catch (e) {
      const menus = await win.locator('[role="menu"]').evaluateAll((els) =>
        els.map((el) => ({ open: el.getAttribute('data-state'), text: el.textContent?.slice(0, 200) }))
      )
      const entries = await win.locator('[data-claude-entry]').evaluateAll((els) => els.map((el) => el.getAttribute('data-claude-entry')))
      t.check('the caret menu offers the Claude Agents entry', false, { menus, entries, error: e.message.split('\n')[0] })
      throw e
    }
    // The Claude Code submenu the pointer crossed is still fading out: the
    // Agents submenu is the newest menu in the document.
    const agentsRows = accountGroup(win.locator('[role="menu"]').last()).locator('[data-claude-account]')
    await until(async () => (await agentsRows.count()) === 2)
    await agentsRows.filter({ hasText: 'Work' }).first().click()
    const agents = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.find((s) => !idsBeforeAgents.has(s.id)) ?? null
    })
    t.check('the submenu started a claude agents tab on the account', agents?.mode === 'claude-agents' && agents.account?.label === 'Work', agents)
    await callMcp(app, 'rename', { target: 'session', id: agents.id, name: 'Agents on Work' })
    await callMcp(app, 'focus', { sessionId: agents.id })
    const agentsPrinted = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: agents.id, lines: 40, callerSessionId: agents.id })
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes(`TOKEN=${WORK_TOKEN}`) ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the agents process got the account’s token', !!agentsPrinted)
    const idsBeforeAgentsDup = new Set((await callMcp(app, 'list', {})).sessions.map((s) => s.id))
    await win.locator('.sidebar-item', { hasText: 'Agents on Work' }).first().click({ button: 'right' })
    await win.locator('[role="menuitem"]:has-text("Duplicate")').click()
    const agentsDup = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.find((s) => !idsBeforeAgentsDup.has(s.id)) ?? null
    })
    t.check('the agents duplicate is listed on the account', agentsDup?.account?.label === 'Work', agentsDup?.account)
    await callMcp(app, 'focus', { sessionId: agentsDup.id })
    const agentsDupPrinted = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: agentsDup.id, lines: 40, callerSessionId: agentsDup.id })
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes(`TOKEN=${WORK_TOKEN}`) ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the agents duplicate’s process got the account’s token', !!agentsDupPrinted)

    // ── Duplicate and Resume keep the account ───────────────────────────
    // Round 1 of verification found both spawning on the machine login with
    // an empty token while every readout still said the account.
    const idsBefore = new Set((await callMcp(app, 'list', {})).sessions.map((s) => s.id))
    await win.locator('.sidebar-item', { hasText: 'On Work' }).first().click({ button: 'right' })
    await win.locator('[role="menuitem"]:has-text("Duplicate")').click()
    const duplicate = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.find((s) => !idsBefore.has(s.id)) ?? null
    })
    t.check('Duplicate made a tab', !!duplicate)
    t.check('the duplicate is listed on the source’s account', duplicate?.account?.label === 'Work', duplicate?.account)
    await callMcp(app, 'focus', { sessionId: duplicate.id })
    const dupPrinted = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: duplicate.id, lines: 40, callerSessionId: duplicate.id })
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes(`TOKEN=${WORK_TOKEN}`) ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the duplicate’s process got the account’s token', !!dupPrinted)

    // A profile that prints and exits, so the tab dies and Resume appears.
    await win.evaluate(async (workspaceId) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-printexit',
        name: 'printexit',
        family: 'claude',
        // A short life, long enough for the terminal to attach and read it.
        command: ['sh', '-c', 'printf "TOKEN=%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"; sleep 4'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(workspaceId, 'claude', 'e2e-printexit')
    }, WS.id)
    const mortal = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', account: 'Work', name: 'On Work, dead' })
    await callMcp(app, 'focus', { sessionId: mortal.sessionId })
    const dead = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const s = list.sessions.find((x) => x.id === mortal.sessionId)
      return s && !s.alive ? s : null
    }, { tries: 60, gapMs: 500 })
    t.check('the print-and-exit tab died', !!dead)
    const idsBeforeResume = new Set((await callMcp(app, 'list', {})).sessions.map((s) => s.id))
    await win.locator('.sidebar-item', { hasText: 'On Work, dead' }).first().click({ button: 'right' })
    await win.locator('[role="menuitem"]:has-text("Resume")').first().click()
    const resumed = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.find((s) => !idsBeforeResume.has(s.id)) ?? null
    })
    t.check('Resume made a tab', !!resumed)
    t.check('the resumed tab is listed on the account', resumed?.account?.label === 'Work', resumed?.account)
    const resumedPrinted = await until(
      async () => {
        const read = await callMcp(app, 'readSession', { sessionId: resumed.id, lines: 40, callerSessionId: resumed.id })
        const text = (read?.text ?? '').replace(/\n/g, '')
        return text.includes(`TOKEN=${WORK_TOKEN}`) ? text : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check('the resumed process got the account’s token', !!resumedPrinted, resumedPrinted ?? (await callMcp(app, 'readSession', { sessionId: resumed.id, lines: 40, callerSessionId: resumed.id }).catch((e) => e.message)))

    // ── A removed account keeps its name on the sessions still running on it ─
    await win.evaluate((id) => window.electronAPI.claudeAccountRemove(id), work.id)
    const afterRemoval = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const s = list.sessions.find((x) => x.id === opened.sessionId)
      return s?.account?.removed ? s : null
    })
    t.check('a session on a removed account still names it, flagged removed', afterRemoval?.account?.label === 'Work' && afterRemoval.account.removed === true, afterRemoval?.account)
    await callMcp(app, 'focus', { sessionId: opened.sessionId })
    t.check('the foot still names the removed account', await textIs('Work'))

    // ── Nothing but a token account is ever probed ──────────────────────
    probes = (await fixture()).probes
    t.check('the Default account was never probed', probes.every((p) => p.token !== ''), probes.map((p) => p.masked))
    t.check('every probe went out with a pasted token, never the machine login', probes.every((p) => p.token === WORK_TOKEN || p.token === PLAY_TOKEN), probes.map((p) => p.masked))

    t.equal('no renderer exceptions', errors.length, 0, errors)
  } finally {
    await app.close()
  }
}
