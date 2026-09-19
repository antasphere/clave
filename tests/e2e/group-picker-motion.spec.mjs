import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchApp, seedWorkspaces } from './harness.mjs'

export async function run(t) {
  const dir = mkdtempSync(`${tmpdir()}/clave-group-picker-motion-`)
  seedWorkspaces(dir, {
    workspaces: [{ id: 'motion', name: 'Motion', rootDir: dir, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'motion'
  })
  let app
  try {
    const launched = await launchApp(dir)
    app = launched.app
    const win = launched.win
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.getByRole('button', { name: 'Add a group', exact: true }).click()
    for (const selector of ['.group-picker-backdrop', '.group-picker-panel']) {
      const element = win.locator(selector)
      await element.waitFor({ state: 'visible' })
      t.equal(
        `${selector} has no animation with reduced motion`,
        await element.evaluate((node) => getComputedStyle(node).animationName),
        'none'
      )
    }
  } finally {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
