// One vocabulary for a cap that is out, in the readouts no other spec reaches
// (PRDCT-4254): the Settings → Accounts row, the sidebar row's warning, the
// proposal badge in the pane's header and the Switch account rows. Two token
// accounts: Work has its week at 40% and its Fable cap spent, Play is open.
// A tab on Fable on Work is what each readout is read on; never a bare
// "At limit", and the Fable week spent never reads as the account out.
//
// Pinned to the in-process server (`server: 'in-process'`): the quota comes
// from a probe stubbed in this process, which only the in-process server
// consults.
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('cap-words')
const ROOT = fixturePath('cap-words-root')
const WS = { id: 'cap-words-ws', name: 'Cap words', rootDir: ROOT, profileFile: null, createdAt: 1 }
const WORK_TOKEN = 'sk-ant-oat01-work-token-for-the-cap-words-run-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-for-the-cap-words-run-0123456789'

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    args: ['--test-no-machine-usage']
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(
      (_electron, { WORK_TOKEN, PLAY_TOKEN }) => {
        const settings = globalThis.__claveE2E?.settings
        if (!settings) throw new Error('no settings source: is --test-no-activate on?')
        const original = settings.usage.readClaude
        // The machine login is never read here.
        settings.usage.readClaude = async (accountId, force) => {
          if (accountId === undefined || accountId === 'default')
            return { windows: [], fetchedAt: Date.now() }
          return original(accountId, force)
        }
        const reset = (hours) => String(Math.floor(Date.now() / 1000) + hours * 3600)
        // Work: the 5-hour block at 20%, the week at 40%, the Fable cap spent.
        // Play: open everywhere.
        const windows = {
          [WORK_TOKEN]: { block: '0.2', week: '0.4', fable: true },
          [PLAY_TOKEN]: { block: '0.1', week: '0.1', fable: false }
        }
        globalThis.fetch = async (_url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const w = windows[token]
          if (!w) return new Response('{}', { status: 401 })
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
    // A "claude" that stays alive, so the tab is live for the policy and the
    // row's warning; the model asked for is read off nothing here.
    const accounts = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN, workspaceId }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'e2e-claude-sleep',
          name: 'sleep',
          family: 'claude',
          command: ['sh', '-c', 'sleep 120', 'claude'],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetWorkspace(
          workspaceId,
          'claude',
          'e2e-claude-sleep'
        )
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        return { work: work.id, play: play.id }
      },
      { WORK_TOKEN, PLAY_TOKEN, workspaceId: WS.id }
    )
    await win.reload()
    await win.waitForSelector('.sidebar-panel', { timeout: 20_000 })
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    // Both reads landed: Work's row on the Accounts page names its Fable cap.
    await win.evaluate(async ({ work, play }) => {
      await window.electronAPI.getUsageLimits(work, { force: true })
      await window.electronAPI.getUsageLimits(play, { force: true })
    }, accounts)
    const text = async (locator) =>
      ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim()

    // ── Settings → Accounts: the shared headroom, then the family that is out ──
    await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await win.locator('[data-settings-nav-row="accounts"]').click()
    const accountsPage = win.locator('[data-settings-page="accounts"]')
    await accountsPage.waitFor()
    const workRow = accountsPage.locator(`[data-claude-account-row="${accounts.work}"]`)
    await workRow.waitFor()
    await until(async () => /Fable out/.test(await text(workRow)))
    const workRowText = await text(workRow)
    t.check(
      'the Work row reads its shared headroom first, then "Fable out · back in"',
      /60% left · Overall · Fable out · back in 2d/.test(workRowText),
      workRowText
    )
    t.check('and never a bare "at limit"', !/at limit/i.test(workRowText), workRowText)
    t.equal(
      'the Work row is not marked exhausted: a family cap out is not the account out',
      await workRow.getAttribute('data-account-exhausted'),
      null
    )
    t.equal(
      'the row carries the family that is out',
      await workRow.getAttribute('data-account-scoped-out'),
      'Fable'
    )
    const playRow = accountsPage.locator(`[data-claude-account-row="${accounts.play}"]`)
    t.check(
      'the Play row reads its headroom alone',
      /90% left · Overall/.test(await text(playRow)) && !/out/.test(await text(playRow)),
      await text(playRow)
    )
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()

    // ── A tab on Fable on Work: the row's warning and the proposal name the cap ──
    const onWork = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Work',
      name: 'Fable on Work',
      model: 'claude-fable-5-1'
    })
    await callMcp(app, 'focus', { sessionId: onWork.sessionId })
    const warning = win.locator(`[data-account-limit="${accounts.work}"]`)
    await warning.first().waitFor({ timeout: 15_000 })
    t.check(
      'the sidebar row’s warning names the cap and its return',
      /^Fable out · back in 2d/.test((await warning.first().getAttribute('aria-label')) ?? ''),
      await warning.first().getAttribute('aria-label')
    )
    const proposal = win.locator(`[data-account-proposal="${accounts.play}"]`)
    await proposal.first().waitFor({ timeout: 15_000 })
    const proposalText = await text(proposal.first())
    t.check(
      'the proposal badge names the cap that is out, and the way on',
      /^Fable out · back in 2d.*Switch to Play/.test(proposalText),
      proposalText
    )
    t.check('and never "At limit" nor "Limit reached"', !/limit/i.test(proposalText), proposalText)

    // ── The Switch account rows: the open account by what is left ──
    const row = win.locator('.sidebar-item', { hasText: 'Fable on Work' }).first()
    await row.click({ button: 'right' })
    const header = win.locator('[data-account-header]')
    await header.waitFor()
    const headerText = await text(header)
    t.check(
      'the tab menu’s header names the cap that stops this tab, then what the account has left',
      /^Work.*Fable out · back in 2d.*60% left · Overall/.test(headerText),
      headerText
    )
    const switchEntry = win.locator('[role="menuitem"]', { hasText: 'Switch account' })
    await switchEntry.hover()
    const submenu = win.locator('[role="menu"]').nth(1)
    await submenu.waitFor()
    const playTarget = submenu.locator(`[data-account-switch-row="${accounts.play}"]`)
    await playTarget.waitFor()
    t.check(
      'the Play row reads what is left of it',
      /^\d+% left$/.test(await text(playTarget.locator('.account-switch-left'))),
      await text(playTarget)
    )
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    // ── Seen from a tab on Fable on Play: Work is out on Fable, back in 2d ──
    const onPlay = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Play',
      name: 'Fable on Play',
      model: 'claude-fable-5-1'
    })
    await callMcp(app, 'focus', { sessionId: onPlay.sessionId })
    const playTab = win.locator('.sidebar-item', { hasText: 'Fable on Play' }).first()
    await playTab.click({ button: 'right' })
    await win.locator('[data-account-header]').waitFor()
    await win.locator('[role="menuitem"]', { hasText: 'Switch account' }).hover()
    const submenu2 = win.locator('[role="menu"]').nth(1)
    await submenu2.waitFor()
    const workTarget = submenu2.locator(`[data-account-switch-row="${accounts.work}"]`)
    await workTarget.waitFor()
    t.equal(
      'the Work row’s badge names the cap that is out, once',
      await text(workTarget.locator('.account-switch-left')),
      'Fable out'
    )
    t.check(
      'and its detail says when it comes back, then what the account has left',
      /^Back in 2d.*60% left · Overall$/.test(
        await text(workTarget.locator('.account-switch-detail'))
      ),
      await text(workTarget.locator('.account-switch-detail'))
    )
    t.equal(
      'the Work row is marked exhausted for a tab on Fable',
      await workTarget.getAttribute('data-exhausted'),
      'true'
    )
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    // ── The same Work account from a tab on Opus: open, 60% left ──
    const onOpus = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Play',
      name: 'Opus on Play',
      model: 'claude-opus-5-5'
    })
    await callMcp(app, 'focus', { sessionId: onOpus.sessionId })
    const opusTab = win.locator('.sidebar-item', { hasText: 'Opus on Play' }).first()
    await opusTab.click({ button: 'right' })
    await win.locator('[data-account-header]').waitFor()
    await win.locator('[role="menuitem"]', { hasText: 'Switch account' }).hover()
    const submenu3 = win.locator('[role="menu"]').nth(1)
    await submenu3.waitFor()
    const workForOpus = submenu3.locator(`[data-account-switch-row="${accounts.work}"]`)
    await workForOpus.waitFor()
    t.equal(
      'for a tab on Opus the Work row reads what is left of its week',
      await text(workForOpus.locator('.account-switch-left')),
      '60% left'
    )
    t.equal('and is not marked exhausted', await workForOpus.getAttribute('data-exhausted'), null)
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    t.equal('no renderer exceptions', errors.length, 0)
  } finally {
    await app.close()
  }
}
