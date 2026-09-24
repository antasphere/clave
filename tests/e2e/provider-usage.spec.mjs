import { mkdirSync } from 'node:fs'
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

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR)
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(({ ipcMain }) => {
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
        calls: { claude: 0, codex: 0, pi: 0 },
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
      ipcMain.removeHandler('usage:get-limits')
      ipcMain.handle('usage:get-limits', () => {
        state.calls.claude++
        return { windows: [window('Claude weekly', 30)], fetchedAt: Date.now() }
      })
      ipcMain.removeHandler('usage:get-codex-limits')
      ipcMain.handle('usage:get-codex-limits', async () => {
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
      })
      ipcMain.removeHandler('usage:get-pi')
      ipcMain.handle('usage:get-pi', (_event, range) => {
        state.calls.pi++
        return {
          range,
          sessions: 2,
          input: 800,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: range === 'today' ? 1000 : 4000,
          cost: 0.125
        }
      })
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
    await panel('codex').getByRole('button', { name: 'Refresh usage' }).click()
    await win.waitForSelector('[aria-label="91% used"]')
    await back()
    t.check('refresh updates the shared footer too', await textIs('9% left'))

    await focus(claude.sessionId)
    t.check('switching back restores Claude without Codex data', await textIs('70% left'))
    const pi = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'pi', name: 'Pi usage' })
    t.check(
      'Pi footer shows today’s local tokens and recorded cost',
      await textIs('1K tokens · $0.13 today')
    )
    t.equal('Pi does not invent quota headroom', await footer().locator('.usage-meter').count(), 0)
    await footer().click()
    await panel('pi').waitFor()
    t.check(
      'Pi panel explains these are local totals',
      (await panel('pi').textContent()).includes('Local session totals, not account quota')
    )
    t.equal(
      'Pi panel shares today’s cached request',
      await app.evaluate(() => globalThis.__usageFixture.calls.pi),
      1
    )
    await panel('pi').getByRole('button', { name: '7d', exact: true }).click()
    await panel('pi').getByText('4,000', { exact: true }).waitFor()
    await back()
    t.check('Pi historical ranges never replace today’s footer totals', await textIs('1K tokens'))

    await focus(codex.sessionId)
    await footer().click()
    await app.evaluate(() => {
      globalThis.__usageFixture.error = true
    })
    await panel('codex').getByRole('button', { name: 'Refresh usage' }).click()
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
      await win.evaluate(
        (value) => window.electronAPI.skinsActivate(value),
        theme
      )
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
