import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, until } from './harness.mjs'

export const TOOL_RESULT = 'chat-result: verified payload 2537'

/** `extraArgs` go to the Electron launch; `ready` is what the caller waits for
 *  before the fixture is handed over — the chat composer by default, another
 *  view's when a launch profile opens the session in one. */
export async function openChat(
  suffix = 'chat-view',
  extraArgs = [],
  ready = '[data-testid="chat-view"] textarea:not(:disabled)'
) {
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
    args: ['.', `--user-data-dir=${dir}`, '--test-no-activate', '--dev-echo-adapter', ...extraArgs],
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
  await win.locator(ready).waitFor()
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
    assert.equal(await win.locator('.chat-turn[data-role="user"]').innerText(), '/help')
    assert.match(await win.locator('.chat-turn[data-role="assistant"]').innerText(), /\/help/)
    await win.locator('.chat-tool-card[data-complete="true"]').waitFor()
    await win.locator('.chat-tool-card summary').click()
    assert.equal(await win.locator('.chat-tool-card pre').last().innerText(), '/help\n')
    await inject(app, record.id, [
      { type: 'tool_call', id: 'distinct-result', name: 'Read fixture', input: {} },
      { type: 'tool_result', id: 'distinct-result', output: TOOL_RESULT }
    ])
    const resultCard = win.locator('.chat-tool-card').filter({ hasText: 'Read fixture' })
    await resultCard.locator('summary').locator('[aria-label="Complete"]').waitFor()
    await resultCard.locator('summary').click()
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
    await win.locator('.chat-state[data-state="blocked"]').waitFor()
    const waitingDot = win.locator(`[data-sidebar-item-id="${record.id}"] .bg-status-waiting`)
    assert.equal(
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === record.id)
        .state,
      'done'
    )
    assert.equal(
      await waitingDot.count(),
      0,
      'view-only permission events cannot overwrite kernel sidebar state'
    )
    await kernelState(app, record.id, 'blocked')
    assert.ok(await until(async () => (await waitingDot.count()) === 1))
    t.check(
      'view-only permission event leaves sidebar unchanged; kernel blocked shows waiting',
      true
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
    // An answered card shows the choice it recorded and no longer offers the others.
    await win.locator('.chat-permission-answer').filter({ hasText: 'Allow once' }).waitFor()
    assert.equal(await win.getByRole('button', { name: 'Deny', exact: true }).count(), 0)
    t.check('permission choice crosses the real write IPC with correlated id and option', true)
    // A second request the adapter stops holding — answered by another consumer
    // of this window, or abandoned by the adapter itself. The echo adapter has
    // no permission vocabulary, so it is represented here by its kernel
    // consequence, the state_change that leaves blocked; the whole path — a real
    // adapter, answered through sessionsWrite from outside the view — is proven
    // in claude-chat-adapter.spec.mjs.
    await inject(app, record.id, [
      {
        type: 'permission_request',
        id: 'permit-elsewhere',
        description: 'Delete this file?',
        toolName: 'Bash',
        input: { command: 'rm /tmp/example' },
        options: [
          { id: 'allow', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ]
      }
    ])
    const outside = win.locator('.chat-permission-card').filter({ hasText: 'Delete this file?' })
    await outside.waitFor()
    await win.locator('.chat-state[data-state="blocked"]').waitFor()
    assert.equal(
      await outside.getByRole('button', { name: 'Deny', exact: true }).isDisabled(),
      false,
      'an outstanding request offers a live button'
    )
    await inject(app, record.id, [{ type: 'state_change', state: 'working' }])
    await win.locator('.chat-state[data-state="working"]').waitFor()
    await outside.locator('.chat-permission-answer[data-answered="elsewhere"]').waitFor()
    assert.match(
      await outside.locator('.chat-permission-answer').innerText(),
      /No longer awaiting an answer/
    )
    for (const label of ['Allow once', 'Deny'])
      assert.equal(
        await outside.getByRole('button', { name: label, exact: true }).isDisabled(),
        true,
        `${label} must be dead once the kernel says the request was answered`
      )
    // Forced through the actionability checks: a disabled button fires nothing,
    // so no answer crosses the write IPC and no error card lands.
    await outside.getByRole('button', { name: 'Deny', exact: true }).click({ force: true })
    assert.equal(
      await app.evaluate(
        () =>
          globalThis.__chatWrites.filter(
            (x) => x.type === 'permission_response' && x.id === 'permit-elsewhere'
          ).length
      ),
      0,
      'a card answered elsewhere can send no answer of its own'
    )
    assert.equal(await win.getByRole('alert').count(), 0, 'and raises no error card')
    t.check('a request answered elsewhere leaves blocked, is marked, and goes dead', true)
    await win.getByRole('button', { name: 'Model', exact: true }).click()
    await win.getByRole('menuitem', { name: /Echo 2/ }).click()
    assert.ok(
      await until(() =>
        app.evaluate(() =>
          globalThis.__chatWrites.some((x) => x.type === 'set_model' && x.model === 'echo-2')
        )
      )
    )
    await win.locator('.chat-model-trigger').filter({ hasText: 'Echo 2' }).waitFor()
    t.check('model picker lists the adapter models and switches through the write IPC', true)
    await win.locator('.chat-state[data-state="working"]').waitFor()
    assert.equal(await win.locator('.chat-state').innerText(), 'working')
    // The provider's mark breathes as soon as the agent works, before any text.
    await win.locator('.chat-provider-mark[data-state="working"]').waitFor()
    await win.locator('.chat-turn-wrap[data-side="end"]').first().hover()
    await win.getByRole('button', { name: 'Copy message', exact: true }).first().click()
    assert.equal(await win.evaluate(() => navigator.clipboard.readText()), '/help\n')
    t.check('the working mark shows before text; a turn copies itself from its meta line', true)
    assert.equal(await waitingDot.count(), 1, 'view-only answers cannot clear kernel blocked state')
    await kernelState(app, record.id, 'working')
    assert.ok(await until(async () => (await waitingDot.count()) === 0))
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
    // Escape while working: a second interrupt, and the last message sent
    // ('/help' + the newline Shift+Enter left) is back in the composer.
    await input.press('Escape')
    assert.ok(
      await until(() =>
        app.evaluate(
          () => globalThis.__chatWrites.filter((x) => x.type === 'interrupt').length === 2
        )
      )
    )
    assert.equal(await input.inputValue(), '/help\n')
    await input.fill('')
    t.check('Escape interrupts the turn and hands the last message back to the composer', true)
    // A drag from Clave's own file or git panel carries newline-separated
    // absolute paths as text/plain; the composer takes them at the caret.
    await win.locator('.chat-composer').evaluate((form) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '/Users/example/notes/a b.txt\n/Users/example/src/c.ts')
      form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await until(async () => (await input.inputValue()) !== '')
    assert.equal(await input.inputValue(), "'/Users/example/notes/a b.txt' /Users/example/src/c.ts ")
    await input.fill('')
    t.check('dropping paths from the file and git panels pastes them into the composer', true)
    const sentBefore = await app.evaluate(
      () => globalThis.__chatWrites.filter((x) => x.type === 'user_message').length
    )
    await input.fill('/')
    await win.getByRole('option', { name: /\/help/ }).waitFor()
    assert.equal(await win.getByRole('option').count(), 2)
    await input.type('sh')
    await win.getByRole('option', { name: /\/shout/ }).waitFor()
    assert.equal(await win.getByRole('option').count(), 1)
    await input.press('Enter')
    assert.equal(await input.inputValue(), '/shout ')
    assert.equal(await win.getByRole('option').count(), 0)
    assert.equal(
      await app.evaluate(
        () => globalThis.__chatWrites.filter((x) => x.type === 'user_message').length
      ),
      sentBefore,
      'completing a command never sends the message'
    )
    await input.fill('')
    t.check('a slash lists the session commands, filters as typed, completes on Enter', true)
    assert.ok(
      true
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

// The host sidebar receives kernel state on its own channel, independently of
// the view's synthetic transcript and stubbed permission response above.
async function kernelState(app, id, state) {
  await app.evaluate(
    ({ BrowserWindow }, { id, state }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(`agent:state:${id}`, state),
    { id, state }
  )
}
