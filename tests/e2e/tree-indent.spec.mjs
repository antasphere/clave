// Appearance → Trees → Indent sets how far each folder level steps in, in the
// Files tab, the git panel's repository tree and the files inside a repo, all
// at once and live; and the git tree's folder and repo rows are the height of
// the Files tab's rows, so the same folders are spaced alike in both tabs.
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

const DIR = userDataDir('tree-indent')
const ROOT = fixturePath('tree-indent-root', { real: true })
const WS = {
  id: 'ffffffff-0000-4000-8000-0000000000e1',
  name: 'Indent',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const REPOS = ['labs/products/beta-core', 'labs/services/scheduler']

function seedRepos() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const rel of REPOS) {
    const dir = path.join(ROOT, rel)
    mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true })
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'README.md'), '# r\n')
    git('add', '-A')
    git('-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
    // Changes two levels down, so the repo's own file tree has depth.
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\n')
    writeFileSync(path.join(dir, 'src', 'deep', 'b.ts'), 'b\n')
  }
}

const clickBy = (win, sel, pred) =>
  win.evaluate(
    ({ sel, pred }) => {
      const el = [...document.querySelectorAll(sel)].find((e) =>
        new Function('e', `return ${pred}`)(e)
      )
      el?.click()
      return !!el
    },
    { sel, pred }
  )

/** The step between two depths of each tree, and the rows' heights. */
const measure = (win) =>
  win.evaluate(() => {
    const pad = (el) => parseFloat(getComputedStyle(el).paddingLeft)
    const step = (els, depthOf) => {
      const byDepth = new Map()
      for (const el of els) if (!byDepth.has(depthOf(el))) byDepth.set(depthOf(el), pad(el))
      return byDepth.has(0) && byDepth.has(1) ? byDepth.get(1) - byDepth.get(0) : null
    }
    const files = [...document.querySelectorAll('[data-tree-item]')]
    const gitTree = [...document.querySelectorAll('[data-tree-row]')]
    const gitFiles = [...document.querySelectorAll('[data-git-row="dir"]')]
    return {
      files: step(files, (e) => Number(e.getAttribute('data-tree-depth'))),
      gitTree: step(gitTree, (e) => Number(e.getAttribute('data-tree-row'))),
      gitFiles: (() => {
        const p = gitFiles.map(pad).sort((a, b) => a - b)
        return p.length >= 2 ? p[1] - p[0] : null
      })(),
      fileRowH: files[0]?.getBoundingClientRect().height ?? null,
      gitRowH: [...new Set(gitTree.map((e) => e.getBoundingClientRect().height))]
    }
  })

export async function run(t) {
  seedRepos()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, { server: 'in-process' })
  try {
    await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'panel' })
    await win.waitForTimeout(1500)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1000)
    await stubFolderDialog(app, { returns: ROOT })
    await win.click('[data-panel-bar="path"] [data-panel-scope]')
    await win.waitForTimeout(400)
    await win.click('[data-scope-option="folder"]')
    await win.waitForTimeout(3000)

    // Files tab: open labs, so depth 0 and 1 are both drawn.
    // The two tabs share which folders are open: click a folder only if shut.
    await clickBy(
      win,
      '[data-tree-item]',
      "e.getAttribute('data-tree-name') === 'labs' && e.getAttribute('data-tree-expanded') === 'false'"
    )
    await until(async () => ((await measure(win)).files !== null ? true : null))
    const filesAt12 = (await measure(win)).files

    // Git tab: open labs, then a repo, then its src folder.
    await clickBy(win, '.panel-tab', "e.textContent.trim() === 'Git'")
    await until(async () =>
      (await win.locator('[data-tree-row][data-tree-name="labs"]').count()) ? true : null
    )
    await clickBy(
      win,
      '[data-tree-row]',
      "e.getAttribute('data-tree-name') === 'labs' && e.getAttribute('data-tree-collapsed') === 'true'"
    )
    await win.waitForTimeout(800)
    await clickBy(
      win,
      '[data-tree-row]',
      "e.getAttribute('data-tree-name') === 'products' && e.getAttribute('data-tree-collapsed') === 'true'"
    )
    await win.waitForTimeout(800)
    await clickBy(
      win,
      '[data-tree-row][data-tree-kind="repo"]',
      "e.getAttribute('data-tree-collapsed') === 'true'"
    )
    await win.waitForTimeout(1200)
    if (await win.locator('[data-panel-bar="git"] [aria-label="Tree view"]').count())
      await win.click('[data-panel-bar="git"] [aria-label="Tree view"]')
    await until(async () =>
      (await win.locator('[data-git-row="dir"]').count()) >= 2 ? true : null
    )
    const at12 = await measure(win)
    t.equal('Normal: the Files tab steps 12px a level', filesAt12, 12)
    t.equal('Normal: the git tree steps 12px a level', at12.gitTree, 12)
    t.equal("Normal: a repo's own files step 12px a level too", at12.gitFiles, 12)
    t.check(
      "the git tree's folder and repo rows are the Files tab's row height",
      at12.gitRowH.length === 1 && at12.gitRowH[0] === 28,
      at12.gitRowH
    )

    // Settings → Appearance → Trees → Indent: 20px.
    await win.evaluate(() =>
      document.querySelector('.sidebar-footer-btn[aria-label="Settings"]')?.click()
    )
    await win.waitForTimeout(600)
    await clickBy(win, 'button', "e.textContent.trim() === 'Appearance'")
    await win.locator('[data-tree-indent="wide"]').click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await win.waitForTimeout(800)
    const at20 = await measure(win)
    t.equal('20px: the git tree steps 20px a level', at20.gitTree, 20)
    t.equal("20px: a repo's own files step 20px", at20.gitFiles, 20)
    await clickBy(win, '.panel-tab', "e.textContent.trim() === 'Files'")
    await win.waitForTimeout(800)
    t.equal('20px: the Files tab steps 20px', (await measure(win)).files, 20)
    t.equal(
      'the choice is kept',
      await win.evaluate(() => localStorage.getItem('clave-tree-indent')),
      'wide'
    )

    // Density and Text size reach the trees.
    const look = () =>
      win.evaluate(() => {
        const row = document.querySelector('[data-tree-item]')
        const label = row?.querySelector('.text-xs')
        return {
          rowH: row?.getBoundingClientRect().height ?? null,
          font: label ? parseFloat(getComputedStyle(label).fontSize) : null
        }
      })
    const before = await look()
    t.check(
      'Comfortable, default text: 28px rows, 12px labels',
      before.rowH === 28 && before.font === 12,
      before
    )
    await win.evaluate(() =>
      document.querySelector('.sidebar-footer-btn[aria-label="Settings"]')?.click()
    )
    await win.waitForTimeout(600)
    await clickBy(win, 'button', "e.textContent.trim() === 'Appearance'")
    await win.locator('[data-testid="density-slider"]').fill('4')
    await win.locator('[data-text-size="largest"]').click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await win.waitForTimeout(800)
    const after = await look()
    t.check(
      'Spacious, largest text: the tree rows grow to 30px and their labels to 14px',
      after.rowH === 30 && after.font === 14,
      after
    )
    await clickBy(win, '.panel-tab', "e.textContent.trim() === 'Git'")
    await win.waitForTimeout(800)
    const gitH = (await measure(win)).gitRowH
    t.check('the git tree follows too', gitH.length === 1 && gitH[0] === 30, gitH)
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
