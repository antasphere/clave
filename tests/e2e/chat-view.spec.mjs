import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, until } from './harness.mjs'

export const TOOL_RESULT = 'chat-result: verified payload 2537'

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
  await app.evaluate(({ ipcMain }) => {
    globalThis.__chatSubscriptions = []
    for (const channel of ['sessions:subscribe', 'sessions:unsubscribe']) {
      const original = ipcMain._invokeHandlers.get(channel)
      ipcMain._invokeHandlers.set(channel, (event, id) => {
        globalThis.__chatSubscriptions.push({ channel, id })
        return original(event, id)
      })
    }
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
    assert.equal(await win.locator('.chat-tool-card pre').last().innerText(), '/help\n')
    await inject(app, record.id, [
      { type: 'tool_call', id: 'distinct-result', name: 'Read fixture', input: {} },
      { type: 'tool_result', id: 'distinct-result', output: TOOL_RESULT }
    ])
    const resultCard = win.locator('.chat-tool-card').filter({ hasText: 'Read fixture' })
    await resultCard.locator('summary').filter({ hasText: 'Complete' }).click()
    assert.equal(await resultCard.locator('pre').last().innerText(), TOOL_RESULT)
    t.check('Enter sends slash text through echo; Shift+Enter only inserts a newline', true)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('shell:openExternal')
      ipcMain.handle('shell:openExternal', (_event, url) => {
        globalThis.__chatExternal = url
      })
    })
    await inject(app, record.id, [
      {
        type: 'assistant_text',
        delta: '[Reference](https://example.com/chat-reference)',
        final: true
      }
    ])
    await win.getByRole('link', { name: 'Reference', exact: true }).click()
    assert.ok(
      await until(() =>
        app.evaluate(() => globalThis.__chatExternal === 'https://example.com/chat-reference')
      )
    )
    t.check('markdown links use the host external-link handler', true)
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
    assert.equal(
      await win.locator(`[data-sidebar-item-id="${record.id}"] .bg-status-waiting`).count(),
      1
    )
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
    await win.locator('.chat-state[data-state="working"]').waitFor()
    assert.equal(await win.locator('.chat-state').innerText(), 'working')
    await win.getByRole('button', { name: 'Interrupt', exact: true }).click()
    assert.match(
      await win
        .locator(`[data-sidebar-item-id="${record.id}"] .sidebar-tab-icon`)
        .getAttribute('style'),
      /pulse-dot/
    )
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
    const beforeDisable = await unsubscribeCount(app, record.id)
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.chat-view'))
    await win.locator('.xterm').waitFor()
    assert.equal(await win.locator('[data-testid="chat-view"]').count(), 0)
    assert.ok(await until(async () => (await unsubscribeCount(app, record.id)) > beforeDisable))
    t.check('disabling plugin restores terminal fallback and releases its subscription', true)
    await win.evaluate(() =>
      window.electronAPI.pluginsEnable('clave.chat-view', ['sessions.read', 'sessions.write'])
    )
    await win.locator('[data-testid="chat-view"] textarea:not(:disabled)').waitFor()
    const beforeClose = await unsubscribeCount(app, record.id)
    await win.getByRole('button', { name: 'Close session', exact: true }).click()
    const confirmation = win.getByRole('dialog', { name: 'Delete session', exact: true })
    await confirmation.waitFor()
    assert.match(
      await confirmation.innerText(),
      /terminate the process\. The conversation is not saved\./
    )
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await confirmation.waitFor({ state: 'hidden' })
    assert.equal(await unsubscribeCount(app, record.id), beforeClose)
    assert.equal(await win.locator('[data-testid="chat-view"]').count(), 1)
    assert.ok(
      await win.evaluate(
        async (id) =>
          (await window.electronAPI.sessionsList()).some((session) => session.id === id),
        record.id
      )
    )
    await win.getByRole('button', { name: 'Close session', exact: true }).click()
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
    await win.locator('[data-testid="chat-view"]').waitFor({ state: 'detached' })
    assert.equal(await win.locator(`[data-sidebar-item-id="${record.id}"]`).count(), 0)
    assert.ok(await until(async () => (await unsubscribeCount(app, record.id)) > beforeClose))
    assert.equal(
      await win.evaluate(
        async (id) =>
          (await window.electronAPI.sessionsList()).some((session) => session.id === id),
        record.id
      ),
      false
    )
    t.check('header Close cancels safely or confirms termination and subscription cleanup', true)
  } finally {
    await fixture.close()
  }
}

async function unsubscribeCount(app, id) {
  return app.evaluate(
    (_electron, id) =>
      globalThis.__chatSubscriptions.filter(
        (call) => call.channel === 'sessions:unsubscribe' && call.id === id
      ).length,
    id
  )
}
