// It also reads the terminal journal the app writes in that mode (PRDCT-3240).
/**
 * Mouse buttons are keymap bindings, and a session action bound to one acts on
 * the sidebar tab under the pointer.
 *
 * Proved on the running app, never on the code:
 *   - the shipped default: a middle click on a tab kills THAT tab, not the
 *     focused one, and asks nothing;
 *   - a middle click inside a terminal pane kills nothing;
 *   - the recorder in Settings → Keymaps takes a mouse button with modifiers,
 *     Save persists it, and the menu still builds;
 *   - removing the binding in Settings stops the middle click, so the
 *     behaviour is the keymap's and not a handler on the row;
 *   - "Archive and kill session" asks a Claude tab to archive and close
 *     itself, ignores a plain terminal, and the tab's own close ("mine") works.
 */
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  until,
  callMcp,
  writeJournal
} from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

const DIR = userDataDir('keymap-mouse')
const ROOT = fixturePath('root-keymap-mouse')
const WS = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000e4',
  name: 'MouseKeys',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const liveIds = (win) =>
  win.evaluate(() => window.electronAPI.sessionsList().then((all) => all.map((s) => s.id)))
const rowOf = (id) => `[data-sidebar-item-id="${id}"] button.sidebar-item`
const dialogOpen = (win) => win.evaluate(() => document.querySelector('.modal-card') !== null)

async function newTerminal(win) {
  const before = new Set(await liveIds(win))
  await win.click('.launcher-row button')
  const id = await until(async () => (await liveIds(win)).find((s) => !before.has(s)) ?? null)
  if (!id) throw new Error('no terminal was launched')
  await win.waitForSelector(rowOf(id), { timeout: 5000 })
  return id
}

async function terminals(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  const { app, win } = await launchApp(DIR)
  try {
    // Every byte the renderer writes into any PTY, read from the terminal journal.
    const writesTo = writeJournal(DIR)
    const first = await newTerminal(win)
    const second = await newTerminal(win)
    await win.click(rowOf(second))
    await win.waitForTimeout(300)
    const focused = await win.evaluate(
      () =>
        document.querySelector('[data-sidebar-item-type="session"] [data-selected="true"]') &&
        document
          .querySelector('[data-sidebar-item-type="session"]:has([data-selected="true"])')
          ?.getAttribute('data-sidebar-item-id')
    )
    t.equal('the second terminal is the focused one', focused, second)

    // --- The default binding: middle click kills the tab under the pointer ---
    await win.click(rowOf(first), { button: 'middle' })
    const firstGone = await until(async () => (!(await liveIds(win)).includes(first) ? true : null))
    t.check('a middle click on a tab kills that tab', firstGone === true)
    t.check('it kills the clicked tab, not the focused one', (await liveIds(win)).includes(second))
    t.check('it asks nothing', !(await dialogOpen(win)))
    t.check('the killed tab left the sidebar', (await win.$(rowOf(first))) === null)

    // --- Nowhere but on a tab ---
    const pane = win.locator('.xterm').first()
    await pane.waitFor({ timeout: 5000 })
    await pane.click({ button: 'middle' })
    await win.waitForTimeout(600)
    t.check(
      'a middle click inside a terminal pane kills nothing',
      (await liveIds(win)).includes(second)
    )

    // --- Recording a mouse binding in Settings ---
    await win.keyboard.press('Meta+,')
    await win.getByRole('button', { name: 'Keymaps', exact: true }).click()
    await win.waitForTimeout(300)
    const archiveRow = win.locator('.keymap-row').filter({ hasText: 'Archive and kill session' })
    t.check('the keymap editor lists "Archive and kill session"', (await archiveRow.count()) === 1)
    await archiveRow
      .getByRole('button', { name: 'Add binding for Archive and kill session' })
      .click()
    const recorder = archiveRow.locator('.keymap-binding')
    t.check(
      'the recorder invites a mouse button',
      (await recorder.innerText()).includes('mouse button'),
      await recorder.innerText()
    )
    await win.keyboard.down('Alt')
    await recorder.click({ button: 'middle' })
    await win.keyboard.up('Alt')
    t.check(
      'the recorder takes a mouse button with its modifier',
      (await archiveRow.innerText()).includes('⌥Middle click'),
      await archiveRow.innerText()
    )

    const killRow = win.locator('.keymap-row').filter({ hasText: /^Kill session/ })
    t.check(
      'the kill action shows its middle-click default',
      (await killRow.innerText()).includes('Middle click'),
      await killRow.innerText()
    )
    // Its second binding is the middle click; remove it.
    await killRow.getByRole('button', { name: 'Remove binding for Kill session' }).nth(1).click()
    await win.getByRole('button', { name: 'Save keymaps' }).click()
    await win.waitForTimeout(400)
    const saved = await win.evaluate(() => window.electronAPI.keymapsLoad())
    t.equal(
      'Save persists the mouse binding',
      JSON.stringify(saved?.bindings?.archiveAndKillSession),
      JSON.stringify(['Alt+MouseMiddle'])
    )
    t.equal(
      'and the kill action without its middle click',
      JSON.stringify(saved?.bindings?.killFocusedSession),
      JSON.stringify(['Mod+Backspace'])
    )
    const settingsAccelerator = await app.evaluate(({ Menu }) => {
      const settings = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find(
        (item) => item.label === 'Settings…'
      )
      return settings?.accelerator ?? null
    })
    t.equal('the native menu still builds after a mouse binding', settingsAccelerator, 'Command+,')
    await win.getByRole('button', { name: 'Back to sessions' }).click()
    await win.waitForTimeout(300)

    // --- The binding is the keymap's: unbound, the middle click does nothing ---
    await win.click(rowOf(second), { button: 'middle' })
    await win.waitForTimeout(600)
    t.check(
      'with the binding removed, a middle click kills nothing',
      (await liveIds(win)).includes(second)
    )

    // --- Control: a line typed through the app is in the write journal ---
    // Without this, "types nothing into it" below would also pass on a
    // journal that records nothing.
    await win.evaluate(
      ([s, line]) => window.electronAPI.writeSession(s, line),
      [second, 'echo KEYMAP-CONTROL\r']
    )
    const control = await until(async () => (await writesTo(second)).includes('KEYMAP-CONTROL'))
    t.check('control: a line typed through the app reaches the write journal', !!control)

    // --- Archive on a plain terminal: nothing typed, nothing killed ---
    await win.keyboard.down('Alt')
    await win.click(rowOf(second), { button: 'middle' })
    await win.keyboard.up('Alt')
    await win.waitForTimeout(800)
    t.check('archive leaves a plain terminal alive', (await liveIds(win)).includes(second))
    const typed = await writesTo(second)
    t.check(
      'and types nothing into it',
      !typed.includes('archive-session'),
      JSON.stringify(typed.slice(-200))
    )
  } finally {
    await app.close()
  }
}

async function claudeTab(t) {
  const chat = await openChat('keymap-mouse-chat')
  const { app, win, record } = chat
  try {
    await win.evaluate(() =>
      window.electronAPI.keymapsSave({
        version: 1,
        bindings: { archiveAndKillSession: ['Alt+MouseMiddle'] }
      })
    )
    await win.waitForTimeout(400)
    const row = rowOf(record.id)
    await win.waitForSelector(row, { timeout: 5000 })
    await win.keyboard.down('Alt')
    await win.click(row, { button: 'middle' })
    await win.keyboard.up('Alt')
    const view = win.locator('[data-testid="chat-view"]')
    const asked = await until(async () =>
      (await view.innerText()).includes('/exos:archive-session') ? true : null
    )
    const text = await view.innerText()
    t.check('the Claude tab receives the archive command', asked === true, text.slice(-400))
    t.check(
      'with the instruction to close its own tab',
      text.includes('clave_close_session with sessionId "mine"'),
      text.slice(-400)
    )
    t.check(
      'the tab is not killed by Clave before the agent is done',
      (await liveIds(win)).includes(record.id)
    )

    // The agent's last step: closing its own tab by "mine".
    const closed = await callMcp(app, 'closeSession', {
      sessionId: 'mine',
      callerSessionId: record.id
    })
    t.equal('clave_close_session "mine" closes the calling tab', closed?.closed, record.id)
    const gone = await until(async () => (!(await liveIds(win)).includes(record.id) ? true : null))
    t.check('and the tab is gone', gone === true)
  } finally {
    await chat.close()
  }
}

export async function run(t) {
  await terminals(t)
  await claudeTab(t)
}
