/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Compare the original stylesheet cascade with extracted skin tokens in real Electron.
// Images stay in memory; no screenshot files are retained.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchApp } from '../e2e/harness.mjs'
const dir = mkdtempSync(`${tmpdir()}/clave-skins-parity-`)
let app
try {
  const launched = await launchApp(dir)
  app = launched.app
  const win = launched.win
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
  await win.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }'
  })
  for (const id of ['dark', 'light', 'coffee', 'charcoal']) {
    await win.evaluate(async (id) => {
      await window.electronAPI.skinsActivate(id)
    }, id)
    await win.waitForTimeout(200)
    const styles = await win.evaluate((id) => {
      const root = document.documentElement
      const saved = root.getAttribute('style')
      root.removeAttribute('style')
      root.dataset.theme = id
      return saved
    }, id)
    await win.evaluate(() => document.fonts.ready)
    const editorBefore = await win.evaluate(() => {
      const styles = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        Array.from(styles)
          .filter((key) => key.startsWith('--cm-'))
          .map((key) => [key, styles.getPropertyValue(key).trim()])
      )
    })
    const before = await win.screenshot()
    await win.evaluate(
      ({ styles, id, mutate }) => {
        document.documentElement.setAttribute('style', styles || '')
        document.documentElement.dataset.theme = ['coffee', 'light'].includes(id) ? 'light' : 'dark'
        if (mutate) document.documentElement.style.setProperty('--surface-50', 'red')
      },
      { styles, id, mutate: !!process.env.CLAVE_SKIN_PARITY_MUTATE }
    )
    const editorAfter = await win.evaluate(() => {
      const styles = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        Array.from(styles)
          .filter((key) => key.startsWith('--cm-'))
          .map((key) => [key, styles.getPropertyValue(key).trim()])
      )
    })
    assert.deepEqual(
      editorAfter,
      editorBefore,
      `${id}: editor tokens retain their original palette`
    )
    const after = await win.screenshot()
    const ratio = await app.evaluate(
      ({ nativeImage }, { before, after }) => {
        const a = nativeImage.createFromBuffer(Buffer.from(before, 'base64')).toBitmap()
        const b = nativeImage.createFromBuffer(Buffer.from(after, 'base64')).toBitmap()
        if (a.length !== b.length) return 1
        let changed = 0
        for (let i = 0; i < a.length; i += 4)
          if ([0, 1, 2, 3].some((c) => Math.abs(a[i + c] - b[i + c]) > 16)) changed++
        return changed / (a.length / 4)
      },
      { before: before.toString('base64'), after: after.toString('base64') }
    )
    assert(ratio <= 0.001, `${id}: ${ratio * 100}% differs (limit 0.1%)`)
    console.log(`PASS ${id}: ${ratio * 100}% changed pixels`)
  }
} finally {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
}
