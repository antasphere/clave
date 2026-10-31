/** PRDCT-3517: the server's clock enumerates its own accounts, including
 * accounts added after launch, and publishes both providers to every window.
 * Named isolated fixture, recording reads only. Hidden mode keeps automatic
 * provider probes disabled; install the recorders before starting the same
 * production clock with a short test interval. */
import { mkdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  openWindow,
  until,
  serverMode
} from './harness.mjs'

const DIR = userDataDir('server-usage-clock')
const ROOT = fixturePath('server-usage-clock-root')
const WS = {
  id: 'usage-clock-ws',
  name: 'Usage clock',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  if (serverMode() === 'in-process') {
    t.check('server usage clock scenario requires separate or attached mode', true)
    return
  }
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  let app
  try {
    const launched = await launchApp(DIR, { args: ['--test-no-machine-usage'] })
    app = launched.app
    const { win, fixture } = launched
    t.check(
      'the usage clock fixture opts out of machine usage before loading accounts',
      await app.evaluate(() => process.argv.includes('--test-no-machine-usage'))
    )
    const second = (await openWindow(app, win, WS.id)).page
    for (const page of [win, second]) {
      await page.evaluate(() => {
        window.__clockEvents = { claude: [], codex: [] }
        window.electronAPI.onClaudeAccountUsage((value) => window.__clockEvents.claude.push(value))
        window.electronAPI.onCodexAccountUsage((value) => window.__clockEvents.codex.push(value))
      })
    }
    const first = await fixture.evaluate(async () => {
      const { usageClock: clock, settings } = globalThis.__claveE2E
      if (!clock) throw new Error('Standalone server has no usage clock fixture')
      globalThis.__clockReads = []
      for (const provider of ['claude', 'codex']) {
        clock[provider].source.read = async (accountId) => {
          const result = { windows: [], fetchedAt: Date.now() }
          globalThis.__clockReads.push({ provider, accountId, ...result })
          return result
        }
      }
      const claude = await settings.claudeAccounts.add('Clock initial Claude')
      const codex = await settings.codexAccounts.add('Clock initial Codex', 'chatgpt')
      clock.start(100)
      return { claude: claude.id, codex: codex.id }
    })
    const polled = async (ids) =>
      until(
        async () => {
          const counts = await fixture.evaluate(
            (ids) =>
              Object.fromEntries(
                Object.entries(ids).map(([provider, id]) => [
                  provider,
                  globalThis.__clockReads.filter(
                    (r) => r.provider === provider && r.accountId === id
                  ).length
                ])
              ),
            ids
          )
          return counts.claude >= 3 && counts.codex >= 3 ? counts : null
        },
        { tries: 40, gapMs: 100 }
      )
    t.check('the server repeatedly polls both initial accounts', !!(await polled(first)))
    const late = await fixture.evaluate(async () => {
      const { settings } = globalThis.__claveE2E
      return {
        claude: (await settings.claudeAccounts.add('Clock late Claude')).id,
        codex: (await settings.codexAccounts.add('Clock late Codex', 'chatgpt')).id
      }
    })
    t.check(
      'the existing server clock discovers both accounts added after launch',
      !!(await polled(late))
    )
    for (const [index, page] of [win, second].entries()) {
      const delivered = await until(
        async () =>
          page.evaluate((ids) => {
            return ['claude', 'codex'].every(
              (provider) =>
                new Set(
                  window.__clockEvents[provider]
                    .filter((e) => e.accountId === ids[provider])
                    .map((e) => e.result.fetchedAt)
                ).size >= 3
            )
          }, late),
        { tries: 40, gapMs: 100 }
      )
      t.check(
        `both late accounts' successive clock reads reach window ${index + 1}`,
        delivered === true
      )
    }
    console.log(
      'USAGE_CLOCK_RECEIPT',
      JSON.stringify({ scenario: 'usage-clock/accounts', first, late })
    )
  } finally {
    await app?.close()
  }
}
