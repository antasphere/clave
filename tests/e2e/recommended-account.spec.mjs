// Real Electron, in-process settings and sessions, with isolated test accounts.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

const DIR = userDataDir('recommended-account')
const ROOT = fixturePath('recommended-account-root')
const WS = {
  id: 'recommended-account-ws',
  name: 'Recommended account',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const TOKEN = 'sk-ant-oat01-recommended-fixture-token-0123456789'
const LABEL = 'Use the recommended account for new sessions'

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
    await app.evaluate(() => {
      globalThis.fetch = async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-utilization': '0.2',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'anthropic-ratelimit-unified-7d-utilization': '0.3',
            'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 86400)
          }
        })
    })
    const bundled = fixturePath('recommended-account-catalog.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./recommended-account-fixture.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundled,
      logLevel: 'silent'
    })
    const { loadRecommendedAccountFixture } = await import(pathToFileURL(bundled).href)
    const report = await loadRecommendedAccountFixture((label) =>
      win.evaluate(
        async ({ label, token }) => {
          const account = await window.electronAPI.claudeAccountAdd({ label })
          await window.electronAPI.claudeAccountSetToken(account.id, token)
          return { id: account.id }
        },
        { label, token: TOKEN }
      )
    )
    writeFileSync(fixturePath('recommended-account-receipt.json'), JSON.stringify(report, null, 2))
    console.log(`recommended-account/weekly-reset run ${report.runId}`)
    const accountId = report.values.account.id
    await win.evaluate(
      async ({ workspaceId, accountId }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'recommended-printenv',
          name: 'Account recorder',
          family: 'claude',
          command: [
            'sh',
            '-c',
            'printf "ACCOUNT=%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"; sleep 60',
            'claude'
          ],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetWorkspace(
          workspaceId,
          'claude',
          'recommended-printenv'
        )
        await window.electronAPI.getUsageLimits(accountId, { force: true })
      },
      { workspaceId: WS.id, accountId }
    )
    await win.reload()
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const settings = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'accounts')
      )
    await settings()
    const toggle = win.getByRole('switch', { name: LABEL, exact: true })
    await toggle.waitFor()
    t.equal('recommendation starts off', await toggle.getAttribute('aria-checked'), 'false')
    const open = (name, account) =>
      callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'claude',
        name,
        ...(account ? { account } : {})
      })
    const chosen = async (sessionId) =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === sessionId)?.account?.id
    const initial = await open('Selected account')
    t.equal(
      'disabled tool launch uses the selected account',
      await chosen(initial.sessionId),
      'default'
    )
    await settings()
    await toggle.click()
    t.equal(
      'the setting persists through IPC',
      await win.evaluate(() => window.electronAPI.preferencesGet('useRecommendedAccount')),
      true
    )
    const implicit = await open('Recommended account')
    t.equal(
      'implicit tool launch uses the recommendation',
      await chosen(implicit.sessionId),
      accountId
    )
    const printed = await until(async () => {
      const output = await callMcp(app, 'readSession', {
        sessionId: implicit.sessionId,
        callerSessionId: implicit.sessionId,
        lines: 100
      })
      return (output?.text ?? '').includes(`ACCOUNT=${TOKEN}`)
    })
    t.check('the spawned process receives the recommended token', !!printed)
    const explicit = await open('Explicit account', 'default')
    t.equal('an explicit account wins', await chosen(explicit.sessionId), 'default')
    await win.reload()
    await settings()
    await toggle.waitFor()
    t.equal(
      'the setting survives renderer reload',
      await toggle.getAttribute('aria-checked'),
      'true'
    )
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    // The ordinary sidebar button has no explicit account in a fresh workspace.
    const journal = () =>
      readFileSync(`${DIR}/terminal-journal.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((line) => line.kind === 'spawn')
    const before = journal().length
    await win.locator('[data-launcher-agent]').click()
    t.check(
      'the sidebar launcher also uses the recommendation',
      !!(await until(() =>
        journal()
          .slice(before)
          .some((s) => s.options?.claudeProfileId === accountId)
      ))
    )
    await settings()
    await toggle.click()
    const disabled = await open('Selected again')
    t.equal('disabling restores the selected account', await chosen(disabled.sessionId), 'default')
    t.equal('no renderer exceptions', errors.length, 0)
  } finally {
    await app.close()
  }
}
