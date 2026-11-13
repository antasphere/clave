// The first-run walk (src/main/onboarding.ts, components/onboarding/): a first
// install opens on it, its four steps lead to a workspace made where the
// reader chose, and once finished it never comes back on its own.
//
// Nothing of the machine's is touched: the data folder is the spec's, the
// machine's Claude login is not read (--test-no-machine-usage), the machine's
// Codex home is replaced by an empty one, so no assistant reads as connected
// and the walk makes the workspace without starting an agent on anyone's
// account. Install and Sign in are never pressed.
//
// What goes red when it breaks: a test instance (every other spec) opening on
// the walk, a first install not opening on it, a step that does not lead to
// the next, the chat style not becoming the default view, the folder not
// made under the chosen place, the workspace not registered, and the walk
// coming back after it was finished.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fixturePath, launchApp, stubFolderDialog, until, userDataDir } from './harness.mjs'

const SHOTS = process.env.CLAVE_E2E_ONBOARDING_SHOTS || null

async function shot(win, name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined)
}

async function title(win) {
  return (await win.locator('.onb-title').textContent())?.trim() ?? ''
}

export async function run(t) {
  const codexHome = fixturePath('onboarding-codex-home')
  rmSync(codexHome, { recursive: true, force: true })
  mkdirSync(codexHome, { recursive: true })
  const env = { CODEX_HOME: codexHome }

  // 1. A test instance on an empty data folder: no walk without the flag.
  {
    const dir = userDataDir('onboarding-off')
    rmSync(dir, { recursive: true, force: true })
    const { app, win } = await launchApp(dir, { env, args: ['--test-no-machine-usage'] })
    try {
      await win.waitForTimeout(1500)
      t.check(
        'a test instance never opens on the walk unless asked',
        (await win.locator('[data-testid="onboarding"]').count()) === 0
      )
    } finally {
      await app.close()
    }
  }

  // 2. A first install, walked from end to end.
  const dir = userDataDir('onboarding-walk')
  rmSync(dir, { recursive: true, force: true })
  const parent = fixturePath('onboarding-parent')
  rmSync(parent, { recursive: true, force: true })
  mkdirSync(parent, { recursive: true })
  const args = ['--test-no-machine-usage', '--test-onboarding']
  {
    const { app, win } = await launchApp(dir, { env, args })
    try {
      await win.setViewportSize({ width: 1180, height: 760 }).catch(() => undefined)
      const walk = win.locator('[data-testid="onboarding"]')
      await walk.waitFor({ state: 'visible', timeout: 15_000 })
      t.check('a first install opens on the walk', true)
      assert.equal(await title(win), 'Welcome to Clave')
      await win.waitForTimeout(700)
      await shot(win, '1-welcome')

      await win.getByRole('button', { name: 'Get started' }).click()

      // The look: the walk starts on the skin matching the Mac (Charcoal for
      // dark, Light for light), and a pick switches the skin at once.
      await win.locator('[data-onboarding-skin]').first().waitFor()
      assert.equal(await title(win), 'Pick a look')
      const device = await win.evaluate(() =>
        window.matchMedia('(prefers-color-scheme: dark)').matches ? 'charcoal' : 'light'
      )
      t.check(
        'the walk starts on the skin matching the Mac',
        Boolean(
          await until(
            async () =>
              (await win
                .locator(`[data-onboarding-skin="${device}"]`)
                .getAttribute('aria-checked')) === 'true'
          )
        )
      )
      t.check(
        'all four skins are offered',
        (await win.locator('[data-onboarding-skin]').count()) === 4
      )
      await win.locator('[data-onboarding-skin="coffee"]').click()
      t.check(
        'a pick switches the skin at once',
        Boolean(
          await until(
            async () =>
              (await win
                .locator('[data-onboarding-skin="coffee"]')
                .getAttribute('aria-checked')) === 'true'
          )
        )
      )
      await win.waitForTimeout(900)
      await shot(win, '1b-look')
      await win.getByRole('button', { name: 'Continue' }).click()

      await win.locator('[data-onboarding-provider="claude"]').waitFor({ timeout: 20_000 })
      assert.equal(await title(win), 'Connect your assistant')
      t.check(
        'the connect step offers Claude and ChatGPT',
        (await win.locator('[data-onboarding-provider]').count()) === 2
      )
      await win.waitForTimeout(900)
      await shot(win, '2-connect')
      // Nothing is connected here, so the way on is a skip.
      await win.getByRole('button', { name: 'Skip for now' }).click()

      await win.locator('[data-onboarding-chat-view]').first().waitFor()
      assert.equal(await title(win), 'What kind of chat do you prefer?')
      t.check(
        'four ways to open a conversation are offered',
        (await win.locator('[data-onboarding-chat-view]').count()) === 4
      )
      await win.locator('[data-onboarding-chat-view="clave.chat-view/lab"]').click()
      t.check(
        'picking a style marks it chosen',
        (await win
          .locator('[data-onboarding-chat-view="clave.chat-view/lab"]')
          .getAttribute('aria-checked')) === 'true'
      )
      await win.waitForTimeout(900)
      await shot(win, '3-chat')
      await win.getByRole('button', { name: 'Continue' }).click()

      await win.locator('[data-onboarding-create]').waitFor()
      assert.equal(await title(win), 'Make your first workspace')
      await stubFolderDialog(app, { returns: parent })
      await win.getByRole('button', { name: 'Change…' }).click()
      await win.getByLabel('Workspace name').fill('First steps')
      await until(async () =>
        ((await win.locator('.onb-folder-path').textContent()) ?? '').endsWith('/First steps')
      )
      await win.waitForTimeout(600)
      await shot(win, '4-workspace')
      await win.locator('[data-onboarding-create]').click()

      await until(async () => (await title(win)) === 'First steps is ready', { tries: 60 })
      t.check('the walk ends at its door', (await title(win)) === 'First steps is ready')
      const folder = path.join(parent, 'First steps')
      t.check('the workspace folder is made under the chosen place', existsSync(folder))
      await win.waitForTimeout(2200)
      await shot(win, '5-done')
      await win.getByRole('button', { name: 'Start using Clave' }).click()
      await walk.waitFor({ state: 'detached', timeout: 5_000 })

      const prefs = JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf-8'))
      t.check('the chosen style is the interaction mode', prefs.interactionMode === 'folio')
      t.check('the walk is recorded as done', prefs.onboarding === 'done')
      t.check('the picked skin is kept', prefs.activeSkinId === 'coffee')
      await win.waitForTimeout(600)
      await shot(win, '6-after')
    } finally {
      await app.close()
    }
  }

  // 3. The next launch opens on the app, not on the walk.
  {
    const { app, win } = await launchApp(dir, { env, args })
    try {
      await win.waitForTimeout(1500)
      t.check(
        'a finished walk does not come back',
        (await win.locator('[data-testid="onboarding"]').count()) === 0
      )
      const text = (await win.locator('body').textContent()) ?? ''
      t.check('the new workspace is the one open', text.includes('First steps'))
    } finally {
      await app.close()
    }
  }
}
