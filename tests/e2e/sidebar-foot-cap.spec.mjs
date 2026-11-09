// The sidebar foot shows the cap GOVERNING the focused tab's provider and
// model, and names it (PRDCT-4255): the tab's family cap when it is the
// tightest, else the shared weekly cap, and with no tab focused the
// launcher's next account on the shared caps alone. One read is canned: the
// week at 38% and the Fable cap spent, the shape Romain saw on 9 November
// 2026 when every account-level readout said "at limit".
//
// The foot following a model switch made from the chip (main's push of the
// model the CLI applied, PRDCT-4256) is asserted by the unit test beside the
// component (`SidebarFooter.test.tsx`): this spec starts no real CLI to confirm one.
//
// Pinned to the in-process server (`server: 'in-process'`): the quota it shows
// comes from a read stubbed on the shell's settings source
// (`globalThis.__claveE2E.settings`), which only the in-process server consults.
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

const DIR = userDataDir('sidebar-foot-cap')
const ROOT = fixturePath('sidebar-foot-cap-root')
const WS = { id: 'foot-cap-ws', name: 'Foot cap', rootDir: ROOT, profileFile: null, createdAt: 1 }

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // No machine-login read: the canned read below is the only Claude read.
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    args: ['--test-no-machine-usage']
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(({ ipcMain }) => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      // Real renderer session selection and IPC; no agent started, no real
      // account read. The stub keeps the model the launch asked for, as the
      // real spawn does, so the foot has a model to follow.
      ipcMain.removeHandler('pty:spawn')
      let id = 0
      ipcMain.handle('pty:spawn', (_event, cwd, options) => ({
        id: `foot-${++id}`,
        cwd,
        folderName: 'foot',
        alive: true,
        ...(options?.model ? { model: options.model } : {})
      }))
      const week = Date.now() + 3 * 24 * 3600 * 1000
      // Codex: the week at 30%, the Spark bucket's 5-hour block spent.
      settings.usage.readCodex = async () => ({
        windows: [
          {
            key: 'codex-week',
            label: 'Weekly · all models',
            kind: 'weekly_all',
            scope: null,
            usedPercentage: 30,
            resetsAt: week,
            severity: 'normal'
          },
          {
            key: 'spark-5h',
            label: 'Spark · 5h',
            kind: 'session',
            scope: 'Spark',
            usedPercentage: 100,
            resetsAt: Date.now() + 2 * 3600 * 1000,
            severity: 'critical'
          }
        ],
        fetchedAt: Date.now()
      })
      settings.usage.readClaude = async () => ({
        windows: [
          {
            key: 'weekly_all',
            label: 'Weekly · all models',
            kind: 'weekly_all',
            scope: null,
            usedPercentage: 38,
            resetsAt: week,
            severity: 'normal'
          },
          {
            key: 'weekly_scoped:Fable',
            label: 'Weekly · Fable',
            kind: 'weekly_scoped',
            scope: 'Fable',
            usedPercentage: 100,
            resetsAt: week,
            severity: 'critical'
          },
          {
            key: 'weekly_scoped:Opus',
            label: 'Weekly · Opus',
            kind: 'weekly_scoped',
            scope: 'Opus',
            usedPercentage: 10,
            resetsAt: week,
            severity: 'normal'
          }
        ],
        fetchedAt: Date.now()
      })
    })
    await win.reload()
    const foot = () => win.locator('.sidebar-footer-line[data-usage-provider="claude"]')
    await foot().waitFor({ timeout: 20_000 })
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    // Main's own boot read of the Default account started before the stub
    // was installed and lands on its own clock; wait for it to be in the
    // snapshot, then read again, forced, so the canned numbers are what
    // every check below reads and nothing later overwrites them.
    await until(async () =>
      win.evaluate(async () => 'default' in (await window.electronAPI.getClaudeUsageSnapshot()))
    )
    await win.evaluate(() => window.electronAPI.getUsageLimits('default', { force: true }))
    await until(async () => /62% left/.test((await foot().textContent()) ?? ''))
    const capIs = async (cap) =>
      !!(await until(async () => (await foot().getAttribute('data-usage-cap')) === cap))
    const text = async () => ((await foot().textContent()) ?? '').replace(/\s+/g, ' ').trim()

    // ── No tab focused: the launcher's next account, on the shared caps ──
    t.check('with no tab focused the foot shows the shared weekly cap', await capIs('Overall'))
    t.check('and reads what is left of it', /62% left/.test(await text()), await text())
    t.check(
      'a family cap that is out never puts the account out in the foot',
      !/out/.test(await text()),
      await text()
    )

    // ── A tab on Fable: its family cap, out, named with its return ──
    const fable = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      name: 'On Fable',
      model: 'claude-fable-5-1'
    })
    await callMcp(app, 'focus', { sessionId: fable.sessionId })
    t.check('a tab on Fable shows the Fable cap', await capIs('Fable'))
    t.check(
      'and says it is out, and when it comes back',
      /^Fable out · back in /.test(await text()),
      await text()
    )
    t.check(
      'the tooltip names the cap and the return too',
      /Weekly · Fable · Fable out · back /.test((await foot().getAttribute('title')) ?? ''),
      await foot().getAttribute('title')
    )
    t.equal(
      'the bar reads critical',
      await foot().locator('.usage-meter-fill').getAttribute('class'),
      'usage-meter-fill usage-meter-fill--critical'
    )

    // ── A tab on Opus: the shared weekly cap is the tightest it draws on ──
    const opus = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      name: 'On Opus',
      model: 'claude-opus-5-5'
    })
    await callMcp(app, 'focus', { sessionId: opus.sessionId })
    t.check('a tab on Opus shows the shared weekly cap', await capIs('Overall'))
    t.check('with 62% left', /62% left/.test(await text()), await text())

    // ── Back to the Fable tab: the foot follows the focus ──
    await callMcp(app, 'focus', { sessionId: fable.sessionId })
    t.check('focusing the Fable tab again brings the Fable cap back', await capIs('Fable'))

    // ── Codex: Spark's bucket is a family; a tab on another model reads the week ──
    const codexFoot = () => win.locator('.sidebar-footer-line[data-usage-provider="codex"]')
    const codexCapIs = async (cap) =>
      !!(await until(async () => (await codexFoot().getAttribute('data-usage-cap')) === cap))
    const codexText = async () =>
      ((await codexFoot().textContent()) ?? '').replace(/\s+/g, ' ').trim()
    const spark = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      name: 'On Spark',
      model: 'gpt-5.3-codex-spark'
    })
    await callMcp(app, 'focus', { sessionId: spark.sessionId })
    t.check('a Codex tab on Spark shows the Spark bucket', await codexCapIs('Spark'))
    t.check(
      'and says it is out, and when it comes back',
      /^Spark out · back in /.test(await codexText()),
      await codexText()
    )
    const codex = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      name: 'On Codex',
      model: 'gpt-5.3-codex'
    })
    await callMcp(app, 'focus', { sessionId: codex.sessionId })
    t.check('a Codex tab on another model shows the shared week', await codexCapIs('Overall'))
    t.check('with 70% left', /70% left/.test(await codexText()), await codexText())

    t.equal('no renderer exceptions', errors.length, 0)
  } finally {
    await app.close()
  }
}
