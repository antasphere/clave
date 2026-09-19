import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedWorkspaces, callMcp, until } from './harness.mjs'

const ID = 'conversation-tools-history'
const LAST = 'Inspect the panel\nPreserve my draft\nCheck the result'

/** Real Electron keyboard/layout checks with normalized events, no live agents. */
export async function run(t) {
  const directory = mkdtempSync(join(REPO, '.conversation-tools-history-'))
  const root = join(directory, 'project')
  const userData = join(directory, 'app')
  mkdirSync(root)
  seedWorkspaces(userData, {
    workspaces: [{ id: 'tools-history', name: 'Tools and history', rootDir: root, createdAt: 1 }],
    activeWorkspaceId: 'tools-history',
    fresh: true
  })
  let app
  try {
    const launched = await launchApp(userData)
    app = launched.app
    const win = launched.win
    win.setDefaultTimeout(5000)
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, { id, root, last }) => {
        const fixture = (globalThis.__toolsHistory = {
          calls: [],
          snapshot: {
            session: {
              id,
              provider: 'claude',
              cwd: root,
              workspaceId: 'tools-history',
              title: 'Tools and history',
              status: 'idle',
              createdAt: '',
              updatedAt: '',
              capabilities: { permissions: true, questions: true, resume: true }
            },
            sequence: 0,
            requests: [],
            entries: [
              { kind: 'message', id: 'user-1', role: 'user', text: 'First request' },
              {
                kind: 'message',
                id: 'assistant-1',
                role: 'assistant',
                text: 'I will inspect these files.'
              },
              ...['a', 'b', 'c'].map((name, i) => ({
                kind: 'tool',
                id: `read-${name}`,
                name: 'Read',
                status: 'completed',
                input: JSON.stringify({ file_path: `src/${name}.ts`, offset: 11, limit: 20 }),
                output: Array.from(
                  { length: 16 },
                  (_, line) => `line ${line + 1}: content ${i}`
                ).join('\n')
              })),
              {
                kind: 'tool',
                id: 'shell',
                name: 'Bash',
                status: 'completed',
                input: JSON.stringify({ command: 'npm test' }),
                output: 'All checks passed'
              },
              {
                kind: 'message',
                id: 'assistant-2',
                role: 'assistant',
                text: 'The files look consistent.'
              },
              { kind: 'message', id: 'user-2', role: 'user', text: last },
              {
                kind: 'tool',
                id: 'running',
                name: 'Grep',
                status: 'running',
                input: JSON.stringify({ pattern: 'composer', path: 'src' })
              }
            ]
          }
        })
        fixture.emit = (event) => {
          if (event.type === 'tool') {
            const index = fixture.snapshot.entries.findIndex((e) => e.id === event.tool.id)
            if (index < 0) fixture.snapshot.entries.push(event.tool)
            else fixture.snapshot.entries[index] = event.tool
          }
          if (event.type === 'message') fixture.snapshot.entries.push(event.message)
          if (event.type === 'request') fixture.snapshot.requests.push(event.request)
          if (event.type === 'request-resolved')
            fixture.snapshot.requests = fixture.snapshot.requests.filter(
              (request) => request.id !== event.requestId
            )
          if (event.type === 'turn-end') fixture.snapshot.session.status = 'idle'
          const envelope = {
            sessionId: id,
            sequence: ++fixture.snapshot.sequence,
            timestamp: '',
            event
          }
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send('conversation:event', envelope)
        }
        ipcMain.removeHandler('conversation:command')
        ipcMain.handle('conversation:command', (_event, command) => {
          fixture.calls.push(command)
          if (command.type === 'list') return [fixture.snapshot.session]
          if (command.type === 'snapshot') return fixture.snapshot
          if (command.type === 'send')
            fixture.emit({
              type: 'message',
              message: {
                kind: 'message',
                id: command.commandId,
                role: 'user',
                text: command.text
              }
            })
        })
      },
      { id: ID, root, last: LAST }
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    const panel = win.locator(`[data-conversation-id="${ID}"]`)
    await panel.waitFor()
    await callMcp(app, 'focus', { sessionId: ID })
    const input = panel.getByRole('textbox', { name: 'Message', exact: true })
    const caret = (position) =>
      input.evaluate((el, position) => el.setSelectionRange(position, position), position)
    const emit = (event) =>
      app.evaluate((_electron, event) => globalThis.__toolsHistory.emit(event), event)
    const groups = panel.locator('.conversation-tool-group')
    t.equal('mixed tools between messages share one dropdown', await groups.count(), 2)
    if ((await groups.count()) === 2) {
      const first = groups.first()
      const summary = first.locator(':scope > summary')
      t.check(
        'mixed summary counts reads and commands',
        /Read 3 files.*Ran 1 command/.test(await summary.innerText())
      )
      t.equal('completed groups start collapsed', await first.evaluate((el) => el.open), false)
      t.check(
        'summary fits on one line',
        await summary.evaluate((el) => {
          const label = el.querySelector('span')
          return getComputedStyle(label).whiteSpace === 'nowrap' && el.scrollWidth <= el.clientWidth
        })
      )
      await summary.click()
      t.check(
        'opening a large group keeps its heading in view',
        await until(async () => {
          const heading = await summary.boundingBox()
          const viewport = await panel.getByTestId('conversation-scroll').boundingBox()
          return (
            heading &&
            viewport &&
            heading.y >= viewport.y - 1 &&
            heading.y < viewport.y + viewport.height
          )
        })
      )
      t.check(
        'expanded group shows file paths and line ranges',
        (await first.innerText()).includes('src/a.ts') &&
          (await first.innerText()).includes('11–30')
      )
      if (process.env.CLAVE_UX_SCREENSHOT_DIR) {
        for (const theme of ['dark', 'light']) {
          await win.evaluate(
            (theme) => document.documentElement.setAttribute('data-theme', theme),
            theme
          )
          await summary.scrollIntoViewIfNeeded()
          await win.screenshot({
            path: join(process.env.CLAVE_UX_SCREENSHOT_DIR, `tool-group-${theme}.png`)
          })
        }
      }
      const preview = first.locator('.conversation-tool-preview').first()
      t.check(
        'content preview stops before line 9',
        !(await preview.innerText()).includes('line 9:')
      )
      await preview.getByRole('button', { name: 'Show more', exact: true }).click()
      t.check(
        'show more reveals remaining content',
        (await preview.innerText()).includes('line 16:')
      )
      const raw = first
        .locator('details')
        .filter({ has: win.locator('summary', { hasText: 'Raw details' }) })
        .first()
      await raw.locator('summary').click()
      t.check(
        'raw details retain original tool input',
        (await raw.innerText()).includes('"file_path"')
      )
      await summary.click()
      const active = groups.nth(1)
      await emit({
        type: 'tool',
        tool: {
          kind: 'tool',
          id: 'running',
          name: 'Grep',
          status: 'failed',
          input: '{"pattern":"composer","path":"src"}',
          output: 'Search failed'
        }
      })
      await active.locator(':scope > summary [aria-label="failed"]').waitFor()
      t.equal('failure keeps its group collapsed', await active.evaluate((el) => el.open), false)
      await active.locator(':scope > summary').click()
      t.check(
        'failure details are visible after opening the group',
        await active.getByText('Search failed', { exact: true }).first().isVisible()
      )
      await active.locator(':scope > summary').click()
      await emit({
        type: 'tool',
        tool: { kind: 'tool', id: 'more', name: 'Read', status: 'running', input: 'src/more.ts' }
      })
      t.check(
        'group grows without reopening a dismissed failure',
        await until(
          async () =>
            !(await active.evaluate((el) => el.open)) && (await active.innerText()).includes('Read')
        )
      )
      await emit({
        type: 'tool',
        tool: {
          kind: 'tool',
          id: 'more',
          name: 'Read',
          status: 'failed',
          input: 'src/more.ts',
          output: 'Read failed'
        }
      })
      await active.getByText('Read failed', { exact: true }).first().waitFor({ state: 'attached' })
      t.equal(
        'another failure does not reopen the group',
        await active.evaluate((el) => el.open),
        false
      )
      await active.locator(':scope > summary').click()
      await emit({
        type: 'tool',
        tool: {
          kind: 'tool',
          id: 'last-failure',
          name: 'Bash',
          status: 'failed',
          input: 'npm test',
          output: 'Command failed'
        }
      })
      await active.getByText('Command failed', { exact: true }).first().waitFor()
      t.equal(
        'an explicitly opened group stays open on failure',
        await active.evaluate((el) => el.open),
        true
      )
      await win.reload()
      await win.waitForLoadState('domcontentloaded')
      await active.waitFor()
      await active.locator(':scope > summary [aria-label="failed"]').waitFor()
      t.equal(
        'saved failures start collapsed after reload',
        await active.evaluate((el) => el.open),
        false
      )
      await emit({
        type: 'request',
        request: { id: 'approval', kind: 'permission', title: 'Allow test command?' }
      })
      t.check(
        'permission controls stay visible outside collapsed groups',
        await panel.getByRole('button', { name: 'Allow', exact: true }).isVisible()
      )
      for (const theme of ['light', 'coffee', 'dark']) {
        await win.evaluate(
          (theme) => document.documentElement.setAttribute('data-theme', theme),
          theme
        )
        t.check(
          `${theme} summary remains compact`,
          await summary.evaluate((el) => el.scrollWidth <= el.clientWidth)
        )
      }
    }
    await emit({ type: 'request-resolved', requestId: 'approval' })
    await emit({ type: 'turn-end', outcome: 'completed' })
    await input.press('ArrowUp')
    t.equal('empty composer recalls the latest sent message', await input.inputValue(), LAST)
    if ((await input.inputValue()) === LAST) {
      await caret(LAST.indexOf('Preserve') + 3)
      await input.press('ArrowUp')
      t.equal(
        'up inside a multiline message moves through text first',
        await input.inputValue(),
        LAST
      )
      await caret(0)
      await input.press('ArrowUp')
      t.equal(
        'up at the first line recalls the older user message',
        await input.inputValue(),
        'First request'
      )
      await input.press('ArrowUp')
      t.equal('oldest history entry does not wrap', await input.inputValue(), 'First request')
      await input.press('ArrowDown')
      t.equal('down recalls the next user message', await input.inputValue(), LAST)
      await caret(LAST.length)
      await input.press('ArrowDown')
      t.equal('down past newest restores an empty composer', await input.inputValue(), '')
      await input.press('ArrowUp')
      await input.press('End')
      await input.type(' edited')
      const edited = await input.inputValue()
      await caret(0)
      await input.press('ArrowUp')
      t.equal('editing recalled text exits history browsing', await input.inputValue(), edited)
      await input.press('Enter')
      t.check(
        'sending recalled text creates a new message',
        await until(async () =>
          app.evaluate(
            (_electron, text) =>
              globalThis.__toolsHistory.snapshot.entries.some(
                (e) => e.kind === 'message' && e.text === text && e.id !== 'user-2'
              ),
            edited
          )
        )
      )
      t.check(
        'original sent message remains unchanged',
        await app.evaluate(
          (_electron, last) =>
            globalThis.__toolsHistory.snapshot.entries.find((e) => e.id === 'user-2').text === last,
          LAST
        )
      )
      t.check(
        'new send clears its recalled draft',
        await until(async () => (await input.inputValue()) === '')
      )
      await win.reload()
      await win.waitForLoadState('domcontentloaded')
      await input.waitFor()
      await callMcp(app, 'focus', { sessionId: ID })
      await input.press('ArrowUp')
      t.equal('recall uses saved messages after renderer reload', await input.inputValue(), edited)
      await input.fill('')
    }
    const wrapped =
      'A long paragraph with enough words to wrap across several visual lines. '.repeat(20)
    await emit({
      type: 'message',
      message: { kind: 'message', role: 'user', id: 'wrapped', text: wrapped }
    })
    await input.fill('')
    await input.press('ArrowUp')
    await caret(Math.floor(wrapped.length / 2))
    await input.press('ArrowUp')
    t.equal(
      'up inside a soft-wrapped paragraph keeps the recalled text',
      await input.inputValue(),
      wrapped
    )
    await input.press('ArrowDown')
    t.equal(
      'down inside a soft-wrapped paragraph keeps the recalled text',
      await input.inputValue(),
      wrapped
    )
    await caret(wrapped.length)
    await input.press('ArrowDown')
    t.equal('down on the final wrapped line leaves history', await input.inputValue(), '')
    await input.fill('An unsent draft')
    await caret(0)
    await input.press('ArrowUp')
    t.equal('up does not replace an ordinary draft', await input.inputValue(), 'An unsent draft')
    await input.fill('')
    await input.dispatchEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true })
    t.equal('IME arrow keys do not recall messages', await input.inputValue(), '')
  } finally {
    if (app) await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
