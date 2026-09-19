import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPO, launchApp, seedWorkspaces, callMcp, until } from './harness.mjs'

const CLAUDE = 'conversation-ux-claude'
const PI = 'conversation-ux-pi'
const NOTICE = 'Pi does not provide an approval gate. Review commands before sending.'
const review = `## Keep the active reader in place

The session service owns the transcript. The renderer should only follow new output when the reader is already at the bottom.

### Implementation notes

- Track the distance from the bottom before applying an event.
- Keep the composer draft separate from the submitted message.
- Let permission requests remain interactive while the send acknowledgment is pending.

\`\`\`typescript
const shouldFollow = scrollHeight - scrollTop - clientHeight < 48
const path = "src/renderer/src/components/terminal/ConversationPanel.tsx"
\`\`\`

| Scenario | Expected behavior |
| --- | --- |
| Reading earlier output | Keep the same paragraph visible |
| Following the current answer | Reveal each new line |

The regression should observe the real scroll container, not just the presence of the last message.`

// Locate by behavior rather than binding the test to the layout's utility classes.
function scrollMetrics(article, action) {
  let element = article.parentElement
  while (element && !['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) {
    element = element.parentElement
  }
  if (!element) throw new Error('No scrolling transcript ancestor')
  if (action === 'older') {
    element.scrollTop = 120
    element.dispatchEvent(new Event('scroll'))
  }
  return {
    top: element.scrollTop,
    height: element.scrollHeight,
    viewport: element.clientHeight,
    remaining: element.scrollHeight - element.clientHeight - element.scrollTop
  }
}

/** Real Electron, deterministic IPC, no provider processes or paid prompts. */
export async function run(t) {
  const directory = mkdtempSync(join(REPO, '.conversation-ux-e2e-'))
  const root = join(directory, 'project')
  const userData = join(directory, 'app')
  mkdirSync(root)
  seedWorkspaces(userData, {
    workspaces: [
      {
        id: 'ux-workspace',
        name: 'Conversation UX',
        rootDir: root,
        profileFile: null,
        createdAt: 1
      }
    ],
    activeWorkspaceId: 'ux-workspace',
    fresh: true
  })
  let app
  try {
    const launched = await launchApp(userData)
    app = launched.app
    const win = launched.win
    win.setDefaultTimeout(5000)
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, { root, review, notice }) => {
        const fixture = (globalThis.__conversationUX = {
          calls: [],
          snapshots: {},
          pending: null,
          holdNext: false
        })
        for (const provider of ['claude', 'pi']) {
          const id = `conversation-ux-${provider}`
          fixture.snapshots[id] = {
            session: {
              id,
              provider,
              cwd: root,
              workspaceId: 'ux-workspace',
              title: `${provider}: transcript follow behavior`,
              createdAt: '',
              updatedAt: '',
              status: 'idle',
              capabilities: {
                permissions: provider !== 'pi',
                questions: true,
                resume: true,
                ...(provider === 'pi' ? { notice } : {})
              }
            },
            sequence: 0,
            entries: [
              {
                kind: 'message',
                id: 'opening',
                role: 'user',
                text: 'Review the conversation panel. Keep my place while I read earlier output, and preserve drafts when I switch sessions.'
              },
              ...Array.from({ length: 9 }, (_, i) => [
                {
                  kind: 'message',
                  id: `review-${i}`,
                  role: 'assistant',
                  text: `### Review pass ${i + 1}\n\n${review}`
                },
                {
                  kind: 'tool',
                  id: `tool-${i}`,
                  name: 'Read file',
                  input: 'src/renderer/src/components/terminal/ConversationPanel.tsx',
                  output: `Pass ${i + 1}: inspected the scroll effect and composer state.\nNo files changed.`,
                  status: 'completed'
                }
              ]).flat(),
              {
                kind: 'message',
                id: 'stream',
                role: 'assistant',
                text: '## Verification plan\n\nI will exercise draft isolation, keyboard input, and scroll following in real Electron.'
              }
            ],
            requests: []
          }
        }
        // Tests inject normalized service events through this function. Update the
        // fixture snapshot too, so renderer reloads never lose injected history.
        fixture.emit = (sessionId, event) => {
          const snapshot = fixture.snapshots[sessionId]
          if (event.type === 'message') snapshot.entries.push(event.message)
          if (event.type === 'text-delta') {
            snapshot.entries.find((entry) => entry.id === event.messageId).text += event.text
          }
          if (event.type === 'request') {
            snapshot.requests.push(event.request)
            snapshot.session.status = 'waiting'
          }
          if (event.type === 'request-resolved') {
            snapshot.requests = snapshot.requests.filter(
              (request) => request.id !== event.requestId
            )
          }
          if (event.type === 'turn-end') snapshot.session.status = 'idle'
          if (event.type === 'status') snapshot.session.status = event.status
          const envelope = {
            sessionId,
            sequence: ++snapshot.sequence,
            timestamp: new Date().toISOString(),
            event
          }
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send('conversation:event', envelope)
          }
        }
        ipcMain.removeHandler('conversation:command')
        ipcMain.handle('conversation:command', (_event, command) => {
          fixture.calls.push(command)
          if (command.type === 'list') return Object.values(fixture.snapshots).map((s) => s.session)
          if (command.type === 'snapshot') return fixture.snapshots[command.sessionId]
          if (command.type === 'send') {
            fixture.emit(command.sessionId, {
              type: 'message',
              message: { kind: 'message', id: command.commandId, role: 'user', text: command.text }
            })
            if (fixture.holdNext) {
              fixture.holdNext = false
              return new Promise((resolve) => {
                fixture.pending = resolve
              })
            }
          }
          if (command.type === 'respond') {
            fixture.emit(command.sessionId, {
              type: 'request-resolved',
              requestId: command.response.requestId
            })
          }
          if (command.type === 'interrupt') {
            fixture.emit(command.sessionId, { type: 'turn-end', outcome: 'interrupted' })
          }
        })
      },
      { root, review, notice: NOTICE }
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.locator('[data-testid="conversation-panel"]').first().waitFor()
    await callMcp(app, 'focus', { sessionId: CLAUDE })
    const panel = win.locator(`[data-conversation-id="${CLAUDE}"]`)
    const composer = panel.getByRole('textbox', { name: 'Message', exact: true })
    await composer.waitFor()
    t.equal(
      'sent messages have no repeated You label',
      await panel.locator('article').getByText('You', { exact: true }).count(),
      0
    )
    t.equal(
      'received messages have no repeated provider label',
      await panel.locator('article').getByText('Claude', { exact: true }).count(),
      0
    )
    const calls = (type) =>
      app.evaluate(
        (_electron, type) => globalThis.__conversationUX.calls.filter((call) => call.type === type),
        type
      )
    const emit = (event, sessionId = CLAUDE) =>
      app.evaluate(
        (_electron, { sessionId, event }) => globalThis.__conversationUX.emit(sessionId, event),
        { sessionId, event }
      )

    await composer.fill('First line')
    await composer.press('Shift+Enter')
    await composer.press('End')
    await composer.type('Second line')
    t.equal('Shift+Enter inserts a newline', await composer.inputValue(), 'First line\nSecond line')
    t.equal('Shift+Enter does not send', (await calls('send')).length, 0)
    await composer.press('Enter')
    t.check(
      'Enter sends exactly one multiline message',
      await until(async () => {
        const sent = await calls('send')
        return sent.length === 1 && sent[0].text === 'First line\nSecond line'
      })
    )
    t.check(
      'accepted message clears the submitted draft',
      await until(async () => (await composer.inputValue()) === '')
    )

    await composer.fill('入力中')
    const sentBeforeIME = (await calls('send')).length
    await composer.dispatchEvent('compositionstart', { data: '' })
    await composer.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
      isComposing: true,
      bubbles: true
    })
    await composer.dispatchEvent('compositionend', { data: '入力中' })
    await win.waitForTimeout(150)
    t.equal('IME composing Enter never sends', (await calls('send')).length, sentBeforeIME)
    t.equal('IME composing Enter keeps the draft', await composer.inputValue(), '入力中')

    await composer.fill('Claude draft: inspect the reducer')
    await callMcp(app, 'focus', { sessionId: PI })
    const piPanel = win.locator(`[data-conversation-id="${PI}"]`)
    const piComposer = piPanel.getByRole('textbox', { name: 'Message', exact: true })
    await piComposer.fill('Pi draft: add the regression')
    await callMcp(app, 'focus', { sessionId: CLAUDE })
    t.equal(
      'Claude draft survives switching sessions',
      await composer.inputValue(),
      'Claude draft: inspect the reducer'
    )
    await callMcp(app, 'focus', { sessionId: PI })
    t.equal(
      'Pi keeps its independent draft',
      await piComposer.inputValue(),
      'Pi draft: add the regression'
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.locator('[data-testid="conversation-panel"]').first().waitFor()
    await callMcp(app, 'focus', { sessionId: CLAUDE })
    t.equal(
      'Claude draft survives renderer remount',
      await composer.inputValue(),
      'Claude draft: inspect the reducer'
    )
    await callMcp(app, 'focus', { sessionId: PI })
    t.equal(
      'Pi draft survives renderer remount',
      await piComposer.inputValue(),
      'Pi draft: add the regression'
    )
    t.check(
      'Pi limitation is visible without opening details',
      await piPanel.getByText(/Permission review not supported|approval prompts/).isVisible()
    )
    await callMcp(app, 'focus', { sessionId: CLAUDE })

    await app.evaluate(() => {
      globalThis.__conversationUX.holdNext = true
    })
    await composer.fill('Run the focused regression')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    t.check(
      'fixture holds the send acknowledgment',
      await until(() => app.evaluate(() => Boolean(globalThis.__conversationUX.pending)))
    )
    await composer.fill('Next draft: inspect the failure output')
    await emit({
      type: 'request',
      request: {
        id: 'approval',
        kind: 'permission',
        title: 'Run the focused test?',
        description: 'npm run test:e2e -- conversation-ux'
      }
    })
    await panel.getByRole('button', { name: 'Allow', exact: true }).click()
    t.check(
      'permission remains usable during pending send',
      (await calls('respond')).some(
        (call) => call.response.requestId === 'approval' && call.response.decision === 'allow'
      )
    )
    await emit({
      type: 'request',
      request: {
        id: 'target',
        kind: 'question',
        title: 'Which test target?',
        choices: ['Real Electron', 'Unit only']
      }
    })
    await panel.getByRole('button', { name: 'Real Electron', exact: true }).click()
    t.check(
      'question remains usable during pending send',
      (await calls('respond')).some(
        (call) => call.response.requestId === 'target' && call.response.answer === 'Real Electron'
      )
    )
    await app.evaluate(() => {
      globalThis.__conversationUX.pending()
      globalThis.__conversationUX.pending = null
    })
    await emit({ type: 'turn-end', outcome: 'completed' })
    await panel.getByRole('button', { name: 'Send', exact: true }).waitFor()
    await win.waitForTimeout(150)
    t.equal(
      'late send acknowledgment preserves the next draft',
      await composer.inputValue(),
      'Next draft: inspect the failure output'
    )

    const article = panel.getByRole('article', { name: 'assistant message', exact: true }).first()
    const before = await article.evaluate(scrollMetrics, 'older')
    t.check('fixture contains enough history to scroll', before.height > before.viewport * 3)
    await win.waitForTimeout(100)
    await emit({
      type: 'text-delta',
      messageId: 'stream',
      text: '\n\nNew output while the reader checks an earlier review pass.'
    })
    await panel
      .getByText('New output while the reader checks an earlier review pass.', { exact: true })
      .waitFor({ state: 'attached' })
    await win.waitForTimeout(150)
    const after = await article.evaluate(scrollMetrics)
    t.check(
      'streaming delta preserves the older reading position',
      Math.abs(after.top - before.top) < 2,
      { before, after }
    )
    const jump = panel.getByRole('button', { name: 'Jump to latest', exact: true })
    t.check('scrolled-up reader gets Jump to latest', await jump.isVisible())
    if (await jump.isVisible()) {
      await jump.click()
      t.check(
        'Jump to latest reaches the transcript bottom',
        await until(async () => (await article.evaluate(scrollMetrics)).remaining < 4)
      )
      const attachedHeight = (await article.evaluate(scrollMetrics)).height
      await emit({
        type: 'text-delta',
        messageId: 'stream',
        text: '\n\n' + 'The follow-up regression passed.\n\n'.repeat(15)
      })
      t.check(
        'new deltas follow after reattaching',
        await until(async () => {
          const metrics = await article.evaluate(scrollMetrics)
          return metrics.height > attachedHeight + 100 && metrics.remaining < 4
        })
      )
    }

    await emit({ type: 'status', status: 'running' })
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()
    t.check(
      'Stop interrupts the conversation',
      (await calls('interrupt')).some((call) => call.sessionId === CLAUDE)
    )
    await panel.getByRole('button', { name: 'Session details', exact: true }).click()
    t.check(
      'capabilities are available in Session details',
      await win
        .getByTestId('conversation-capabilities')
        .getByText(/Permission review available/)
        .isVisible()
    )
    await win.keyboard.press('Escape')

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(640, 480)
      window.setSize(760, 720)
    })
    for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
      await win.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      // Capture settled theme tokens, not the middle of the shared color transition.
      await win.waitForTimeout(250)
      t.equal(
        `${theme} theme is applied`,
        await win.evaluate(() => document.documentElement.dataset.theme),
        theme
      )
      const messages = await panel.evaluate((element) => {
        const sent = element.querySelector('article[data-role="user"]')
        const received = element.querySelector('article[data-role="assistant"]')
        return {
          sent: sent && getComputedStyle(sent).backgroundColor,
          received: received && getComputedStyle(received).backgroundColor,
          surface: getComputedStyle(element).backgroundColor,
          labelled:
            sent?.getAttribute('aria-label') === 'user message' &&
            received?.getAttribute('aria-label') === 'assistant message'
        }
      })
      t.check(
        `${theme} distinguishes sent and received messages without author labels`,
        messages.labelled &&
          !!messages.sent &&
          messages.sent !== 'rgba(0, 0, 0, 0)' &&
          messages.sent !== messages.surface &&
          messages.received === 'rgba(0, 0, 0, 0)',
        messages
      )
      await panel.locator('summary').first().click()
      const fit = await panel.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const textarea = element.querySelector('textarea').getBoundingClientRect()
        const articles = [...element.querySelectorAll('article')].map((article) =>
          article.getBoundingClientRect()
        )
        const transcript = element.querySelector('[data-testid="conversation-scroll"]')
        return {
          panelFits: box.left >= 0 && box.right <= innerWidth + 1,
          composerFits: textarea.left >= box.left && textarea.right <= box.right + 1,
          messagesFit: articles.every(
            (article) => article.left >= box.left && article.right <= box.right + 1
          ),
          noTranscriptOverflow:
            transcript !== null && transcript.scrollWidth <= transcript.clientWidth + 1,
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
        }
      })
      t.check(
        `${theme} narrow layout fits messages and composer`,
        Object.values(fit).every(Boolean),
        fit
      )
      t.check(
        `${theme} tool details remain usable`,
        await panel
          .locator('.conversation-tool-preview')
          .getByText('Pass 1: inspected the scroll effect and composer state.\nNo files changed.', {
            exact: true
          })
          .isVisible()
      )
      if (process.env.CLAVE_UX_SCREENSHOT_DIR && ['dark', 'light'].includes(theme)) {
        const screenshots = resolve(process.env.CLAVE_UX_SCREENSHOT_DIR)
        mkdirSync(screenshots, { recursive: true })
        await win.screenshot({ path: join(screenshots, `conversation-${theme}.png`) })
      }
      await panel.locator('summary').first().click()
    }
    if (process.env.CLAVE_UX_SCREENSHOT_DIR) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
      await win.evaluate(() => {
        document.documentElement.dataset.theme = 'dark'
      })
      await panel.getByTestId('conversation-scroll').evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      await win.waitForTimeout(250)
      await panel.screenshot({
        path: join(resolve(process.env.CLAVE_UX_SCREENSHOT_DIR), 'conversation-overview.png')
      })
    }
  } finally {
    if (app) await app.close()
    const owner = join(userData, 'conversation-service/owner.json')
    if (existsSync(owner)) {
      const { pid } = JSON.parse(readFileSync(owner, 'utf8'))
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // This exact test-owned daemon already exited.
      }
      t.check(
        'test-owned daemon stops',
        await until(
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
      )
    }
    rmSync(directory, { recursive: true, force: true })
  }
}
