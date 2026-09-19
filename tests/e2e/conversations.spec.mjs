import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedWorkspaces, callMcp, until } from './harness.mjs'

/** Real Electron IPC with a deterministic service fixture. No paid providers. */
export async function run(t) {
  const directory = mkdtempSync(join(REPO, '.conversation-ui-e2e-'))
  const ROOT = join(directory, 'project')
  const DIR = join(directory, 'app')
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      {
        id: 'conversation-workspace',
        name: 'Conversations',
        rootDir: ROOT,
        profileFile: null,
        createdAt: 1
      }
    ],
    activeWorkspaceId: 'conversation-workspace',
    fresh: true
  })
  const { app, win } = await launchApp(DIR)
  try {
    await app.evaluate(({ ipcMain }, cwd) => {
      const fixture = (globalThis.__conversations = { calls: [], pty: [], snapshots: {} })
      for (const provider of ['claude', 'codex', 'pi', 'opencode']) {
        const id = `conversation-${provider}`
        fixture.snapshots[id] = {
          session: {
            id,
            provider,
            cwd,
            workspaceId: 'conversation-workspace',
            title: `Fixture ${provider}`,
            createdAt: '',
            updatedAt: '',
            status: 'idle',
            capabilities: { permissions: provider !== 'pi', questions: true, resume: true }
          },
          sequence: 0,
          entries: [],
          requests: []
        }
      }
      ipcMain.removeHandler('conversation:command')
      ipcMain.handle('conversation:command', (event, command) => {
        fixture.calls.push(command)
        if (command.type === 'list') return Object.values(fixture.snapshots).map((s) => s.session)
        const snapshot = fixture.snapshots[command.sessionId]
        if (command.type === 'snapshot') return snapshot
        const emit = (data) =>
          event.sender.send('conversation:event', {
            sessionId: snapshot.session.id,
            sequence: ++snapshot.sequence,
            timestamp: '',
            event: data
          })
        if (command.type === 'send') {
          const message = {
            kind: 'message',
            id: command.commandId,
            role: 'user',
            text: command.text
          }
          snapshot.entries.push(message)
          emit({ type: 'message', message })
          if (command.text === 'preflight') {
            const request = {
              id: 'preflight',
              kind: 'question',
              title: 'Before starting?',
              choices: ['Continue']
            }
            snapshot.requests.push(request)
            snapshot.session.status = 'waiting'
            emit({ type: 'request', request })
            return new Promise((resolve) => {
              fixture.acceptPreflight = resolve
            })
          }
          const answer = {
            kind: 'message',
            id: 'answer',
            role: 'assistant',
            text: '**Streamed** reply<script>window.__unsafe = true</script>'
          }
          snapshot.entries.push(answer)
          emit({ type: 'message', message: answer })
          const tool = {
            kind: 'tool',
            id: 'tool',
            name: 'Read file',
            input: 'README.md',
            output: 'fixture output',
            status: 'completed'
          }
          snapshot.entries.push(tool)
          emit({ type: 'tool', tool })
          const request = { id: 'permission', kind: 'permission', title: 'Run command?' }
          snapshot.requests.push(request)
          snapshot.session.status = 'waiting'
          emit({ type: 'request', request })
        }
        if (command.type === 'respond') {
          snapshot.requests = []
          emit({ type: 'request-resolved', requestId: command.response.requestId })
          if (command.response.requestId === 'preflight') {
            fixture.acceptPreflight()
            snapshot.session.status = 'idle'
            emit({ type: 'turn-end', outcome: 'completed' })
          }
        }
        if (command.type === 'interrupt') {
          snapshot.session.status = 'idle'
          emit({ type: 'turn-end', outcome: 'interrupted' })
        }
      })
      for (const channel of ['pty:start', 'pty:write', 'pty:resize']) {
        ipcMain.on(channel, (_event, id) => {
          if (typeof id === 'string' && id.startsWith('conversation-')) fixture.pty.push(channel)
        })
      }
    }, ROOT)
    // Exercise boot discovery with the service fixture installed before hydration.
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    t.check(
      'restores detached sessions on renderer reopen',
      await until(async () => (await win.locator('[data-testid="conversation-panel"]').count()) > 0)
    )
    for (const provider of ['claude', 'codex', 'pi', 'opencode']) {
      await callMcp(app, 'focus', { sessionId: `conversation-${provider}` })
      const panel = win.locator(`[data-conversation-id="conversation-${provider}"]`)
      await panel.getByRole('button', { name: 'Session details', exact: true }).click()
      t.check(
        `${provider} uses the shared view`,
        await until(async () =>
          (await win.getByTestId('conversation-capabilities').innerText())
            .toLowerCase()
            .includes(provider)
        )
      )
      await win.keyboard.press('Escape')
      await win.getByTestId('conversation-capabilities').waitFor({ state: 'detached' })
    }
    await callMcp(app, 'focus', { sessionId: 'conversation-pi' })
    t.check(
      'Pi visibly lacks approval support',
      await win
        .locator('[data-conversation-id="conversation-pi"]')
        .getByText(/Permission review not supported/)
        .isVisible()
    )
    await callMcp(app, 'focus', { sessionId: 'conversation-claude' })
    const panel = win.locator('[data-conversation-id="conversation-claude"]')
    await panel.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello service')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await panel.getByRole('button', { name: 'Allow', exact: true }).waitFor()
    t.check(
      'renders assistant Markdown',
      (await win.locator('article strong').filter({ hasText: 'Streamed' }).count()) > 0
    )
    t.equal(
      'Markdown cannot execute scripts',
      await win.evaluate(() => Boolean(window.__unsafe)),
      false
    )
    await win.locator('summary').filter({ hasText: 'Read · README.md' }).click()
    t.check(
      'tool output expands',
      await win
        .locator('.conversation-tool-preview')
        .getByText('fixture output', { exact: true })
        .isVisible()
    )
    await win.getByRole('button', { name: 'Allow', exact: true }).click()
    t.check(
      'permission response uses conversation IPC',
      await until(() =>
        app.evaluate(() =>
          globalThis.__conversations.calls.some(
            (call) => call.type === 'respond' && call.response.decision === 'allow'
          )
        )
      )
    )
    await win.getByRole('button', { name: 'Stop', exact: true }).click()
    t.check(
      'Stop interrupts the provider',
      await until(() =>
        app.evaluate(() =>
          globalThis.__conversations.calls.some((call) => call.type === 'interrupt')
        )
      )
    )
    await app.evaluate(({ BrowserWindow }) => {
      const snapshot = globalThis.__conversations.snapshots['conversation-claude']
      const request = {
        id: 'question',
        kind: 'question',
        title: 'Which environment?',
        choices: ['Development', 'Production']
      }
      snapshot.requests = [request]
      snapshot.session.status = 'waiting'
      BrowserWindow.getAllWindows()[0].webContents.send('conversation:event', {
        sessionId: snapshot.session.id,
        sequence: ++snapshot.sequence,
        timestamp: '',
        event: { type: 'request', request }
      })
    })
    await panel.getByRole('button', { name: 'Development', exact: true }).click()
    t.check(
      'question choice reaches the service',
      await until(() =>
        app.evaluate(() =>
          globalThis.__conversations.calls.some(
            (call) => call.type === 'respond' && call.response.answer === 'Development'
          )
        )
      )
    )
    await app.evaluate(({ BrowserWindow }) => {
      const snapshot = globalThis.__conversations.snapshots['conversation-claude']
      snapshot.session.status = 'error'
      snapshot.session.error = 'Fixture provider failed'
      BrowserWindow.getAllWindows()[0].webContents.send('conversation:event', {
        sessionId: snapshot.session.id,
        sequence: ++snapshot.sequence,
        timestamp: '',
        event: { type: 'turn-end', outcome: 'failed', error: snapshot.session.error }
      })
    })
    const editLast = panel.getByRole('button', { name: 'Edit last message', exact: true })
    await editLast.waitFor()
    t.check('provider failure is visible', await panel.getByRole('alert').isVisible())
    const sendsBeforeEdit = await app.evaluate(
      () => globalThis.__conversations.calls.filter((call) => call.type === 'send').length
    )
    await editLast.click()
    t.equal(
      'failed turn can be edited before resending',
      await panel.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
      'Hello service'
    )
    t.equal(
      'editing a failed message does not blindly resend',
      await app.evaluate(
        () => globalThis.__conversations.calls.filter((call) => call.type === 'send').length
      ),
      sendsBeforeEdit
    )
    const read = await callMcp(app, 'readSession', {
      sessionId: 'conversation-claude',
      callerSessionId: 'conversation-claude'
    })
    t.check(
      'MCP read uses service history without xterm',
      read.text.includes('Hello service') && read.text.includes('fixture output')
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    t.check(
      'remount restores history',
      await until(async () => (await win.locator('[data-testid="conversation-panel"]').count()) > 0)
    )
    await callMcp(app, 'focus', { sessionId: 'conversation-claude' })
    t.check(
      'restored response remains visible',
      await until(
        async () =>
          (await win.locator('article strong').filter({ hasText: 'Streamed' }).count()) > 0
      )
    )
    t.equal(
      'conversation panels never start/write/resize PTYs',
      await app.evaluate(() => globalThis.__conversations.pty.length),
      0
    )
    t.equal(
      'reopening never creates providers',
      await app.evaluate(
        () => globalThis.__conversations.calls.filter((call) => call.type === 'create').length
      ),
      0
    )
    const group = await callMcp(app, 'createGroup', { name: 'Direct only' })
    await callMcp(app, 'moveSession', {
      sessionId: 'conversation-opencode',
      groupId: group.groupId
    })
    await win.locator(`[data-sidebar-item-id="${group.groupId}"]`).click({ button: 'right' })
    await win.getByText('Pin group', { exact: true }).click()
    await win.getByRole('dialog', { name: 'Cannot save group' }).waitFor()
    t.check(
      'OpenCode pin fails visibly instead of becoming a terminal',
      (await win.getByRole('dialog', { name: 'Cannot save group' }).innerText()).includes(
        'OpenCode sessions cannot be pinned or exported'
      )
    )
    await win.getByRole('button', { name: 'OK', exact: true }).click()
    await callMcp(app, 'focus', { sessionId: 'conversation-claude' })
    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('preflight')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await win.getByRole('button', { name: 'Continue', exact: true }).click()
    t.check(
      'a preflight question is answerable while Send awaits acknowledgment',
      await app.evaluate(() =>
        globalThis.__conversations.calls.some(
          (call) => call.type === 'respond' && call.response.requestId === 'preflight'
        )
      )
    )
  } finally {
    await app.close()
    const owner = join(DIR, 'conversation-service/owner.json')
    if (existsSync(owner)) {
      const { pid } = JSON.parse(readFileSync(owner, 'utf8'))
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* this test's service already exited */
      }
      const stopped = await until(
        () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        },
        { tries: 50, gapMs: 100 }
      )
      t.check('the test-owned background service stops during cleanup', stopped === true)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
