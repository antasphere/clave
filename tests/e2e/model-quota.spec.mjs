// In-process settings reads provide quota fixtures, as in provider-usage.
// The real Electron renderer, IPC, session commands and policy remain active.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('model-quota')
const ROOT = fixturePath('model-quota-root')
const WS = {
  id: 'model-quota-ws',
  name: 'Model quota',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
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
    const bootUsage = await win.evaluate(() =>
      window.electronAPI.getUsageLimits('default', { force: true })
    )
    t.equal(
      'machine credentials are disabled before fixture setup',
      bootUsage.error,
      'No token for this account yet. Log in from Settings → Accounts.'
    )
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('pty:spawn')
      let id = 0
      ipcMain.handle('pty:spawn', (_event, cwd, options) => ({
        id: `model-quota-${++id}`,
        cwd,
        folderName: 'quota',
        alive: true,
        model: options?.model
      }))
      const state = (globalThis.__modelQuota = { shared: 25, session: 10 })
      const read = () => ({
        fetchedAt: Date.now(),
        windows: [
          {
            key: '5h',
            label: 'Current session (5h)',
            kind: 'session',
            scope: null,
            usedPercentage: state.session,
            severity: null,
            resetsAt: Date.now() + 3600000
          },
          {
            key: 'all',
            label: 'Weekly · all models',
            kind: 'weekly_all',
            scope: null,
            usedPercentage: state.shared,
            severity: null,
            resetsAt: Date.now() + 7200000
          },
          {
            key: 'fable',
            label: 'Weekly · Fable',
            kind: 'weekly_scoped',
            scope: 'Fable',
            usedPercentage: 100,
            severity: 'critical',
            resetsAt: Date.now() + 10800000
          }
        ]
      })
      // The welcome catch-up and direct reads must see the same fixture,
      // including after shared caps change. Never reuse the machine cache.
      globalThis.__claveE2E.settings.usage.readClaude = async () => read()
      globalThis.__claveE2E.settings.usage.claudeSnapshot = () => ({ default: read() })
    })
    await win.reload()
    if (
      !(await until(async () => {
        try {
          return await callMcp(app, 'list', {})
        } catch {
          return false
        }
      }))
    )
      throw new Error('session dispatcher not ready')

    const bundled = fixturePath('model-quota-catalog.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./model-quota-fixture.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundled,
      logLevel: 'silent'
    })
    const { loadModelQuotaFixture } = await import(pathToFileURL(bundled).href)
    const report = await loadModelQuotaFixture((input) =>
      callMcp(app, 'openSession', { cwd: ROOT, mode: 'claude', account: 'default', ...input })
    )
    writeFileSync(fixturePath('model-quota-receipt.json'), JSON.stringify(report, null, 2))
    console.log(`model-quota/fable-exhausted run ${report.runId}`)
    const ids = Object.fromEntries(
      Object.entries(report.values).map(([key, value]) => [key, value.sessionId])
    )
    const footer = win.locator('.sidebar-footer-line[data-usage-provider="claude"]')
    const focus = (id) => callMcp(app, 'focus', { sessionId: id })
    const warning = (id) => win.locator(`[data-sidebar-item-id="${id}"] [data-account-limit]`)
    const sessions = async () => (await callMcp(app, 'list', {})).sessions

    await focus(ids.opus)
    t.check(
      'Opus footer ignores exhausted Fable quota',
      !!(await until(async () => (await footer.textContent())?.includes('75% left')))
    )
    t.equal('Opus has no false at-limit badge', await warning(ids.opus).count(), 0)
    t.equal(
      'MCP reports Opus account has headroom',
      (await sessions()).find((s) => s.id === ids.opus)?.account?.exhausted,
      false
    )
    await focus(ids.fable)
    t.check(
      'Fable footer retains its exhausted model quota',
      !!(await until(async () => (await footer.textContent())?.includes('0% left')))
    )
    t.check('Fable retains its at-limit badge', (await warning(ids.fable).count()) > 0)
    t.equal(
      'MCP reports Fable exhaustion',
      (await sessions()).find((s) => s.id === ids.fable)?.account?.exhausted,
      true
    )
    await focus(ids.unknown)
    t.check(
      'Unknown model uses shared quota only',
      !!(await until(async () => (await footer.textContent())?.includes('75% left')))
    )
    t.equal('Unknown model has no false at-limit badge', await warning(ids.unknown).count(), 0)

    await focus(ids.opus)
    await footer.click()
    t.equal(
      'Usage settings retain every account quota',
      await win.locator('div[data-usage-provider="claude"] [data-usage-window]').count(),
      3
    )
    await app.evaluate(() => {
      globalThis.__modelQuota.shared = 99
    })
    await win.getByRole('button', { name: 'Refresh usage' }).click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    t.check(
      'Shared weekly exhaustion still warns Opus',
      !!(await until(async () => (await warning(ids.opus).count()) > 0))
    )
    t.equal(
      'MCP retains shared weekly exhaustion',
      (await sessions()).find((s) => s.id === ids.opus)?.account?.exhausted,
      true
    )
    await footer.click()
    await app.evaluate(() => {
      globalThis.__modelQuota.shared = 25
      globalThis.__modelQuota.session = 99
    })
    await win.getByRole('button', { name: 'Refresh usage' }).click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    t.check(
      'Shared five-hour exhaustion still warns Opus',
      !!(await until(async () => (await footer.textContent())?.includes('1% left')))
    )
    t.equal(
      'MCP retains shared five-hour exhaustion',
      (await sessions()).find((s) => s.id === ids.opus)?.account?.exhausted,
      true
    )
    t.equal('No renderer exceptions', errors.length, 0)
  } finally {
    await app.close()
  }
}
