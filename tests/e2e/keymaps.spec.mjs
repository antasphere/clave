/**
 * The configurable keymap boundary: defaults enter command mode, Save is the
 * only activation point, main broadcasts accepted overrides to every renderer,
 * and the native menu reads the same accepted configuration.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launchApp, openWindow, seedWorkspaces, userDataDir } from './harness.mjs'
/** The shipped master key, read out of the source rather than hardcoded here, so
 *  this spec cannot pass against a chord the app no longer uses. Read as text: a
 *  spec that imports TypeScript would depend on the runner's type stripping. */
const MASTER = readFileSync(new URL('../../src/shared/keymaps.ts', import.meta.url), 'utf-8').match(
  /DEFAULT_MASTER_KEY = '([^']+)'/
)?.[1]
if (!MASTER) throw new Error('keymaps.ts no longer declares DEFAULT_MASTER_KEY')
const GLYPHS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
/** The master as the Keymaps pane prints it, and as Playwright presses it. */
const MASTER_GLYPH = MASTER.split('+')
  .map((token) => GLYPHS[token] ?? token)
  .join('')
const MASTER_PRESS = MASTER.replace('Mod', 'Meta').replace('Ctrl', 'Control')

const DIR = userDataDir('keymaps')
const ROOT = '/tmp/clave-e2e-keymaps-root'
const IMPORT_FILE = `${DIR}/import-keymaps.json`
const EXPORT_FILE = `${DIR}/exported-keymaps.json`
const WORKSPACE = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000aa',
  name: 'Keymaps',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WORKSPACE], activeWorkspaceId: WORKSPACE.id, fresh: true })
  writeFileSync(
    IMPORT_FILE,
    JSON.stringify({ version: 1, bindings: { openSettings: ['Mod+Shift+K'] } }, null, 2)
  )
  const { app, win } = await launchApp(DIR)

  try {
    await win.keyboard.press('Meta+,')
    await win.getByRole('button', { name: 'Keymaps', exact: true }).click()
    await win.waitForTimeout(300)

    const initial = await win.locator('body').innerText()
    t.check(
      'Settings exposes the keymap editor',
      initial.includes('Keymaps') && initial.includes('Master key')
    )
    t.check(`the default master key is ${MASTER}`, initial.includes(MASTER_GLYPH), initial)
    t.check('the editor says changes wait for Save', initial.includes('Changes stay in this draft'))

    const terminalRow = win.locator('.keymap-row').filter({ hasText: 'New terminal' }).first()
    await terminalRow.locator('.keymap-binding').first().click()
    await win.keyboard.press('Meta+J')
    t.check('the action editor records a chord', (await terminalRow.innerText()).includes('⌘J'))
    await terminalRow.getByRole('button', { name: 'Reset New terminal' }).click()
    t.check('an action can reset to its default', (await terminalRow.innerText()).includes('⌘T'))

    // Open the second renderer before changing anything. The save must update it
    // without a reload or a new-window bootstrap read.
    const { page: second } = await openWindow(app, win, WORKSPACE.id, { settleMs: 1200 })

    await app.evaluate(async ({ dialog }, importFile) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [importFile] })
    }, IMPORT_FILE)
    await win.getByRole('button', { name: 'Import' }).click()
    await win.waitForTimeout(150)
    t.check(
      'Import stages JSON without activating it',
      (await win.locator('body').innerText()).includes('Imported as a draft')
    )

    // It is still a draft. The old key opens Settings in the second window.
    await second.keyboard.press('Meta+,')
    await second.waitForTimeout(250)
    t.check(
      'editing JSON does not activate it before Save',
      (await second.locator('body').innerText()).includes('General')
    )
    await second.getByRole('button', { name: 'Back to sessions' }).click()

    await win.getByRole('button', { name: 'Save keymaps' }).click()
    await win.waitForTimeout(350)
    t.check(
      'Save reports immediate all-window activation',
      (await win.locator('body').innerText()).includes('active in every window')
    )

    await second.keyboard.press('Meta+Shift+K')
    await second.waitForTimeout(250)
    t.check(
      'an already-open second window uses the new binding immediately',
      (await second.locator('body').innerText()).includes('General')
    )

    const menuAccelerator = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const settings = menu?.items[0]?.submenu?.items.find((item) => item.label === 'Settings…')
      return settings?.accelerator ?? null
    })
    t.equal(
      'the native menu label is rebuilt from the accepted binding',
      menuAccelerator,
      'Command+Shift+K'
    )

    await app.evaluate(async ({ dialog }, exportFile) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportFile })
    }, EXPORT_FILE)
    await win.getByRole('button', { name: 'Export' }).click()
    t.equal(
      'Export writes the validated override document',
      JSON.parse(readFileSync(EXPORT_FILE, 'utf-8')).bindings.openSettings[0],
      'Mod+Shift+K'
    )

    await win
      .getByRole('textbox', { name: 'Raw keymap JSON' })
      .fill(
        JSON.stringify(
          { version: 1, bindings: { newTerminal: ['Mod+Shift+K'], openSettings: ['Mod+Shift+K'] } },
          null,
          2
        )
      )
    await win.getByRole('button', { name: 'Save keymaps' }).click()
    t.check(
      'invalid conflicts are rejected at Save',
      (await win.locator('body').innerText()).includes('already assigned')
    )
    await second.getByRole('button', { name: 'Back to sessions' }).click()
    await second.keyboard.press('Meta+Shift+K')
    await second.waitForTimeout(250)
    t.check(
      'a rejected save leaves the last valid keymap active',
      (await second.locator('body').innerText()).includes('General')
    )

    await win.getByRole('button', { name: 'Back to sessions' }).click()
    await win.keyboard.press(MASTER_PRESS)
    t.check(
      'the master key enters visible command mode',
      await win.evaluate(() => document.querySelector('.keymap-command-hud') !== null)
    )
    await win.keyboard.press('Escape')
    await win.keyboard.press(MASTER_PRESS)
    await win.keyboard.press('c')
    await win.waitForTimeout(3500)
    const rows = await win.locator('[data-sidebar-item-type="session"]').count()
    t.check(`${MASTER} C launches a Claude session`, rows > 0, rows)
  } finally {
    await app.close()
  }
}
