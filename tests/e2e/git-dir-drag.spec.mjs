// A folder row of the Git tab's repository tree drags its path into a session,
// as a repository row always has: the row is draggable, its drag carries the
// folder's absolute path as text/plain (the form every drop target reads), a
// compacted chain ("deep/one/two") carries its deepest folder, and dropping it
// on a terminal session types the path there.
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  stubFolderDialog,
  fixturePath,
  until
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('git-dir-drag')
const ROOT = fixturePath('git-dir-drag-root', { real: true })
const WS = {
  id: 'ffffffff-0000-4000-8000-0000000000d1',
  name: 'Drag',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const REPOS = ['labs/products/beta-core', 'labs/services/scheduler', 'deep/one/two/solo-repo']

function seedRepos() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const rel of REPOS) {
    const dir = path.join(ROOT, rel)
    mkdirSync(dir, { recursive: true })
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(rel)}\n`)
    git('add', '-A')
    git('-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
  }
}

/** Start a drag on a git-tab folder row, as the browser would, and read what
 *  the drag carries. */
function dragFrom(win, name) {
  return win.evaluate((n) => {
    const row = [...document.querySelectorAll('[data-tree-row][data-tree-kind="dir"]')].find(
      (r) => r.getAttribute('data-tree-name') === n
    )
    if (!row) return null
    const dt = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    return { draggable: row.draggable, text: dt.getData('text/plain'), effect: dt.effectAllowed }
  }, name)
}

export async function run(t) {
  seedRepos()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    const { sessionId } = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'terminal',
      name: 'drop-here'
    })
    await win.waitForTimeout(2000)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)
    await stubFolderDialog(app, { returns: ROOT })
    await win.click('[data-panel-bar="path"] [data-panel-scope]')
    await win.waitForTimeout(400)
    await win.click('[data-scope-option="folder"]')
    await win.waitForTimeout(3000)
    await win.evaluate(() =>
      [...document.querySelectorAll('.panel-tab')]
        .find((b) => b.textContent.trim() === 'Git')
        ?.click()
    )
    await until(async () =>
      (await win.locator('[data-tree-row][data-tree-kind="dir"][data-tree-name="labs"]').count())
        ? true
        : null
    )

    const labs = await dragFrom(win, 'labs')
    t.check('a folder row is draggable', labs?.draggable === true, labs)
    t.equal("its drag carries the folder's absolute path", labs?.text, path.join(ROOT, 'labs'))

    const chain = await dragFrom(win, 'deep/one/two')
    t.equal(
      'a compacted chain carries its deepest folder',
      chain?.text,
      path.join(ROOT, 'deep/one/two')
    )

    // The drop: onto the terminal session, which types the path.
    const typed = path.join(ROOT, 'labs')
    await win.evaluate(
      ({ id, p }) => {
        const pane = document.querySelector(`[data-session-id="${id}"] .xterm`)?.parentElement
        const target = pane ?? document.querySelector('.xterm')?.parentElement
        const dt = new DataTransfer()
        dt.setData('text/plain', p)
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
        )
      },
      { id: sessionId, p: typed }
    )
    const landed = await until(async () => {
      const text = await win.evaluate(() =>
        [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.replace(/\s+$/, '')).join('')
      )
      return text.includes(typed) ? true : null
    })
    t.check(
      'dropped on a terminal session, the path is typed there',
      !!landed,
      await win.evaluate(() =>
        [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.trim()).filter(Boolean).slice(-4)
      )
    )
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
