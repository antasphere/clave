// The resize line of each side panel sits exactly in the middle of the gap
// between the panel's content and the content column: the same air on both
// sides of it, to the pixel, for the left sidebar and the right side panel
// alike, and the line itself is 1px wide at rest and on hover.
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, rmSync } from 'node:fs'

const DIR = userDataDir('sidebar-gutters')
const ROOT = fixturePath('sidebar-gutters-root')

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'g', name: 'G', rootDir: ROOT, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'g',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    await win.locator('.launcher-panel').waitFor()
    await win.click('button[title^="File tree"]')
    await win.locator('[data-panel-bar="path"]').waitFor()
    await win.waitForTimeout(600) // the panel's open animation
    const m = await win.evaluate(() => {
      const r = (el) => el.getBoundingClientRect()
      const lines = [...document.querySelectorAll('.cursor-col-resize > div')]
      const [leftLine, rightLine] = [lines[0], lines[lines.length - 1]].map(r)
      const frame = r(document.querySelector('.frame'))
      return {
        left: {
          inside: leftLine.left - r(document.querySelector('.launcher-panel')).right,
          outside: frame.left - leftLine.right,
          line: leftLine.width
        },
        right: {
          outside: rightLine.left - frame.right,
          inside: r(document.querySelector('[data-panel-bar="path"]')).left - rightLine.right,
          line: rightLine.width
        }
      }
    })
    t.check(
      'left: the same air on both sides of the sidebar line',
      Math.abs(m.left.inside - m.left.outside) < 0.01,
      m.left
    )
    t.check(
      'right: the same air on both sides of the side panel line',
      Math.abs(m.right.inside - m.right.outside) < 0.01,
      m.right
    )
    t.check('both lines are 1px wide', m.left.line === 1 && m.right.line === 1, m)

    await win.locator('.cursor-col-resize').first().hover()
    await win.waitForTimeout(250)
    const hovered = await win.evaluate(
      () => document.querySelector('.cursor-col-resize > div').getBoundingClientRect().width
    )
    t.equal('and still 1px under the pointer', hovered, 1)
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
