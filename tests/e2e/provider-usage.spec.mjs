// Pinned to the in-process server (wave 3 of the server/client split,
// PRDCT-3293): this spec opens a session through the agent tools, which main
// still answers from its own session host; attached, that host is not the
// server's, so the pin goes when the tools answer from the server (lane D,
// PRDCT-3294). Not a known failure.
//
// Pinned to the in-process server (`server: 'in-process'`): the quota it shows
// comes from a read stubbed on the shell's settings source
// (`globalThis.__claveE2E.settings`), which only the in-process server consults;
// an attached app answers its settings from the standalone server's own data
// directory, where no fixture in this process reaches. The attached-mode
// fixture seam is wave 3's, beside the Node terminal process (the wave's
// ruling of 6 October 2026).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

const DIR = userDataDir('provider-usage')
const ROOT = fixturePath('provider-usage-root')
const WS = { id: 'usage-workspace', name: 'Usage', rootDir: ROOT, profileFile: null, createdAt: 1 }
// Pi's own session records (PRDCT-4551): Clave reads Pi's usage from Pi's
// session files, here only from this folder (`CLAVE_PI_ROOT`).
const PI_SESSIONS = path.join(ROOT, 'pi-sessions')
const DAY = 24 * 3600_000

/** One Pi session file of model calls, as Pi 1.5.2 writes them: a header,
 *  then an assistant message carrying its usage per call. Made-up values. */
function writePiSession(folder, id, at, calls) {
  const dir = path.join(PI_SESSIONS, folder)
  mkdirSync(dir, { recursive: true })
  const when = new Date(at).toISOString()
  const lines = [
    { type: 'session', version: 3, id, timestamp: when, cwd: '/elsewhere' },
    ...calls.map((usage, i) => ({
      type: 'message',
      id: `m${i + 1}`,
      parentId: i ? `m${i}` : null,
      timestamp: when,
      message: {
        role: 'assistant',
        content: [],
        provider: 'stand-in',
        model: 'one',
        usage: { cacheWrite: 0, ...usage, cost: { total: usage.cost ?? 0 } },
        stopReason: 'stop',
        timestamp: at
      }
    }))
  ]
  writeFileSync(
    path.join(dir, `${when.replace(/[:.]/g, '-')}_${id}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  )
}

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  // Today: one call of 1,000 tokens and one call read wholly from Pi's cache
  // (3,000 cached tokens). Three days ago: one call of 6,000 tokens, counted
  // in the last 7 days and never today. No Clave tab made these sessions, so
  // they are "Other sessions", never Pi's sign-in.
  const now = Date.now()
  writePiSession('--today--', '11111111-1111-4111-8111-111111111111', now - 1_000, [
    { input: 800, output: 200, cacheRead: 0, totalTokens: 1000, cost: 0.125 },
    { input: 0, output: 0, cacheRead: 3000, totalTokens: 3000 }
  ])
  writePiSession('--earlier--', '22222222-2222-4222-8222-222222222222', now - 3 * DAY, [
    { input: 5000, output: 1000, cacheRead: 0, totalTokens: 6000 }
  ])
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // No machine-login read: a real read of this Mac's own login landing after
  // the canned one below overwrote the foot's numbers once in a while (seen
  // 9 November 2026, three Claude checks red on one run and green the next).
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    args: ['--test-no-machine-usage'],
    env: { CLAVE_PI_ROOT: PI_SESSIONS }
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(({ ipcMain }) => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      // Keep real renderer session selection and IPC, but never start an agent
      // or query a real account in this fixture.
      ipcMain.removeHandler('pty:spawn')
      let id = 0
      ipcMain.handle('pty:spawn', (_event, cwd) => ({
        id: `usage-${++id}`,
        cwd,
        folderName: 'usage',
        alive: true
      }))
      const state = (globalThis.__usageFixture = {
        calls: { claude: 0, codex: 0 },
        used: 82,
        error: false,
        hold: false
      })
      const window = (key, usedPercentage, kind = 'weekly_all') => ({
        key,
        label: key,
        kind,
        scope: null,
        usedPercentage,
        resetsAt: Date.now() + 3600_000,
        severity: null
      })
      settings.usage.readClaude = async () => {
        state.calls.claude++
        return { windows: [window('Claude weekly', 30)], fetchedAt: Date.now() }
      }
      settings.usage.readCodex = async () => {
        state.calls.codex++
        if (state.hold)
          await new Promise((r) => {
            state.release = r
          })
        if (state.error)
          return { error: 'Sign in to Codex CLI with ChatGPT to see your usage limits.' }
        return {
          windows: [window('Codex weekly', state.used), window('Codex 5-hour', 20, 'session')],
          fetchedAt: Date.now()
        }
      }
    })
    await win.reload()
    await win.waitForSelector('.sidebar-footer-line[data-usage-provider="claude"]')
    // Wait for renderer restoration before adding sessions through its real dispatcher.
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const footer = () => win.locator('.sidebar-footer-line')
    const textIs = async (text) =>
      !!(await until(async () => (await footer().textContent())?.includes(text)))
    const panel = (provider) => win.locator(`div[data-usage-provider="${provider}"]`)
    const back = () => win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    // The page's one Refresh, in its sticky header, outside the provider panel.
    const refreshButton = () =>
      win.locator('[data-settings-page="usage"]').getByRole('button', { name: 'Refresh usage' })
    const focus = (sessionId) => callMcp(app, 'focus', { sessionId })

    const claude = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      name: 'Claude usage'
    })
    t.check('Claude footer reads percent remaining', await textIs('70% left'))
    const codex = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      name: 'Codex usage'
    })
    t.check(
      'Codex session immediately switches to its own tightest limit',
      await textIs('18% left')
    )
    t.equal('footer names Codex', await footer().getAttribute('data-usage-provider'), 'codex')
    await footer().click()
    await panel('codex').waitFor()
    t.equal(
      'footer opens the Codex tab',
      await panel('codex')
        .getByRole('button', { name: 'Codex', exact: true })
        .getAttribute('aria-pressed'),
      'true'
    )
    t.equal(
      'the panel shows every quota window',
      await panel('codex').locator('[data-usage-window]').count(),
      2
    )
    t.equal(
      'panel percent used complements footer percent remaining',
      await panel('codex')
        .locator('[data-usage-window="Codex weekly"] [aria-label]')
        .getAttribute('aria-label'),
      '82% used'
    )
    t.equal(
      'opening settings reuses the footer request',
      await app.evaluate(() => globalThis.__usageFixture.calls.codex),
      1
    )

    await app.evaluate(() => {
      globalThis.__usageFixture.used = 91
    })
    await refreshButton().click()
    await win.waitForSelector('[aria-label="91% used"]')
    t.check(
      'the header says the numbers were just read',
      !!(await until(async () =>
        (await win.locator('[data-usage-age]').textContent())?.includes('Updated just now')
      ))
    )
    t.equal(
      'the weekly chart holds the weekly cap',
      await panel('codex').locator('[data-usage-chart="weekly"] [data-usage-window]').count(),
      1
    )
    t.equal(
      'the 5-hour block has a chart of its own',
      await panel('codex').locator('[data-usage-chart="session"] [data-usage-window]').count(),
      1
    )
    t.check(
      'the headline names the cap closest to its limit',
      (await panel('codex').locator('[data-usage-headlines]').textContent()).includes('91% used')
    )
    await back()
    t.check('refresh updates the shared footer too', await textIs('9% left'))

    await focus(claude.sessionId)
    t.check('switching back restores Claude without Codex data', await textIs('70% left'))
    // Pi's usage is counted per connection (PRDCT-4551), from Pi's own
    // session records. This tab runs on no connection and made no call, so
    // its foot names Pi's own sign-in and says its figure; the sessions Clave
    // did not start are "Other sessions", in Settings → Usage alone.
    const pi = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'pi', name: 'Pi usage' })
    const SIGN_IN_TODAY = 'Pi sign-in · 0 requests · 0 tokens today'
    t.check(
      'Pi footer names whose figure it is: Pi’s own sign-in, today',
      await textIs(SIGN_IN_TODAY),
      await footer().textContent()
    )
    t.equal('Pi does not invent quota headroom', await footer().locator('.usage-meter').count(), 0)
    await footer().click()
    await panel('pi').waitFor()
    const otherRow = panel('pi').locator('[data-harness-usage-row="other"]')
    const signInRow = panel('pi').locator('[data-harness-usage-row="sign-in"]')
    const rowText = async (row) => (await row.innerText().catch(() => '')).replace(/\s+/g, ' ')
    const otherToday = await until(async () => {
      const text = await rowText(otherRow)
      return text.includes('Total tokens 4,000') ? text : null
    })
    t.check(
      'Pi panel counts today from Pi’s own records, under "Other sessions"',
      !!otherToday && otherToday.includes('2 requests · 4K tokens today'),
      otherToday ?? (await rowText(otherRow))
    )
    t.check(
      'Pi panel says what each figure is',
      (otherToday ?? '').includes('Sessions Clave did not start') &&
        (await rowText(signInRow)).includes("The harness's own sign-in"),
      { other: otherToday, signIn: await rowText(signInRow) }
    )
    t.check(
      'Pi panel counts today’s cached request',
      !!otherToday && otherToday.includes('Requests 2') && otherToday.includes('Cache read 3,000'),
      otherToday
    )
    t.check(
      'Pi panel says no cost where Pi’s use is not known to be billed per use',
      !!otherToday && !otherToday.includes('$'),
      otherToday
    )
    await panel('pi').getByRole('button', { name: '7d', exact: true }).click()
    const otherWeek = await until(async () => {
      const text = await rowText(otherRow)
      return text.includes('Total tokens 10,000') ? text : null
    })
    t.check(
      'Pi panel counts the last 7 days, the earlier session included',
      !!otherWeek && otherWeek.includes('in the last 7 days'),
      otherWeek ?? (await rowText(otherRow))
    )
    await back()
    t.check('Pi historical ranges never replace today’s footer totals', await textIs(SIGN_IN_TODAY))

    await focus(codex.sessionId)
    await footer().click()
    await app.evaluate(() => {
      globalThis.__usageFixture.error = true
    })
    await refreshButton().click()
    await panel('codex')
      .getByText('Sign in to Codex CLI with ChatGPT to see your usage limits.')
      .waitFor()
    t.equal(
      'failed reads clear stale quota bars',
      await panel('codex').locator('[data-usage-window]').count(),
      0
    )
    await back()
    t.check(
      'failed Codex usage never falls back to Claude’s percentage',
      await textIs('Codex · Usage unavailable')
    )

    await footer().click()
    await app.evaluate(() => {
      globalThis.__usageFixture.error = false
      globalThis.__usageFixture.hold = true
    })
    await panel('codex').getByRole('button', { name: 'Retry', exact: true }).click()
    await until(() => app.evaluate(() => !!globalThis.__usageFixture.release))
    await back()
    await focus(claude.sessionId)
    await app.evaluate(() => {
      globalThis.__usageFixture.hold = false
      globalThis.__usageFixture.release()
    })
    t.check(
      'a late Codex response cannot replace the focused Claude quota',
      await textIs('70% left')
    )
    await focus(codex.sessionId)
    t.check('the late response remains available in Codex’s cache', await textIs('9% left'))

    // Check the same controls under every shipped theme in the real renderer.
    await footer().click()
    for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
      await win.evaluate((value) => window.electronAPI.skinsActivate(value), theme)
      const geometry = await panel('codex').evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth
      }))
      t.check(
        `${theme}: provider controls fit the panel`,
        geometry.width > 0 && geometry.scroll <= geometry.width,
        geometry
      )
    }

    // The settings header stays in place while the page scrolls under it, and
    // draws its hairline only once something has gone under.
    await win.locator('[data-settings-nav-row="general"]').click()
    const general = win.locator('[data-settings-page="general"]')
    await general.waitFor()
    const header = general.locator('.settings-page-header')
    t.equal(
      'at rest the header draws no hairline',
      await header.getAttribute('data-scrolled'),
      null
    )
    const stuck = await general.evaluate(async (page) => {
      const scroller = page.closest('.settings-scroller')
      const head = page.querySelector('.settings-page-header')
      scroller.scrollTop = 600
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      return {
        scrolled: scroller.scrollTop,
        gap: Math.round(head.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
      }
    })
    t.check(
      'scrolled, the header stays at the top of the pane',
      stuck.scrolled > 0 && stuck.gap === 0,
      stuck
    )
    t.equal(
      'scrolled, the header draws its hairline',
      await header.getAttribute('data-scrolled'),
      'true'
    )
    await general.evaluate((page) => {
      page.closest('.settings-scroller').scrollTop = 0
    })
    t.check(
      'back at the top, the hairline goes',
      !!(await until(async () => (await header.getAttribute('data-scrolled')) === null))
    )
    await back()
    await focus(pi.sessionId)
    await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'Plain terminal' })
    t.equal(
      'plain terminals do not show another agent’s quota',
      await win.locator('.sidebar-footer-line[data-usage-provider]').count(),
      0
    )
    t.equal('no renderer exceptions', errors.length, 0)
  } finally {
    await app.close()
  }
}
