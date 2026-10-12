import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { REPO, launchApp, seedWorkspaces, fixturePath, until } from './harness.mjs'

async function resizePanel(win, width) {
  const handle = win.locator('.cursor-col-resize').last()
  const box = await handle.boundingBox()
  assert.ok(box, 'the right panel has a resize handle')
  const rightEdge = await win.evaluate(() => window.innerWidth)
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(rightEdge - width, box.y + box.height / 2)
  await win.mouse.up()
  let actual = null
  assert.ok(
    await until(async () => {
      actual = await win
        .locator('[data-panel-bar="tabs"]')
        .evaluate(
          (el) => el.parentElement.parentElement.parentElement.getBoundingClientRect().width
        )
      return Math.abs(actual - width) < 2
    }),
    `the panel reaches ${width}px, got ${actual}; handle ${JSON.stringify(box)}, viewport ${rightEdge}`
  )
}

async function readTabs(win) {
  return win.locator('[data-panel-bar="tabs"]').evaluate((bar) => {
    const bounds = bar.getBoundingClientRect()
    return {
      overflow: bar.scrollWidth - bar.clientWidth,
      tabs: [...bar.querySelectorAll('button')].map((button) => {
        const label = button.querySelector('span')
        const rect = button.getBoundingClientRect()
        return {
          name: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          labelVisible: label && getComputedStyle(label).display !== 'none',
          iconVisible: button.querySelector('svg').getBoundingClientRect().width > 0,
          inside: rect.left >= bounds.left && rect.right <= bounds.right + 1
        }
      })
    }
  })
}

export async function run(t) {
  // Bundle the source-distributed fixture framework for the Node E2E runner.
  const modulePath = fixturePath('responsive-tabs-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/side-panel-tabs.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadSidePanelTabs } = await import(pathToFileURL(modulePath).href)
  const report = await loadSidePanelTabs(async ({ runId, id }) => {
    const root = fixturePath(`responsive-tabs-${runId}`)
    const dataDir = path.join(root, 'install')
    mkdirSync(root, { recursive: true })
    seedWorkspaces(dataDir, {
      workspaces: [{ id, name: 'Responsive tabs', rootDir: root, profileFile: null, createdAt: 1 }],
      activeWorkspaceId: id,
      fresh: true
    })
    return launchApp(dataDir)
  })
  console.log(
    JSON.stringify({ scenario: 'side-panel/responsive-tabs', runId: report.runId, ids: report.ids })
  )
  const { app, win } = report.values.workspace
  const errors = []
  win.on('pageerror', (error) => errors.push(error.message))
  try {
    await win.locator('button[title^="File tree"]').click()
    await win.locator('[data-plugin-tab="pull-request"]').waitFor()
    assert.ok(
      await until(() =>
        win
          .locator('[data-panel-bar="tabs"]')
          .evaluate(
            (el) =>
              Math.abs(
                el.parentElement.parentElement.parentElement.getBoundingClientRect().width - 240
              ) < 1
          )
      ),
      'the panel finishes opening before its resize handle is used'
    )
    await resizePanel(win, 400)
    const wide = await readTabs(win)
    assert.equal(wide.tabs.length, 3)
    assert.ok(wide.tabs.every((tab) => tab.labelVisible))
    t.check('wide panels show all three labels', true)

    await resizePanel(win, 180)
    const narrow = await readTabs(win)
    assert.ok(
      narrow.tabs.every((tab) => !tab.labelVisible),
      JSON.stringify(narrow)
    )
    assert.ok(narrow.tabs.every((tab) => tab.iconVisible && tab.inside && tab.title))
    assert.deepEqual(
      narrow.tabs.map((tab) => tab.name),
      ['Files', 'Git', 'GitHub']
    )
    assert.equal(narrow.overflow, 0)
    t.check('narrow panels show accessible icons without scrolling', true)

    for (const name of ['Git', 'GitHub', 'Files']) {
      const button = win
        .locator('[data-panel-bar="tabs"]')
        .getByRole('button', { name, exact: true })
      await button.focus()
      await win.keyboard.press('Enter')
      assert.equal(await button.getAttribute('data-selected'), 'true')
    }
    t.check('each icon tab can be selected with the keyboard', true)

    await resizePanel(win, 400)
    const restored = await readTabs(win)
    assert.ok(restored.tabs.every((tab) => tab.labelVisible && tab.inside))
    assert.equal(restored.overflow, 0)
    t.check('widening the panel restores labels', true)

    await resizePanel(win, 180)
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.github'))
    await win.locator('[data-plugin-tab="pull-request"]').waitFor({ state: 'detached' })
    const fewer = await readTabs(win)
    assert.equal(fewer.tabs.length, 2)
    assert.ok(fewer.tabs.every((tab) => tab.labelVisible && tab.inside))
    t.check('labels return when removing a plugin makes them fit', true)
    assert.ok(!errors.some((error) => error.includes('ResizeObserver loop')), errors.join('\n'))
    t.check('resizing does not cause observer loops', true)
  } finally {
    await app.close()
  }
}
