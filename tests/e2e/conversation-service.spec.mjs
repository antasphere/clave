import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  stubReviewDialog,
  callMcp,
  openWindow
} from './harness.mjs'

export async function run(t) {
  const root = mkdtempSync(join(REPO, '.conversation-e2e-'))
  const userData = join(root, 'app')
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  seedWorkspaces(userData, {
    workspaces: [
      {
        id: 'conversation-fixture',
        name: 'Conversation fixture',
        rootDir: cwd,
        createdAt: Date.now()
      }
    ],
    activeWorkspaceId: 'conversation-fixture'
  })
  seedTrustedRoots(userData, [cwd])
  const state = () => JSON.parse(readFileSync(join(cwd, 'fixture-state.json'), 'utf8'))
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  async function eventually(check, message) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail(message)
  }
  let app
  let win
  let daemonPid
  let providerPid
  let sessionId
  try {
    ;({ app, win } = await launchApp(userData))
    const untrusted = join(root, 'untrusted')
    mkdirSync(untrusted)
    await stubReviewDialog(app, { response: 0 })
    const cancelled = await win.evaluate(async (folder) => {
      try {
        await window.electronAPI.conversations.create({ provider: 'claude', cwd: folder })
        return false
      } catch (error) {
        return String(error).includes('not trusted')
      }
    }, untrusted)
    assert.equal(cancelled, true, 'Headless startup must require folder trust')
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    await win.evaluate(
      async ({ node, fixture }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'fixture-conversation',
          name: 'Fixture conversation',
          family: 'claude',
          command: [node, fixture],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetGlobal('claude', 'fixture-conversation')
      },
      { node: process.execPath, fixture: join(REPO, 'tests/e2e/fixtures/conversation-claude.mjs') }
    )
    const opened = await callMcp(app, 'openSession', {
      cwd,
      mode: 'claude',
      name: 'Persistent conversation'
    })
    sessionId = opened.sessionId
    assert.match(sessionId, /^conversation-/)
    await win.getByTestId('conversation-panel').waitFor()
    assert.equal(
      await win.locator('.xterm').count(),
      0,
      'Conversation must not mount a PTY terminal'
    )
    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('hello')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await win.getByText('Fixture reply:', { exact: true }).waitFor()
    await eventually(() => existsSync(join(cwd, 'fixture-state.json')), 'CLI did not start')
    providerPid = state().pid
    daemonPid = JSON.parse(
      readFileSync(join(userData, 'conversation-service/owner.json'), 'utf8')
    ).pid
    assert.equal(state().claveId, sessionId)
    assert.ok(state().args.includes('--output-format'))
    assert.ok(state().args.includes('stream-json'))
    const mcpPath = join(userData, 'mcp-configs', `${sessionId}.json`)
    const mcpBefore = readFileSync(mcpPath, 'utf8')

    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('permission')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await win.getByRole('button', { name: 'Deny', exact: true }).click()
    await win.getByText('Permission denied', { exact: true }).waitFor()

    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('background')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await eventually(() => state().turns === 3, 'Background turn was not submitted')
    await app.close()
    app = undefined
    assert.ok(alive(providerPid), 'Agent must survive full Electron quit')
    assert.ok(alive(daemonPid), 'Daemon must survive full Electron quit')
    await new Promise((resolve) => setTimeout(resolve, 1800))
    ;({ app, win } = await launchApp(userData))
    await win.getByTestId('conversation-panel').waitFor()
    await win.getByText('Finished while Clave was closed', { exact: true }).waitFor()
    assert.equal(state().pid, providerPid, 'Reopen must attach, not respawn')
    assert.equal(state().turns, 3, 'Reopen must not replay the prompt')
    assert.equal(
      readFileSync(mcpPath, 'utf8'),
      mcpBefore,
      'Surviving MCP credential must not rotate'
    )
    if (process.env.CLAVE_E2E_SCREENSHOT)
      await win.screenshot({ path: process.env.CLAVE_E2E_SCREENSHOT })

    const second = await openWindow(app, win, 'conversation-fixture')
    const moved = await win.evaluate(
      ({ id, target }) => window.electronAPI.windowMoveSessions([id], target),
      {
        id: sessionId,
        target: second.windowId
      }
    )
    assert.deepEqual(moved.moved, [sessionId])
    win = second.page
    await win.getByTestId('conversation-panel').waitFor()
    await win.getByText('Finished while Clave was closed', { exact: true }).waitFor()
    assert.equal(state().pid, providerPid, 'Window move must not restart the agent')

    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('wait')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await eventually(() => state().turns === 4, 'Interruptible turn was not submitted')
    await win.getByRole('button', { name: 'Stop', exact: true }).click()
    await win.getByText('Interrupted fixture turn', { exact: true }).waitFor()
    await win.evaluate((id) => window.electronAPI.killSession(id), sessionId)
    await eventually(() => !alive(providerPid), 'Explicit close must dispose its owned agent')
    t.check(
      'CLI stream, permission, quit/reopen, no replay, MCP identity, window move, interrupt, close',
      true
    )
  } finally {
    if (app) {
      if (sessionId)
        await win
          .evaluate((id) => window.electronAPI.conversations.close(id), sessionId)
          .catch(() => {})
      await app.close().catch(() => {})
    }
    // Only PIDs read from this test's newly-created instance, never process-name matching.
    if (!daemonPid && existsSync(join(userData, 'conversation-service/owner.json'))) {
      daemonPid = JSON.parse(
        readFileSync(join(userData, 'conversation-service/owner.json'), 'utf8')
      ).pid
    }
    if (daemonPid && alive(daemonPid)) process.kill(daemonPid, 'SIGTERM')
    if (providerPid && alive(providerPid)) process.kill(providerPid, 'SIGTERM')
    if (daemonPid) await eventually(() => !alive(daemonPid), 'Test daemon did not stop')
    rmSync(root, { recursive: true, force: true })
  }
}
