/**
 * The side panel's two tabs share one set of open folders, and both start shut.
 *
 * Two complaints, one mechanism (src/renderer/src/lib/panel-expansion.ts, and
 * `panelExpandedDirs` in the session store):
 *
 * 1. The trees were not linked. You browsed the git tab down to a folder,
 *    switched to Files to open something in it, and landed back at the root
 *    with the whole path to walk again. They draw the same folders; which ones
 *    are open is a property of the PANEL, not of the tab you happened to open
 *    them in. Asserted in BOTH directions, because a one-way reveal would pass
 *    half of this spec and still leave the other switch walking the path.
 *
 * 2. The git tab opened fully unrolled. Its set was of FOLDED folders and a
 *    fresh one is empty, so every directory came up open and Collapse All was
 *    the first click of every visit; repo rows opened themselves too, on
 *    "has changes or is behind", which in a real workspace is most of them.
 *    Both now start shut.
 *
 * The two claims pull in opposite directions — one says state must CROSS the
 * tabs, the other says there must be NO state at the start — so a fixture that
 * only ever opens folders would let a bug in either look like the other. Every
 * check below therefore names which tab it is looking at and what was opened
 * before it looked.
 *
 * Fixture: a folder that is NOT itself a repo, holding repos at several depths,
 * some under plain folders that branch (so the git tree draws real directory
 * rows rather than one compacted chain), each repo dirty (so a repo row would
 * open itself under the old default). `/private/tmp` rather than `/tmp` so
 * git's resolved repo root matches the discovered path — the symlink otherwise
 * makes every repo look like it belongs to a parent.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  stubFolderDialog,
  fixturePath
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('panel-shared-expansion')
const ROOT = fixturePath('panel-shared-expansion-root', { real: true })
const WS = {
  id: 'ffffffff-0000-4000-8000-00000000000f',
  name: 'Shared',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

// Two shapes on purpose, because they exercise different code.
//
// `labs` BRANCHES (products and services), so the git tree draws real
// per-segment directory rows — that is what the reveal checks walk.
//
// `deep/one/two` does NOT branch, so compaction folds the whole chain into ONE
// git row labelled "deep/one/two" whose ancestors are pass-through folders the
// git tab never draws but the files tab does. Every path in a branching fixture
// is a single segment, where a row and its ancestors coincide; a fixture
// without this chain cannot tell a fold that clears the chain from one that
// leaves its ancestors behind.
const REPOS = [
  'labs/products/beta-core',
  'labs/products/gamma-web',
  'labs/services/scheduler',
  'deep/one/two/solo-repo'
]

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
    // Dirty on purpose: under the old default a repo with changes unfolded
    // itself, so a clean fixture could not tell the fix from the bug.
    writeFileSync(path.join(dir, 'work.txt'), 'dirty\n')
  }
}

/** The git tab's rows: directories and repo headers, in document order. */
function readGitTree(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-row]')].map((el) => ({
      kind: el.getAttribute('data-tree-kind'),
      name: el.getAttribute('data-tree-name'),
      depth: Number(el.getAttribute('data-tree-row')),
      collapsed: el.getAttribute('data-tree-collapsed') === 'true'
    }))
  )
}

/** The files tab's rows. Only directories carry `data-tree-expanded`. */
function readFileTree(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-item]')].map((el) => ({
      name: el.getAttribute('data-tree-name'),
      depth: Number(el.getAttribute('data-tree-depth')),
      dir: el.hasAttribute('data-tree-expanded'),
      expanded: el.getAttribute('data-tree-expanded') === 'true'
    }))
  )
}

/** Click a tab by its label. */
async function openTab(win, label) {
  await win.evaluate((l) => {
    const tab = [...document.querySelectorAll('.panel-tab')].find(
      (b) => b.textContent.trim() === l
    )
    tab?.click()
  }, label)
  await win.waitForTimeout(1500)
}

/** Click a git-tab DIRECTORY row by name. */
async function clickGitDir(win, name) {
  await win.evaluate((n) => {
    const row = [...document.querySelectorAll('[data-tree-row][data-tree-kind="dir"]')].find(
      (r) => r.getAttribute('data-tree-name') === n
    )
    row?.click()
  }, name)
  await win.waitForTimeout(1200)
}

/** Click a files-tab directory row by name, only if it is currently shut. */
async function openFileDir(win, name) {
  await win.evaluate((n) => {
    const row = [...document.querySelectorAll('[data-tree-item]')].find(
      (r) =>
        r.getAttribute('data-tree-name') === n && r.getAttribute('data-tree-expanded') === 'false'
    )
    row?.click()
  }, name)
  await win.waitForTimeout(1200)
}

export async function run(t) {
  seedRepos()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'panel' })
    await win.waitForTimeout(2000)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)

    // Point the panel at the fixture the way a user does — the folder picker in
    // the root chip's menu. Naming the folder explicitly is what guarantees
    // both trees are about THIS tree and not whatever the session happened to
    // resolve to; the same route the sibling spec uses to reach its big folder.
    await stubFolderDialog(app, { returns: ROOT })
    await win.click('[data-panel-bar="path"] [data-panel-scope]')
    await win.waitForTimeout(400)
    await win.click('[data-scope-option="folder"]')
    await win.waitForTimeout(4000)

    const landedOn = await win.evaluate(
      () => document.querySelector('[data-panel-bar="path"]')?.textContent?.trim() ?? ''
    )
    t.check('the panel is pointed at the fixture', landedOn.includes(ROOT), landedOn)

    // ── 2. The git tab opens shut ─────────────────────────────────────────
    await openTab(win, 'Git')
    const gitFirst = readGitTree
    const first = await gitFirst(win)
    const dirsFirst = first.filter((r) => r.kind === 'dir')
    const reposFirst = first.filter((r) => r.kind === 'repo')

    t.check('the git tab draws directory rows to judge', dirsFirst.length > 0, first)
    t.check(
      'every directory starts collapsed',
      dirsFirst.length > 0 && dirsFirst.every((d) => d.collapsed),
      dirsFirst
    )
    // A collapsed top level is the whole point: nothing below it is drawn, so
    // no repo row can be on screen yet even though every repo is dirty.
    t.equal('and nothing below them is drawn yet', reposFirst.length, 0)

    // Repo rows start shut too. They live two folders down, so open the way to
    // them first — a repo row that is not on screen renders nothing below it
    // and would read as "folded" no matter what its own state was.
    await clickGitDir(win, 'labs')
    const afterLabs = await readGitTree(win)
    t.check(
      'opening a folder reveals what is under it',
      afterLabs.length > first.length,
      afterLabs
    )
    await clickGitDir(win, 'products')
    const withRepos = await readGitTree(win)
    const repoRows = withRepos.filter((r) => r.kind === 'repo')
    t.check('the repo rows are on screen to judge', repoRows.length >= 2, withRepos)
    t.check(
      'and every one of them is folded, dirty though they all are',
      repoRows.length >= 2 && repoRows.every((r) => r.collapsed),
      repoRows
    )
    // Nothing from inside a repo is drawn while they are shut.
    t.equal(
      'no file list is unrolled',
      await win.evaluate(
        () => document.querySelectorAll('[data-git-file-rule], .git-section-header').length
      ),
      0
    )

    // ── 1a. Git → Files ───────────────────────────────────────────────────
    // The walk down to `labs/products` already happened above; switching tabs
    // is the only thing left to do. (Clicking `products` a second time here
    // would fold it, and the reveal below would then be asserting the
    // opposite of what it reads as.)
    const gitOpened = (await readGitTree(win)).filter((r) => r.kind === 'dir' && !r.collapsed)
    t.check(
      'two folders are open in the git tab',
      gitOpened.some((d) => d.name === 'labs') && gitOpened.some((d) => d.name === 'products'),
      gitOpened
    )

    await openTab(win, 'Files')
    const filesAfterGit = await readFileTree(win)
    const openIn = (rows, name) => rows.find((r) => r.name === name && r.dir)?.expanded === true
    t.check(
      'the folder walked in the git tab is open in the files tab',
      openIn(filesAfterGit, 'labs'),
      filesAfterGit.filter((r) => r.dir)
    )
    t.check(
      'and so is the one nested inside it',
      openIn(filesAfterGit, 'products'),
      filesAfterGit.filter((r) => r.dir)
    )
    // The reveal must be the PATH, not the whole tree: a sibling the git tab
    // never opened stays shut, or "linked" would just mean "expand everything".
    t.check(
      'a sibling folder nobody opened stays shut',
      filesAfterGit.find((r) => r.name === 'services')?.expanded !== true,
      filesAfterGit.filter((r) => r.dir)
    )

    // ── 1b. Files → Git ───────────────────────────────────────────────────
    // The other direction, which a one-way reveal would fail.
    await openFileDir(win, 'services')
    const filesOpened = await readFileTree(win)
    t.check(
      'a folder opened in the files tab',
      openIn(filesOpened, 'services'),
      filesOpened.filter((r) => r.dir)
    )

    await openTab(win, 'Git')
    const gitAfterFiles = await readGitTree(win)
    const gitDir = (name) => gitAfterFiles.find((r) => r.kind === 'dir' && r.name === name)
    t.check(
      'the folder opened in the files tab is open in the git tab',
      gitDir('services')?.collapsed === false,
      gitAfterFiles
    )
    t.check(
      'and the folders opened earlier are still open',
      gitDir('labs')?.collapsed === false && gitDir('products')?.collapsed === false,
      gitAfterFiles
    )

    // ── Collapse-all still empties both ───────────────────────────────────
    // One set behind two tabs means the button has one thing to clear, and a
    // tree that re-derived from a stale set would unfold again on next render.
    await win.click('[aria-label="Collapse all"]')
    await win.waitForTimeout(1200)
    const gitCollapsed = await readGitTree(win)
    t.check(
      'collapse-all shuts every folder in the git tab',
      gitCollapsed.filter((r) => r.kind === 'dir').every((d) => d.collapsed),
      gitCollapsed
    )

    await openTab(win, 'Files')
    const filesCollapsed = await readFileTree(win)
    t.check(
      'and the files tab is shut with it',
      filesCollapsed.filter((r) => r.dir).every((d) => !d.expanded),
      filesCollapsed.filter((r) => r.dir)
    )

    // ── A compacted row folds the whole chain it stands for ───────────────
    // `deep/one/two` is ONE git row for three folders. Expanding it opens all
    // three, or the files tab could not draw the path; folding it has to close
    // all three. A fold that took only the deepest segment left `deep` and
    // `deep/one` in the shared set with nothing able to clear them — no git row
    // is ever named `deep` — so the git row read shut while the files tab still
    // drew the path open. Both directions are checked, because the bug is
    // invisible from the git tab alone.
    await openTab(win, 'Git')
    await clickGitDir(win, 'deep/one/two')
    const chainOpen = await readGitTree(win)
    t.check(
      'the compacted row opens',
      chainOpen.find((r) => r.name === 'deep/one/two')?.collapsed === false,
      chainOpen
    )

    await openTab(win, 'Files')
    const filesChain = await readFileTree(win)
    const fileDir = (rows, name) => rows.find((r) => r.name === name && r.dir)
    t.check(
      'and every folder of the chain is open in the files tab',
      fileDir(filesChain, 'deep')?.expanded === true &&
        fileDir(filesChain, 'one')?.expanded === true,
      filesChain.filter((r) => r.dir)
    )

    await openTab(win, 'Git')
    await clickGitDir(win, 'deep/one/two')
    const chainShut = await readGitTree(win)
    t.check(
      'folding it shuts the row',
      chainShut.find((r) => r.name === 'deep/one/two')?.collapsed === true,
      chainShut
    )

    await openTab(win, 'Files')
    const filesChainShut = await readFileTree(win)
    t.check(
      'and the files tab agrees — no segment of the chain left open',
      fileDir(filesChainShut, 'deep')?.expanded !== true,
      filesChainShut.filter((r) => r.dir)
    )

    // ── The shared set survives closing and reopening the panel ───────────
    // The panel is really unmounted when it closes (AppShell renders it behind
    // `fileTreeOpen`), and `collapseAllTrigger` is a counter that never resets.
    // A mount-time collapse-all therefore fired on every reopen — harmless
    // while it cleared a cache private to the files tree, and destructive once
    // it clears the set both tabs read. One press earlier in this spec is
    // enough to arm it, so the toggle below is the whole reproduction.
    await openFileDir(win, 'labs')
    const beforeToggle = await readFileTree(win)
    t.check(
      'a folder is open before the panel is closed',
      fileDir(beforeToggle, 'labs')?.expanded === true,
      beforeToggle.filter((r) => r.dir)
    )

    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(800)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(2500)

    const afterToggle = await readFileTree(win)
    t.check(
      'and it is still open after closing and reopening the panel',
      fileDir(afterToggle, 'labs')?.expanded === true,
      afterToggle.filter((r) => r.dir)
    )

    // ── A double-click on a git folder is one gesture, and a fold forgets nothing
    // Reported 16 September 2026: with a path walked open, a double-click on
    // one of its folders "collapses the whole tree like Collapse All". Two
    // faults stacked: every click toggled, so the double-click folded the
    // folder and reopened it; and a fold cleared the subtree from the shared
    // set, so it reopened onto a branch folded flat. Each is checked on its
    // own — remove the click guard and the first check goes red, make fold
    // clear the subtree again and the second does.
    await openTab(win, 'Git')
    const gitRow = (name) => `[data-tree-row][data-tree-kind="dir"][data-tree-name="${name}"]`
    // `labs` is open from the Files step above; walk on to `products`.
    await clickGitDir(win, 'products')
    const walked = await readGitTree(win)
    const gitDirAt = (rows, name) => rows.find((r) => r.kind === 'dir' && r.name === name)
    t.check(
      'a path is walked open in the git tab',
      gitDirAt(walked, 'labs')?.collapsed === false &&
        gitDirAt(walked, 'products')?.collapsed === false,
      walked
    )

    // A real double-click: two mouse clicks, the second carrying detail=2.
    await win.dblclick(gitRow('labs'))
    await win.waitForTimeout(1200)
    const afterDbl = await readGitTree(win)
    t.check(
      'a double-click on an open folder folds it once — it does not reopen',
      gitDirAt(afterDbl, 'labs')?.collapsed === true,
      afterDbl
    )

    await clickGitDir(win, 'labs')
    const reopened = await readGitTree(win)
    t.check(
      'reopening the folder brings back the folder that was open beneath it',
      gitDirAt(reopened, 'labs')?.collapsed === false &&
        gitDirAt(reopened, 'products')?.collapsed === false,
      reopened
    )
    // A sibling nobody opened must not come along for the ride.
    t.check(
      'and a sibling nobody opened stays shut',
      gitDirAt(reopened, 'services')?.collapsed === true,
      reopened
    )

    await openTab(win, 'Files')
    const filesReopened = await readFileTree(win)
    t.check(
      'the files tab shows the same remembered path',
      fileDir(filesReopened, 'labs')?.expanded === true &&
        fileDir(filesReopened, 'products')?.expanded === true,
      filesReopened.filter((r) => r.dir)
    )
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
