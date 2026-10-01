// Account pools and the switch (ADR 0002): a Claude tab moved from one token
// account to another keeps its id and its conversation and its PROCESS gets
// the other token; a Codex tab moved to another account gets that account's
// own home in `CODEX_HOME`, synced from the machine's, and is resumed on its
// thread; the pool starts a new session on the next account when the
// selected one is at its limit; an agent can move its own tab.
//
// The checks are what the session's own shell prints, never a badge: a
// dropped spawn field renders a perfect UI and runs on the wrong subscription.
import { mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('account-switch')
const ROOT = fixturePath('account-switch-root')
const CODEX_HOME = fixturePath('account-switch-codex-home')
const WS = { id: 'switch-ws', name: 'Switch', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-for-the-switch-run-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-for-the-switch-run-0123456789'

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(CODEX_HOME, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  // The machine's own Codex home: what every other account's home links to.
  mkdirSync(path.join(CODEX_HOME, 'sessions'), { recursive: true })
  mkdirSync(path.join(CODEX_HOME, 'skills'), { recursive: true })
  writeFileSync(path.join(CODEX_HOME, 'config.toml'), 'model = "gpt"\n')
  writeFileSync(path.join(CODEX_HOME, 'auth.json'), '{"machine":true}')
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { env: { CODEX_HOME } })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(
      ({ ipcMain }, { WORK_TOKEN, PLAY_TOKEN }) => {
        const state = (globalThis.__switchFixture = { quota: {}, codexReads: [] })
        const window = (used, kind = 'session') => ({
          key: `${kind}:x`,
          label: kind,
          kind,
          scope: null,
          usedPercentage: used,
          resetsAt: Date.now() + 3600_000,
          severity: null
        })
        const handlers = ipcMain._invokeHandlers
        const original = handlers.get('usage:get-limits')
        // The Default account is the machine login: never read here.
        handlers.set('usage:get-limits', (event, accountId, options) => {
          if (!accountId || accountId === 'default') {
            return { windows: [window(30)], fetchedAt: Date.now() }
          }
          return original(event, accountId, options)
        })
        const snapshot = handlers.get('usage:claude-snapshot')
        handlers.set('usage:claude-snapshot', async (event) => {
          const all = await snapshot(event)
          delete all.default
          return all
        })
        // The probe answers per token, with a quota the test moves.
        state.quota = { [WORK_TOKEN]: 0.1, [PLAY_TOKEN]: 0.2 }
        globalThis.fetch = async (url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const used = state.quota[token]
          if (used === undefined) {
            return new Response('{}', {
              status: 401,
              headers: { 'content-type': 'application/json' }
            })
          }
          const reset = String(Math.floor(Date.now() / 1000) + 3 * 3600)
          return new Response('{}', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'anthropic-ratelimit-unified-5h-utilization': String(used),
              'anthropic-ratelimit-unified-5h-reset': reset,
              'anthropic-ratelimit-unified-5h-status': used >= 0.95 ? 'allowed_warning' : 'allowed'
            }
          })
        }
        // Codex usage: a canned read per account, no codex process.
        ipcMain.removeHandler('usage:get-codex-limits')
        ipcMain.handle('usage:get-codex-limits', (_event, accountId) => {
          state.codexReads.push(accountId ?? 'default')
          return {
            windows: [window(accountId === 'default' || !accountId ? 20 : 10, 'weekly_all')],
            fetchedAt: Date.now()
          }
        })
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    // A "claude" that prints its token and its conversation flags, and a
    // "codex" that prints its home and its argv: the two things a switch
    // must change, read off the process.
    await win.evaluate(async (workspaceId) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-claude-printenv',
        name: 'printenv',
        family: 'claude',
        // The token, and whether the conversation was resumed or started —
        // never the whole argv, whose hook settings run to pages.
        command: [
          'sh',
          '-c',
          'mode=new; prev=""; for a in "$@"; do if [ "$prev" = "--resume" ]; then mode="resume:$a"; fi; if [ "$prev" = "--session-id" ]; then mode="new:$a"; fi; prev="$a"; done; printf "TOKEN=%s MODE=%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN" "$mode"; sleep 120',
          'claude'
        ],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(
        workspaceId,
        'claude',
        'e2e-claude-printenv'
      )
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-codex-printenv',
        name: 'printenv',
        family: 'codex',
        command: ['sh', '-c', 'printf "HOME=%s ARGS=%s\\n" "$CODEX_HOME" "$*"; sleep 120', 'codex'],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(workspaceId, 'codex', 'e2e-codex-printenv')
    }, WS.id)
    // Two Claude token accounts and one Codex account, through the API the
    // Accounts page uses; the Codex credential is written where the login
    // would have put it.
    const accounts = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN }) => {
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        const team = await window.electronAPI.codexAccountAdd({ label: 'Team', kind: 'chatgpt' })
        return { work: work.id, play: play.id, team: team.id }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    const teamHome = path.join(DIR, 'codex-homes', accounts.team)
    mkdirSync(teamHome, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(teamHome, 'auth.json'), '{"team":true}')
    await win.reload()
    await win.waitForSelector('.sidebar-footer-line[data-usage-provider="claude"]')
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const printed = (sessionId, pattern) =>
      until(
        async () => {
          const read = await callMcp(app, 'readSession', {
            sessionId,
            lines: 400,
            callerSessionId: sessionId
          })
          const text = (read?.text ?? '').replace(/\n/g, '')
          return pattern.test(text) ? text : null
        },
        { tries: 60, gapMs: 500 }
      )
    const listed = async (sessionId) =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === sessionId)

    // ── A Claude tab moves from Work to Play, same id, token changed ─────
    const onWork = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Work',
      name: 'Moving'
    })
    await callMcp(app, 'focus', { sessionId: onWork.sessionId })
    const before = await printed(onWork.sessionId, new RegExp(`TOKEN=${WORK_TOKEN} MODE=new`))
    t.check('the tab started on Work, with a fresh conversation', !!before, before?.slice(0, 200))
    const row = win.locator('.sidebar-item', { hasText: 'Moving' }).first()
    await row.click({ button: 'right' })
    const header = win.locator('[data-account-header]')
    await header.waitFor()
    t.equal(
      'the menu header names the account',
      await header.getAttribute('data-account-header'),
      accounts.work
    )
    // The header's chart raises the menu above the cursor; on a row near the
    // top of the sidebar that lift must never carry it off the window.
    await win.waitForTimeout(300)
    const [tabMenuBox, viewport] = await Promise.all([
      win.locator('[role="menu"]').first().boundingBox(),
      win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    ])
    t.check(
      'the tab menu, raised by its chart, stays inside the window',
      !!tabMenuBox &&
        tabMenuBox.y >= 0 &&
        tabMenuBox.x >= 0 &&
        tabMenuBox.y + tabMenuBox.height <= viewport.height &&
        tabMenuBox.x + tabMenuBox.width <= viewport.width,
      JSON.stringify({ tabMenuBox, viewport })
    )
    const switchEntry = win.locator('[role="menuitem"]', { hasText: 'Switch account' })
    t.check('the menu offers one Switch account entry', (await switchEntry.count()) === 1)
    t.check(
      'the accounts are not listed in the menu itself',
      (await win.locator('[role="menuitem"]', { hasText: 'Play' }).count()) === 0
    )
    await switchEntry.hover()
    const submenu = win.locator('[role="menu"]').nth(1)
    await submenu.waitFor()
    const [menuBox, submenuBox] = await Promise.all([
      win.locator('[role="menu"]').first().boundingBox(),
      submenu.boundingBox()
    ])
    t.check(
      'the submenu opens beside the menu, with a gap, never over it',
      !!menuBox && !!submenuBox && submenuBox.x >= menuBox.x + menuBox.width + 4,
      JSON.stringify({ menuBox, submenuBox })
    )
    const switchItem = submenu.locator('[role="menuitem"]', { hasText: 'Play' })
    t.check('the submenu offers the other account', (await switchItem.count()) === 1)
    t.check(
      'the submenu does not offer the account the tab is on',
      (await submenu.locator('[role="menuitem"]', { hasText: 'Work' }).count()) === 0
    )
    const playRow = submenu.locator(`[data-account-switch-row="${accounts.play}"]`)
    const suggested = submenu.locator('[data-account-switch-row][data-suggested="true"]')
    t.equal('exactly one account is suggested', await suggested.count(), 1)
    t.check(
      'the suggested account has headroom',
      (await suggested.first().getAttribute('data-exhausted')) === null
    )
    t.check(
      'the row says what is left, never "(at limit)" in the name',
      /\d+% left/.test(await playRow.innerText()) && !/at limit\)/.test(await playRow.innerText()),
      await playRow.innerText()
    )
    await switchItem.hover()
    const preview = win.locator(`[data-account-preview="${accounts.play}"]`)
    await preview.waitFor({ timeout: 3000 }).catch(() => {})
    t.check('hovering the row shows its usage card', (await preview.count()) === 1)
    const [submenuNow, previewBox] = await Promise.all([
      submenu.boundingBox(),
      win.locator('[data-menu-preview]').boundingBox()
    ])
    t.check(
      'the card sits beside the submenu, not over it',
      !!submenuNow &&
        !!previewBox &&
        (previewBox.x >= submenuNow.x + submenuNow.width ||
          previewBox.x + previewBox.width <= submenuNow.x),
      JSON.stringify({ submenuNow, previewBox })
    )
    t.check(
      'the card draws one column per cap the account reports',
      (await preview.locator('[data-usage-window]').count()) >= 1
    )
    await switchItem.click()
    const after = await printed(onWork.sessionId, new RegExp(`TOKEN=${PLAY_TOKEN} MODE=`))
    t.check('the SAME tab now runs a process with the Play token', !!after, after?.slice(0, 200))
    t.check(
      'the process was told to resume the conversation',
      !!after && new RegExp(`TOKEN=${PLAY_TOKEN} MODE=resume:`).test(after),
      after?.slice(0, 200)
    )
    const moved = await listed(onWork.sessionId)
    t.check(
      'clave_list says the tab is on Play',
      moved?.account?.label === 'Play' && moved.alive,
      moved
    )
    t.check('the tab kept its name', moved?.name === 'Moving', moved?.name)
    t.equal(
      'one tab, not two',
      (await callMcp(app, 'list', {})).sessions.filter((s) => s.name === 'Moving').length,
      1
    )

    // ── An agent asks to move its own tab: proposed first (the default mode) ─
    const byTool = await callMcp(app, 'switchAccount', {
      sessionId: 'mine',
      account: 'Work',
      callerSessionId: onWork.sessionId
    })
    t.check(
      'in propose mode the tool answers with a proposal, not a move',
      byTool?.proposed === true && byTool.switched === false && byTool.account?.label === 'Work',
      byTool
    )
    t.check('the tab is still on Play', (await listed(onWork.sessionId))?.account?.label === 'Play')
    const proposal = win.locator(`[data-account-proposal="${accounts.work}"]`)
    await proposal.waitFor()
    t.check(
      'the header shows the proposed move',
      (await proposal.textContent()).includes('Switch to Work')
    )
    await proposal.locator('[data-account-proposal-accept]').click()
    const back = await printed(onWork.sessionId, new RegExp(`TOKEN=${WORK_TOKEN} MODE=resume:`))
    t.check(
      'accepting the proposal moves the tab back to Work, resumed',
      !!back,
      back?.slice(0, 200)
    )
    t.check(
      'the proposal is gone once accepted',
      (await win.locator('[data-account-proposal]').count()) === 0
    )

    // ── The pool: a new session skips an account at its limit ────────────
    // Work is selected for new sessions, on the Accounts page, and the mode
    // is set to automatic: from here a tab at its limit moves on its own
    // once its agent is idle. Then Work's window fills up.
    await win.locator('.sidebar-footer-line').first().click()
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const accountsPage = win.locator('[data-settings-page="accounts"]')
    await accountsPage.waitFor()
    await accountsPage.getByRole('radio', { name: 'Start new sessions on Work' }).click()
    await accountsPage.getByRole('radio', { name: 'Switch automatically' }).click()
    t.equal(
      'the mode is saved',
      await win.evaluate(() => window.electronAPI.preferencesGet('accountSwitchMode')),
      'automatic'
    )
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    const fresh = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', name: 'Fresh' })
    t.check(
      'with headroom, a new session starts on the selected account',
      (await listed(fresh.sessionId))?.account?.label === 'Work'
    )
    await app.evaluate((_electron, WORK_TOKEN) => {
      globalThis.__switchFixture.quota[WORK_TOKEN] = 0.97
    }, WORK_TOKEN)
    await win.evaluate(async (id) => {
      await window.electronAPI.getUsageLimits(id, { force: true })
    }, accounts.work)
    await until(
      async () => (await win.locator(`[data-account-limit="${accounts.work}"]`).count()) >= 1
    )
    t.check(
      'the rows on Work say it is at limit',
      (await win.locator(`[data-account-limit="${accounts.work}"]`).count()) >= 1
    )
    const next = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', name: 'Next' })
    const nextListed = await listed(next.sessionId)
    t.check(
      'at its limit, a new session starts on the next account of the pool',
      nextListed?.account?.label === 'Play',
      nextListed?.account
    )
    // Automatic mode: the idle tabs on Work move to Play on their own.
    const movedByPolicy = await until(
      async () => {
        const s = await listed(onWork.sessionId)
        return s?.account?.label === 'Play' ? s : null
      },
      { tries: 60, gapMs: 500 }
    )
    t.check(
      'in automatic mode an idle tab at its limit is moved by the policy',
      !!movedByPolicy,
      movedByPolicy?.account
    )
    const policyMoved = await printed(
      onWork.sessionId,
      new RegExp(`TOKEN=${PLAY_TOKEN} MODE=resume:`)
    )
    t.check(
      'the policy resumed the conversation on Play',
      !!policyMoved,
      policyMoved?.slice(0, 200) ??
        (
          await callMcp(app, 'readSession', {
            sessionId: onWork.sessionId,
            lines: 60,
            callerSessionId: onWork.sessionId
          })
        )?.text
          ?.replace(/\n/g, '')
          .slice(0, 700)
    )
    // The policy moved Fresh off Work too; "any" from Play walks the ring on
    // to the Default, the next account with headroom.
    await until(async () => (await listed(fresh.sessionId))?.account?.label === 'Play', {
      tries: 60,
      gapMs: 500
    })
    const anyMove = await callMcp(app, 'switchAccount', {
      sessionId: fresh.sessionId,
      account: 'any'
    })
    t.check(
      '"any" moves a tab to the next account of the ring with headroom',
      anyMove?.switched === true && anyMove.account?.label === 'Default',
      anyMove
    )

    // ── A Codex tab moves to its own home, synced from the machine's ─────
    const codex = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      name: 'Codex moving'
    })
    await callMcp(app, 'focus', { sessionId: codex.sessionId })
    const codexBefore = await printed(codex.sessionId, /HOME=/)
    // The Default account is the machine's own home: the CODEX_HOME the
    // user's shell exports (the fixture's here), passed through untouched.
    t.check(
      'the Codex tab started on the machine home',
      !!codexBefore && codexBefore.includes(`HOME=${CODEX_HOME} ARGS=`),
      codexBefore?.slice(0, 200)
    )
    t.check(
      'clave_list names the Codex account',
      (await listed(codex.sessionId))?.account?.label === 'Default'
    )
    const codexMove = await callMcp(app, 'switchAccount', {
      sessionId: codex.sessionId,
      account: 'Team'
    })
    t.check(
      'the switch answers, without a thread to resume (none in the store)',
      codexMove?.switched && codexMove.resumed === false,
      codexMove
    )
    const codexAfter = await printed(
      codex.sessionId,
      new RegExp(`HOME=${teamHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
    t.check(
      "the same tab's process now runs on the account's home",
      !!codexAfter,
      codexAfter?.slice(0, 200)
    )
    t.check(
      'the home was synced: config, sessions and skills are links to the machine home',
      existsSync(path.join(teamHome, 'config.toml')) &&
        lstatSync(path.join(teamHome, 'sessions')).isSymbolicLink() &&
        lstatSync(path.join(teamHome, 'skills')).isSymbolicLink()
    )
    t.check(
      "the account's own auth.json is untouched",
      readFileSync(path.join(teamHome, 'auth.json'), 'utf-8') === '{"team":true}'
    )
    t.check(
      "the machine's auth.json is untouched",
      readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf-8') === '{"machine":true}'
    )

    // ── A Codex thread is resumed when the store has one ─────────────────
    const day = new Date()
    const rolloutDir = path.join(
      CODEX_HOME,
      'sessions',
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0')
    )
    mkdirSync(rolloutDir, { recursive: true })
    const threadId = '11111111-2222-4333-8444-555555555555'
    writeFileSync(
      path.join(rolloutDir, `rollout-${Date.now()}-${threadId}.jsonl`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: new Date().toISOString(),
          cwd: ROOT,
          thread_source: 'user'
        }
      }) + '\n'
    )
    const codexResumed = await callMcp(app, 'switchAccount', {
      sessionId: codex.sessionId,
      account: 'default'
    })
    t.check(
      'the switch resumed the thread the store holds for this cwd',
      codexResumed?.resumed === true,
      codexResumed
    )
    const resumedText = await printed(codex.sessionId, new RegExp(`resume.*${threadId}`))
    t.check(
      'the process was told to resume that thread, on the machine home again',
      !!resumedText && resumedText.includes(`HOME=${CODEX_HOME} ARGS=`),
      resumedText?.slice(0, 200)
    )

    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
  }
}
