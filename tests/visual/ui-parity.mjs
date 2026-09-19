/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Run baseline before extraction, then compare after building. PNGs live only
// in the OS temp directory and are removed after comparison, even on failure.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchApp, seedWorkspaces, seedTrustedRoots, callMcp } from '../e2e/harness.mjs'
const mode = process.argv[2]
const baseline = process.argv[3] ? path.resolve(process.argv[3]) : null
assert(
  ['baseline', 'compare'].includes(mode) && baseline,
  'usage: ui-parity.mjs baseline|compare <temporary-directory>'
)
assert(
  [path.resolve(tmpdir()), '/tmp'].some((root) => baseline.startsWith(root + path.sep)),
  'Screenshots must live in a dedicated OS temporary directory, outside the project'
)
const dir = mkdtempSync(`${tmpdir()}/clave-ui-parity-`)
const root = `${dir}/fixture`
mkdirSync(root)
execFileSync('git', ['init', '-q', root])
writeFileSync(`${root}/example.txt`, 'A visual fixture\n')
seedWorkspaces(dir, {
  workspaces: [
    { id: 'ui-parity', name: 'UI parity', rootDir: root, profileFile: null, createdAt: 1 }
  ],
  activeWorkspaceId: 'ui-parity'
})
seedTrustedRoots(dir, [root])
mkdirSync(baseline, { recursive: true })
let app
let complete = false
try {
  const launched = await launchApp(dir)
  app = launched.app
  const win = launched.win
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1200, 800)
    ipcMain.removeHandler('usage:get-limits')
    ipcMain.handle('usage:get-limits', () => ({ windows: [], fetchedAt: 1 }))
  })
  await win.addInitScript(() => {
    let seed = 42
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
  })
  await win.evaluate(() => {
    localStorage.setItem('clave-theme', 'dark')
    localStorage.setItem(
      'clave-user-profile',
      JSON.stringify({ name: 'Ada', avatarIcon: 'rocket', avatarField: 'iris', avatarSeed: 42 })
    )
  })
  await win.reload()
  await win.waitForSelector('.launcher-panel')
  await callMcp(app, 'createGroup', { name: 'Design system', cwd: root })
  async function capture(name, selector) {
    await win.mouse.move(1190, 790)
    await win.evaluate(() => document.fonts.ready)
    await win.waitForTimeout(500)
    const target = win.locator(selector).first()
    assert(await target.isVisible(), `${name} must be visible`)
    const png = await target.screenshot({ animations: 'disabled' })
    const file = `${baseline}/${name}.png`
    if (mode === 'baseline') writeFileSync(file, png)
    else {
      const old = readFileSync(file)
      // Decode with Electron's native image API, avoiding a second PNG library.
      const result = await app.evaluate(
        ({ nativeImage }, { before, after }) => {
          const a = nativeImage.createFromBuffer(Buffer.from(before, 'base64'))
          const b = nativeImage.createFromBuffer(Buffer.from(after, 'base64'))
          const aa = a.toBitmap(),
            bb = b.toBitmap()
          let changed = 0
          for (let i = 0; i < aa.length; i += 4) {
            if ([0, 1, 2, 3].some((c) => Math.abs(aa[i + c] - bb[i + c]) > 16)) changed++
          }
          return { a: a.getSize(), b: b.getSize(), ratio: changed / (aa.length / 4) }
        },
        { before: old.toString('base64'), after: png.toString('base64') }
      )
      rmSync(file)
      assert.deepEqual(result.a, result.b, `${name} dimensions`)
      assert(
        result.ratio <= 0.001,
        `${name}: ${(result.ratio * 100).toFixed(4)}% differs (limit 0.1%)`
      )
      console.log(`PASS ${name}: ${(result.ratio * 100).toFixed(4)}%`)
    }
  }
  if (process.env.CLAVE_UI_PARITY_MUTATE) {
    await win.addStyleTag({
      content: '.sidebar-item, .launcher-panel { background: var(--color-accent) !important; }'
    })
  }
  await capture('sidebar-group', 'div.flex.flex-col.h-full.bg-surface-50')
  await capture('launcher', '.launcher-panel')
  await win.locator('.launcher-caret').click()
  await capture('menu', '[role="menu"]')
  await win.keyboard.press('Escape')
  await callMcp(app, 'openSession', { cwd: root, mode: 'terminal', name: 'Fixture' })
  await win.click('button[title^="File tree"]')
  await win.click('.panel-tab:has-text("Git")')
  await win.waitForTimeout(2000)
  await capture('git-panel', 'div.flex.flex-col.h-full.bg-surface-50:has([data-panel-bar="git"])')
  await win.click('.sidebar-footer-btn[aria-label="Settings"]')
  await win.getByText('Appearance', { exact: true }).click()
  for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
    await win
      .locator(`.theme-swatch`)
      .filter({ hasText: new RegExp(`^${theme}$`, 'i') })
      .click()
    await capture(`appearance-${theme}`, '.settings-scroller')
  }
  complete = true
} finally {
  try {
    await app?.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (mode === 'compare' || !complete) rmSync(baseline, { recursive: true, force: true })
  }
}
