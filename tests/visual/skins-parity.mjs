// Compare the original stylesheet cascade with extracted skin tokens in real Electron.
// Images stay in memory; no screenshot files are retained.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchApp, callMcp, seedWorkspaces, seedTrustedRoots } from '../e2e/harness.mjs'
const dir = mkdtempSync(`${tmpdir()}/clave-skins-parity-`)
const legacy = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-xterm.json', import.meta.url), 'utf8')
)
seedWorkspaces(dir, {
  workspaces: [
    { id: 'skin-parity', name: 'Skin parity', rootDir: dir, profileFile: null, createdAt: 1 }
  ],
  activeWorkspaceId: 'skin-parity'
})
seedTrustedRoots(dir, [dir])
let app
let terminalId
try {
  const launched = await launchApp(dir)
  app = launched.app
  const win = launched.win
  const terminal = await callMcp(app, 'openSession', {
    cwd: dir,
    mode: 'terminal',
    name: 'Palette parity'
  })
  terminalId = terminal.sessionId
  await win.waitForFunction((id) => !!window.__claveTerminalTheme?.(id), terminal.sessionId)
  await win.evaluate(
    (id) =>
      window.electronAPI.writeSession(
        id,
        "printf '\\033[2J\\033[HSkin palette parity\\n\\033[31mRed \\033[32mGreen \\033[34mBlue\\033[0m\\n'; exec sleep 600\r"
      ),
    terminal.sessionId
  )
  await win.waitForTimeout(1500)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
  await win.addStyleTag({
    content:
      '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }'
  })
  for (const id of ['dark', 'light', 'coffee', 'charcoal']) {
    await win.evaluate(async (id) => {
      await window.electronAPI.skinsActivate(id)
    }, id)
    await win.waitForTimeout(700)
    const terminalTheme = await win.evaluate(
      (id) => window.__claveTerminalTheme?.(id),
      terminal.sessionId
    )
    assert.deepEqual(
      terminalTheme,
      Object.fromEntries(
        Object.entries(legacy[id]).map(([key, value]) => [key, value ?? undefined])
      ),
      `${id}: live terminal matches the original palette`
    )
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
  try {
    if (app && terminalId) {
      const win = await app.firstWindow()
      await win.evaluate((id) => window.electronAPI.killSession(id), terminalId)
    }
  } finally {
    try {
      await app?.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
