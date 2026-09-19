import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  launchApp,
  callMcp,
  seedWorkspaces,
  seedTrustedRoots,
  stubFolderDialog
} from './harness.mjs'
export async function run(t) {
  const dir = mkdtempSync(`${tmpdir()}/clave-e2e-skins-`)
  const fixture = `${dir}/fixture`
  const source = `${dir}/accent-skin`
  mkdirSync(fixture)
  mkdirSync(source)
  seedWorkspaces(dir, {
    workspaces: [{ id: 'skins', name: 'Skins', rootDir: fixture, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'skins'
  })
  seedTrustedRoots(dir, [fixture])
  writeFileSync(
    `${source}/clave-plugin.json`,
    JSON.stringify({
      kind: 'skin',
      id: 'test-accent',
      name: 'Test accent',
      version: '1.0.0',
      engines: { clave: '>=1.90.2' },
      skin: { tokens: 'skin.json', base: 'dark' }
    })
  )
  writeFileSync(`${source}/skin.json`, JSON.stringify({ '--color-accent': '#123abc' }))
  let app
  try {
    const launched = await launchApp(dir)
    app = launched.app
    const win = launched.win
    const opened = await callMcp(app, 'openSession', {
      cwd: fixture,
      mode: 'terminal',
      name: 'Skin terminal'
    })
    assert(opened.sessionId, 'A live terminal was opened')
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.getByText('Appearance', { exact: true }).click()
    await stubFolderDialog(app, { returns: source })
    await win.getByRole('button', { name: 'Import skin', exact: true }).click()
    await win.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() ===
        '#123abc'
    )
    t.check('folder import applies accent to root', true)
    writeFileSync(
      `${dir}/skins/test-accent/skin.json`,
      JSON.stringify({ '--color-accent': '#abc123' })
    )
    await win.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() ===
        '#abc123'
    )
    t.check('editing the installed skin hot-applies its tokens', true)
    await win.reload()
    await win.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() ===
        '#abc123'
    )
    t.check('the active skin survives renderer reload', true)
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.getByText('Appearance', { exact: true }).click()

    await win.getByRole('button', { name: 'Remove Test accent' }).click()
    await win.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() !==
        '#abc123'
    )
    t.check('removing the active skin reverts its tokens', true)
    writeFileSync(`${source}/skin.json`, JSON.stringify({ '--unknown': 'red' }))
    await win.getByRole('button', { name: 'Import skin', exact: true }).click()
    await win.getByRole('alert').waitFor()
    assert.match(await win.getByRole('alert').innerText(), /Unknown skin token/)
    t.check('invalid import displays a validation error', true)
    const state = await win.evaluate(() => window.electronAPI.skinsList())
    assert(!state.skins.some((s) => s.id === 'test-accent'))
    t.check('invalid import does not install a skin', true)
  } finally {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
