// The manual account switch on the served road (ADR 0002 over ADR 0003),
// in whatever mode the suite runs: in-process, attached, or the separate
// server a packaged macOS app starts for itself since 3.0.0-beta.3. On that
// server the Switch account menu did nothing: the window's `restartSession`
// went over IPC alone, main's own PTY manager held no spawn for a tab the
// server owned, and the refusal ("cannot be restarted from here") was
// swallowed by the menu. The sibling specs (account-switch, chat-account-
// switch, chat-limit-switch) stay pinned to the in-process server for their
// own reasons; this one takes the suite's mode and proves the move from the
// process itself: the token the restarted CLI got and the `--resume` it was
// given, never a badge.
//
// The quota reads are stubbed in the process that hosts the sessions and
// reads the settings (the fixture route: the app's own in-process server,
// or the standalone one), and on macOS the standalone server files its
// tokens in a keychain FILE of the run's own, never in a personal keychain.
import { mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

const DIR = userDataDir('account-switch-served')
const ROOT = fixturePath('account-switch-served-root')
const KEYCHAIN = fixturePath('account-switch-served-keychain/e2e.keychain-db')
const WS = {
  id: 'served-switch-ws',
  name: 'Served switch',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const WORK_TOKEN = 'sk-ant-oat01-work-token-for-the-served-switch-0123456789'
const PLAY_TOKEN = 'sk-ant-oat01-play-token-for-the-served-switch-0123456789'
const SECURITY = '/usr/bin/security'

/** A keychain file of this run's own: never in the search list, deleted at the end. */
function createKeychain() {
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
  mkdirSync(path.dirname(KEYCHAIN), { recursive: true })
  execFileSync(SECURITY, ['create-keychain', '-p', '', KEYCHAIN], { stdio: 'ignore' })
  execFileSync(SECURITY, ['set-keychain-settings', KEYCHAIN], { stdio: 'ignore' })
}
function deleteKeychain() {
  try {
    execFileSync(SECURITY, ['delete-keychain', KEYCHAIN], { stdio: 'ignore' })
  } catch {
    // Never created, or already gone.
  }
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const mac = process.platform === 'darwin'
  if (mac) createKeychain()
  const { app, win, fixture } = await launchApp(DIR, {
    env: mac ? { CLAVE_KEYCHAIN_FILE: KEYCHAIN } : {}
  })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    // In the process that hosts the sessions: the probe answers per token
    // with a quota, an unknown token is refused; the Default account is the
    // machine login and is never read.
    await fixture.evaluate(
      ({ WORK_TOKEN, PLAY_TOKEN }) => {
        const settings = globalThis.__claveE2E?.settings
        if (!settings) throw new Error('no settings source in the sessions process')
        const quota = { [WORK_TOKEN]: 0.1, [PLAY_TOKEN]: 0.2 }
        const original = settings.usage.readClaude
        settings.usage.readClaude = async (accountId, force) => {
          if (accountId === undefined || accountId === 'default') {
            return {
              windows: [
                {
                  key: 'session:x',
                  label: 'session',
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
          return original(accountId, force)
        }
        globalThis.fetch = async (_url, init) => {
          const token = (init?.headers?.Authorization ?? '').replace(/^Bearer /, '')
          const used = quota[token]
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
              'anthropic-ratelimit-unified-5h-status': 'allowed'
            }
          })
        }
        return true
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    // A "claude" that prints its token and whether it resumed: the two
    // things a switch must change, read off the process.
    await win.evaluate(async (workspaceId) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-claude-served-printenv',
        name: 'printenv',
        family: 'claude',
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
        'e2e-claude-served-printenv'
      )
    }, WS.id)
    // Two token accounts, through the API the Accounts page uses.
    const accounts = await win.evaluate(
      async ({ WORK_TOKEN, PLAY_TOKEN }) => {
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        const workRead = await window.electronAPI.claudeAccountSetToken(work.id, WORK_TOKEN)
        const play = await window.electronAPI.claudeAccountAdd({ label: 'Play' })
        const playRead = await window.electronAPI.claudeAccountSetToken(play.id, PLAY_TOKEN)
        return { work: work.id, play: play.id, workRead, playRead }
      },
      { WORK_TOKEN, PLAY_TOKEN }
    )
    t.check(
      'both tokens were accepted (the probe answered a quota)',
      !accounts.workRead?.error && !accounts.playRead?.error,
      JSON.stringify({ work: accounts.workRead, play: accounts.playRead })
    )
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

    // ── A Claude tab on Work, moved to Play by hand, from the menu ──────
    const onWork = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      account: 'Work',
      name: 'Moving'
    })
    t.check('a tab opened on Work', !!onWork?.sessionId, JSON.stringify(onWork))
    await callMcp(app, 'focus', { sessionId: onWork.sessionId })
    const before = await printed(onWork.sessionId, new RegExp(`TOKEN=${WORK_TOKEN} MODE=new`))
    t.check('the tab started on Work, with a fresh conversation', !!before, before?.slice(0, 200))

    const row = win.locator('.sidebar-item', { hasText: 'Moving' }).first()
    await row.click({ button: 'right' })
    const switchEntry = win.locator('[role="menuitem"]', { hasText: 'Switch account' })
    await switchEntry.waitFor({ timeout: 5000 })
    t.equal('the menu offers one Switch account entry', await switchEntry.count(), 1)
    await switchEntry.hover()
    const submenu = win.locator('[role="menu"]').nth(1)
    await submenu.waitFor({ timeout: 5000 })
    const playRow = submenu.locator(`[data-account-switch-row="${accounts.play}"]`)
    t.equal('the submenu offers Play', await playRow.count(), 1)
    t.equal(
      'the submenu does not offer the account the tab is on',
      await submenu.locator(`[data-account-switch-row="${accounts.work}"]`).count(),
      0
    )
    await submenu.locator('[role="menuitem"]', { hasText: 'Play' }).click()

    const after = await printed(onWork.sessionId, new RegExp(`TOKEN=${PLAY_TOKEN} MODE=`))
    t.check('the SAME tab now runs a process with the Play token', !!after, after?.slice(0, 200))
    t.check(
      'the process was told to resume the conversation',
      !!after && new RegExp(`TOKEN=${PLAY_TOKEN} MODE=resume:`).test(after),
      after?.slice(0, 200)
    )
    const sessions = (await callMcp(app, 'list', {})).sessions
    const moved = sessions.find((s) => s.id === onWork.sessionId)
    t.check(
      'clave_list says the tab is on Play and alive',
      moved?.account?.label === 'Play' && moved.alive === true,
      JSON.stringify(moved)
    )
    t.check('the tab kept its name', moved?.name === 'Moving', moved?.name)
    t.equal('one tab, not two', sessions.filter((s) => s.name === 'Moving').length, 1)
    t.equal('no page errors', errors.length, 0)
    if (errors.length) t.check('page errors', false, errors.join('\n'))
  } finally {
    await app.close()
    if (mac) deleteKeychain()
  }
}
