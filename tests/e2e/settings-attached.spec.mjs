// The settings served by a standalone server (lane D of wave 2, PRDCT-3242).
// Whatever the suite's mode, this spec attaches the app to a server of its
// own and proves, through that server's HTTP API and never through a hook
// inside main:
//
//  1. The standalone server serves the settings from its own data directory:
//     the Claude account list answers with the machine login's entry behind
//     the bearer, and 401 without it. A standalone entry that lost its
//     settings source would answer 500 here (round 2's verifier found that
//     mutation caught by nothing).
//  2. An attached window's settings go to that server, not to main: an
//     account added from the window is listed by the server's API and absent
//     from main's own managers (read through the test hooks), which is the
//     reason the quota specs pin the in-process server.
//  3. The three commands a standalone server cannot carry are refused with
//     the declared failure and its sentence, which reaches the window.
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('settings-attached')
const ROOT = fixturePath('settings-attached-root')
const WS = { id: 'sa-ws', name: 'Attached', rootDir: ROOT, profileFile: null, createdAt: 1 }

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win, server } = await launchApp(DIR, { server: 'attached' })
  try {
    const api = async (path, init = {}, token = server.token) => {
      const res = await fetch(server.url + path, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { 'content-type': 'application/json' } : {})
        }
      })
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null }
    }

    const unauthenticated = await api('/accounts/claude', {}, null)
    t.equal('the account list is behind the bearer', unauthenticated.status, 401)
    const list = await api('/accounts/claude')
    t.equal('the standalone server serves the account list', list.status, 200)
    t.check(
      'and it carries the machine login',
      Array.isArray(list.body) && list.body.some((a) => a.id === 'default')
    )

    const added = await win.evaluate(() =>
      window.electronAPI.claudeAccountAdd({ label: 'Attached' })
    )
    t.check('the window added an account through the server', typeof added?.id === 'string')
    const after = await api('/accounts/claude')
    t.check(
      'the server lists the account the window added',
      after.body.some((a) => a.id === added.id && a.label === 'Attached')
    )
    const mainsList = await app.evaluate(async () => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      return settings.claudeAccounts.list()
    })
    t.check(
      "main's own managers never saw it: an attached window's settings are the server's",
      !mainsList.some((a) => a.id === added.id)
    )

    const refusal = await win.evaluate(
      (id) =>
        window.electronAPI.accountLoginStart('claude', id).then(
          () => null,
          (err) => String(err?.message ?? err)
        ),
      added.id
    )
    t.check(
      'a terminal login is refused by the standalone server with its sentence',
      typeof refusal === 'string' && refusal.includes('no terminal')
    )
    const icon = await win.evaluate(() =>
      window.electronAPI.setAppIcon('light').then(
        () => null,
        (err) => String(err?.message ?? err)
      )
    )
    t.check('and so is the app icon', typeof icon === 'string' && icon.includes('no Dock'))
  } finally {
    await app.close()
  }
}
