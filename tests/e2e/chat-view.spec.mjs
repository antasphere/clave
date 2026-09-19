import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, until } from './harness.mjs'

export async function openChat(suffix = 'chat-view') {
  const dir = `/tmp/clave-e2e-${suffix}`
  const root = `${dir}-root`
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [{ id: 'chat', name: 'Chat', rootDir: root, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'chat',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  const app = await electron.launch({
    executablePath: path.join(
      REPO,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    ),
    args: ['.', `--user-data-dir=${dir}`, '--test-no-activate', '--dev-echo-adapter'],
    cwd: REPO,
    env: { ...process.env }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => window.electronAPI.launchProfileSetGlobal('claude', 'dev-echo-adapter'))
  await win.reload()
  await win.locator('.launcher-split .launcher-btn').click()
  await win.locator('[data-testid="chat-view"] textarea:not(:disabled)').waitFor()
  const record = await until(async () =>
    (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.adapterId === 'echo'
    )
  )
  assert.ok(record)
  return {
    app,
    win,
    record,
    async close() {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }
}
export async function inject(app, id, events) {
  await app.evaluate(
    ({ BrowserWindow }, { id, events }) => {
      for (const event of events)
        BrowserWindow.getAllWindows()[0].webContents.send(`sessions:stream:${id}`, {
          kind: 'event',
          event
        })
    },
    { id, events }
  )
}
export async function run(t) {
  const fixture = await openChat()
  const { app, win, record } = fixture
  try {
    assert.equal(await win.locator('.xterm').count(), 0)
    assert.equal(await win.getByLabel('Chat view', { exact: true }).count(), 1)
    assert.ok(await win.getByLabel('Show terminal', { exact: true }).isDisabled())
    t.check('events session mounts chat, badge and explained disabled terminal toggle', true)
    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('/help')
    await input.press('Shift+Enter')
    assert.equal(await win.locator('.chat-turn[data-role="user"]').count(), 0)
    assert.equal(await input.inputValue(), '/help\n')
    await input.press('Enter')
    await win.locator('.chat-turn[data-role="assistant"]').waitFor()
    assert.equal(await win.locator('.chat-turn[data-role="user"]').innerText(), 'You\n\n/help')
    assert.match(await win.locator('.chat-turn[data-role="assistant"]').innerText(), /\/help/)
    assert.match(await win.locator('.chat-tool-card').innerText(), /Complete/)
    await win.locator('.chat-tool-card summary').click()
    assert.match(await win.locator('.chat-tool-card').innerText(), /Result/)
    t.check('Enter sends slash text through echo; Shift+Enter only inserts a newline', true)
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('sessions:write')
      globalThis.__chatWrites = []
      ipcMain._invokeHandlers.set('sessions:write', (event, id, input) => {
        globalThis.__chatWrites.push(input)
        if (input.type === 'permission_response' || input.type === 'interrupt') return
        return original(event, id, input)
      })
    })
    await inject(app, record.id, [
      { type: 'session_meta', model: 'fixture-model', providerSessionId: 'fixture' },
      {
        type: 'permission_request',
        id: 'permit',
        description: 'Write this file?',
        toolName: 'Write',
        input: { path: '/tmp/example' },
        options: [
          { id: 'allow', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ]
      }
    ])
    await win.getByRole('button', { name: 'Allow once', exact: true }).waitFor()
    assert.equal(await win.locator('.chat-state').innerText(), 'blocked')
    assert.match(await win.locator('.chat-header').innerText(), /fixture-model/)
    await win.getByRole('button', { name: 'Allow once', exact: true }).click()
    assert.ok(
      await until(() =>
        app.evaluate(() => globalThis.__chatWrites.some((x) => x.type === 'permission_response'))
      )
    )
    assert.deepEqual(await app.evaluate(() => globalThis.__chatWrites[0]), {
      type: 'permission_response',
      id: 'permit',
      optionId: 'allow'
    })
    assert.ok(await win.getByRole('button', { name: 'Deny', exact: true }).isDisabled())
    t.check('permission choice crosses the real write IPC with correlated id and option', true)
    await inject(app, record.id, [{ type: 'state_change', state: 'working' }])
    await win.getByRole('button', { name: 'Interrupt', exact: true }).click()
    assert.ok(
      await until(() =>
        app.evaluate(() => globalThis.__chatWrites.some((x) => x.type === 'interrupt'))
      )
    )
    await inject(app, record.id, [{ type: 'error', message: 'Fixture error', fatal: false }])
    assert.equal(await win.getByRole('alert').innerText(), 'Fixture error')
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()[0].webContents.send(`sessions:exit:${id}`, 0),
      record.id
    )
    await win.getByText('Session ended (exit 0)', { exact: true }).waitFor()
    assert.ok(await input.isDisabled())
    t.check('interrupt, inline errors and exit state reach the conversation', true)
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.chat-view'))
    await win.locator('.xterm').waitFor()
    assert.equal(await win.locator('[data-testid="chat-view"]').count(), 0)
    t.check('disabling plugin restores terminal fallback', true)
  } finally {
    await fixture.close()
  }
}
