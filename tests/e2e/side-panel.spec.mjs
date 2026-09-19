/**
 * The side panel's chrome and its repo tree's rules.
 *
 * Two things this covers, both of which were wrong before:
 *
 * 1. The rules in the git tab's repo tree. They used to be drawn at the FOOT of
 *    a block and only by a repo, so a folder full of repos came out ruled under
 *    every repo and under nothing else — a line under the last repo inside a
 *    folder, none between the folders themselves. Every row but the first
 *    carries one now, at that row's own depth — a folder and its first repo
 *    included, which was the last pairing left exempt and read as ruling that
 *    gives out halfway down.
 * 2. The chrome. The two tabs each had their own collapse-all and the file tab
 *    its own folder picker; those are shared now, and each tab's own controls
 *    sit in a bar of the same material. That bar must not wrap at the panel's
 *    default width — the whole point of the cluster.
 * 3. Where the shared controls live. The root chip (whose menu holds the folder
 *    picker) and collapse-all are on the PATH bar, beside the path they act on,
 *    not out on the tab bar; the tab bar carries the tabs and nothing else,
 *    centred; and the help button that used to sit in the panel's corner is
 *    gone (⌘? still opens the panel).
 * 4. The rules in the FILE tab's tree, drawn by the same sentence as the git
 *    tab's: above every row but the first, at that row's own depth, files and
 *    first children included.
 * 5. The two trees' horizontal geometry. The file tree used to run on an 8px
 *    gutter against the git tree's 12px, so beside it the same names read as a
 *    denser, smaller list. One gutter and one indent in both — and no vertical
 *    indent guides in either, in the markup or in the palette.
 *
 * The fixture is a folder that is NOT itself a repo holding repos at several
 * depths, some directly, some under plain folders. That mixture is the case the
 * old rules got wrong, and `/private/tmp` rather than `/tmp` so git's resolved
 * repo root matches the discovered path (the symlink otherwise makes every repo
 * look like it belongs to a parent).
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  stubFolderDialog
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('side-panel')
const ROOT = '/private/tmp/clave-e2e-side-panel-root'
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Panel',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

// alpha-app sits at the top level; the rest are behind plain folders, one of
// them two levels down. Two repos share `labs/products` so the tree has a
// same-depth boundary as well as the shallower ones.
const REPOS = [
  'alpha-app',
  'company/website',
  'labs/products/beta-core',
  'labs/products/gamma-web',
  'labs/services/scheduler'
]

// A second folder, over the DEFAULT live-poll limit (50), for the footnote.
// Bare inits: the note is about how many repos there are, not what is in them.
// Bare remotes for the one repo that must sit BEHIND its upstream — outside
// ROOT so the panel does not discover them as repos of their own.
const ORIGINS = '/private/tmp/clave-e2e-side-panel-origins'
const BEHIND_REPO = 'alpha-app'

const BIG_ROOT = '/private/tmp/clave-e2e-side-panel-big'
const BIG_COUNT = 51

function seedBigRoot() {
  rmSync(BIG_ROOT, { recursive: true, force: true })
  for (let i = 0; i < BIG_COUNT; i++) {
    const dir = path.join(BIG_ROOT, `repo-${String(i).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { stdio: 'ignore' })
    writeFileSync(path.join(dir, 'work.txt'), 'x\n')
  }
}

function seedRepos() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const rel of REPOS) {
    const dir = path.join(ROOT, rel)
    mkdirSync(dir, { recursive: true })
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(rel)}\n`)
    // Two files a directory deep, so the git tab's TREE mode has a folder row
    // to render — compaction folds a lone child into its parent's path.
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'src', 'one.txt'), 'one\n')
    writeFileSync(path.join(dir, 'src', 'two.txt'), 'two\n')
    git('add', '-A')
    git('-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
    // One untracked file, so every repo has something to unfold — and one
    // MODIFIED tracked file, which is the row whose tone the tab is judged on.
    writeFileSync(path.join(dir, 'work.txt'), 'dirty\n')
    writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(rel)}\n\nedited\n`)
    writeFileSync(path.join(dir, 'src', 'one.txt'), 'one edited\n')
    writeFileSync(path.join(dir, 'src', 'two.txt'), 'two edited\n')
  }
  seedBehindUpstream()
}

/**
 * One repo left BEHIND a real upstream, so the panel actually renders an
 * incoming (↓) badge. Without it the tone check on those badges asserts over an
 * empty list and passes whatever color they are painted.
 */
function seedBehindUpstream() {
  rmSync(ORIGINS, { recursive: true, force: true })
  mkdirSync(ORIGINS, { recursive: true })
  const bare = path.join(ORIGINS, 'alpha.git')
  const work = path.join(ORIGINS, 'alpha-push')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' })

  const repo = path.join(ROOT, BEHIND_REPO)
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  git(repo, 'remote', 'add', 'origin', bare)
  git(repo, 'push', '-q', '-u', 'origin', 'main')

  // A second clone moves the branch on, then the repo fetches without merging.
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' })
  writeFileSync(path.join(work, 'ahead.txt'), 'from the remote\n')
  git(work, 'add', '-A')
  git(work, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'remote work')
  git(work, 'push', '-q')
  git(repo, 'fetch', '-q')
}

/**
 * The FILE tree's rows and rules in document order. Its rows carry
 * `data-tree-item` and its rules `data-file-tree-rule`, both distinct from the
 * git tree's attributes on purpose: the file tree stays MOUNTED behind the git
 * tab so folder state survives a tab switch, and a shared attribute would have
 * it answering the git tree's queries from off screen.
 */
function readFileTree(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-item], [data-file-tree-rule]')].map((el) =>
      el.hasAttribute('data-file-tree-rule')
        ? { kind: 'rule', depth: Number(el.getAttribute('data-file-tree-rule')) }
        : {
            kind: 'row',
            depth: Number(el.getAttribute('data-tree-depth')),
            dir: el.hasAttribute('data-tree-expanded'),
            expanded: el.getAttribute('data-tree-expanded') === 'true',
            name: el.getAttribute('data-tree-name')
          }
    )
  )
}

/** The tree's rows and rules in document order — shape, not pixels. */
function readTree(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-row], [data-tree-rule]')].map((el) =>
      el.hasAttribute('data-tree-rule')
        ? { kind: 'rule', depth: Number(el.getAttribute('data-tree-rule')) }
        : {
            kind: el.getAttribute('data-tree-kind'),
            depth: Number(el.getAttribute('data-tree-row')),
            name: el.getAttribute('data-tree-name')
          }
    )
  )
}

export async function run(t) {
  seedRepos()
  seedBigRoot()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT, BIG_ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'panel' })
    await win.waitForTimeout(2000)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)

    // The path bar lands on the terminal card's top edge, as the sidebar's
    // launcher does across the other divide: the tab bar sits level with the
    // toolbar, and the box under it starts where the content does.
    const align = await win.evaluate(() => {
      const bar = document.querySelector('[data-panel-bar="path"]')?.getBoundingClientRect()
      const cards = [...document.querySelectorAll('.floating-card')].map((c) => c.getBoundingClientRect())
      const main = cards.sort((a, b) => b.height - a.height)[0]
      return bar && main ? { bar: bar.top, card: main.top } : null
    })
    t.check("the path bar sits on the content card's top edge", !!align && Math.abs(align.bar - align.card) < 1, align)

    // ── The tab bar carries the tabs, and nothing else ────────────────────
    const bar = await win.evaluate(() => {
      const el = document.querySelector('[data-panel-bar="tabs"]')
      if (!el) return null
      const label = (sel) => !!el.querySelector(sel)
      const barBox = el.getBoundingClientRect()
      const tabEls = [...el.querySelectorAll('.panel-tab')]
      const first = tabEls[0]?.getBoundingClientRect()
      const last = tabEls[tabEls.length - 1]?.getBoundingClientRect()
      return {
        tabs: tabEls.map((b) => b.textContent.trim()),
        folder: label('[aria-label="Open another folder"]'),
        collapse: label('[aria-label="Collapse all"]'),
        help: label('[aria-label="Help"]'),
        // The bar hugs its two tabs — its width is theirs plus its own padding,
        // not the panel's — and centres itself in the panel. Asserted as
        // relations so the numbers can move with the padding.
        leftSlack: first ? first.left - barBox.left : null,
        rightSlack: last ? barBox.right - last.right : null,
        barWidth: barBox.width,
        parentWidth: el.parentElement.getBoundingClientRect().width,
        barLeftGap: barBox.left - el.parentElement.getBoundingClientRect().left,
        barRightGap: el.parentElement.getBoundingClientRect().right - barBox.right
      }
    })
    t.check('the panel has one tab bar', bar !== null, bar)
    t.check(
      'it holds both tabs',
      JSON.stringify(bar?.tabs) === JSON.stringify(['Files', 'Git']),
      bar?.tabs
    )
    t.check(
      'the bar is the width of the two tabs, not the panel’s',
      bar !== null && bar.barWidth < bar.parentWidth - 20,
      { barWidth: bar?.barWidth, parentWidth: bar?.parentWidth }
    )
    t.check(
      'and it centres itself in the panel',
      bar !== null && Math.abs(bar.barLeftGap - bar.barRightGap) <= 1 && bar.barLeftGap > 4,
      { barLeftGap: bar?.barLeftGap, barRightGap: bar?.barRightGap }
    )
    t.check(
      'the tabs sit tight inside it — no slack of its own',
      bar !== null && bar.leftSlack <= 3 && bar.rightSlack <= 3,
      { leftSlack: bar?.leftSlack, rightSlack: bar?.rightSlack }
    )
    t.check('the folder picker is not on the tab bar', bar?.folder === false)
    t.check('collapse-all is not on the tab bar', bar?.collapse === false)
    t.check('the help button is gone from the tab bar', bar?.help === false)

    // ── The path bar is where you are, as one control ─────────────────────
    // The root chip picks the folder, the path names it, collapse-all closes
    // what it opened: all three act on the same subject, so they are one bar.
    // They used to be split across two rows, the path a bare line of text.
    const pathBar = await win.evaluate(() => {
      const el = document.querySelector('[data-panel-bar="path"]')
      if (!el) return null
      return {
        boxed: getComputedStyle(el).borderTopWidth !== '0px',
        chip: !!el.querySelector('[data-panel-scope]'),
        folder: !!el.querySelector('[aria-label="Open another folder"]'),
        collapse: !!el.querySelector('[aria-label="Collapse all"]'),
        text: el.textContent.trim()
      }
    })
    t.check('the path sits in a bar of its own', pathBar !== null, pathBar)
    t.check('drawn as a box like the panel’s other bars', pathBar?.boxed === true, pathBar)
    t.check('the root chip is on it', pathBar?.chip === true, pathBar)
    t.check('and the folder picker is in its menu, not loose on the bar', pathBar?.folder === false, pathBar)
    t.check('collapse-all is on it', pathBar?.collapse === true, pathBar)
    t.check('and it names the folder the panel is pointed at', pathBar?.text.length > 0, pathBar)

    // The help button is gone from the panel entirely, not merely moved.
    t.equal(
      'no help button anywhere in the panel',
      await win.evaluate(() => document.querySelectorAll('[aria-label="Help"]').length),
      0
    )

    // Neither tab may keep a second copy of a shared control — asserted once per
    // tab, WHILE that tab is mounted. Checking both selectors from the file tab
    // is what let a collapse-all put back in the git bar survive: the git bar is
    // not in the DOM until you are on it, so the selector matched nothing and
    // the check passed for the wrong reason.
    const straysIn = (which) =>
      win.evaluate(
        (w) =>
          document.querySelectorAll(`[data-panel-bar="${w}"] [aria-label="Collapse all"]`).length,
        which
      )
    t.equal('the file tab keeps no collapse-all of its own', await straysIn('files'), 0)

    // ── The file tab's bar is the shared search field ─────────────────────
    const filterField = await win.evaluate(() => {
      const input = document.querySelector('[data-panel-bar="files"] .search-field input')
      return input ? { placeholder: input.placeholder } : null
    })
    t.check('the filter is the search field the sidebar uses', filterField !== null, filterField)

    const rowsBeforeFilter = await win.evaluate(
      () => document.querySelectorAll('[data-tree-item]').length
    )
    await win.fill('[data-panel-bar="files"] .search-field input', 'README')
    await win.waitForTimeout(1500)
    const filtered = await win.evaluate(() =>
      [...document.querySelectorAll('[data-tree-item]')].map((r) => r.textContent.trim())
    )
    t.check(
      'the filter narrows the tree to matches',
      filtered.length > 0 && filtered.every((r) => r.toLowerCase().includes('readme')),
      filtered.slice(0, 6)
    )
    await win.click('[data-panel-bar="files"] .search-field-clear')
    await win.waitForTimeout(1200)
    t.equal(
      'clearing the filter restores the tree',
      await win.evaluate(() => document.querySelectorAll('[data-tree-item]').length),
      rowsBeforeFilter
    )

    // ── Collapse-all reaches the file tree from the shared bar ────────────
    // Deep, not one level: `labs` opens a block, `products` INSIDE it is that
    // block's first child opening a block of its own, and `beta-core` inside
    // THAT holds files. A tree one level deep cannot tell a rule placed at
    // every block head from one placed at every row that is not deeper than its
    // predecessor — the two agree until a folder's first child is itself a
    // folder — and a tree of nothing but folders cannot tell "rule the folders"
    // from "rule every row".
    const openDir = async (name) => {
      await win.evaluate((n) => {
        const dir = [...document.querySelectorAll('[data-tree-item]')].find(
          (r) => r.getAttribute('data-tree-name') === n && r.getAttribute('data-tree-expanded') === 'false'
        )
        dir?.click()
      }, name)
      await win.waitForTimeout(1200)
    }
    await openDir('labs')
    await openDir('products')
    // Three levels, and the third holds FILES — the fixture has to contain a
    // run of leaves under a folder, or "files among files take no rule" is a
    // claim the sweep never gets to judge.
    await openDir('beta-core')
    const expandedFiles = await win.evaluate(
      () => document.querySelectorAll('[data-tree-item]').length
    )
    t.check('a folder opens in the file tree', expandedFiles > rowsBeforeFilter, {
      expandedFiles,
      rowsBeforeFilter
    })

    // ── The file tree carries the git tree's rules ────────────────────────
    // Same hairline, same sentence: above every row but the first, at that
    // row's own depth. Files included, and a folder's first child included —
    // holding back at either was what made the ruling look like it gave out
    // partway down the panel.
    //
    // Asserted over the whole sequence rather than by counting lines, which is
    // what lets it fail on a rule in the wrong PLACE and not merely on a
    // missing one.
    const fileSeq = await readFileTree(win)
    const fileRuleProblems = []
    let fPrev = null
    let fPending = null
    for (let i = 0; i < fileSeq.length; i++) {
      const entry = fileSeq[i]
      if (entry.kind === 'rule') {
        if (fPending !== null) fileRuleProblems.push(`two rules in a row at ${entry.depth}`)
        fPending = entry.depth
        continue
      }
      if (fPrev === null) {
        if (fPending !== null) fileRuleProblems.push(`rule above the first row (${entry.name})`)
      } else if (fPending === null) {
        fileRuleProblems.push(
          `no rule between ${fPrev.name}(${fPrev.depth}) and ${entry.name}(${entry.depth})`
        )
      } else if (fPending !== entry.depth) {
        fileRuleProblems.push(`rule above ${entry.name} at depth ${fPending}, wanted ${entry.depth}`)
      }
      fPending = null
      fPrev = entry
    }
    t.check(
      'the file tree rules every pair of rows, at the lower row’s depth',
      fileRuleProblems.length === 0,
      fileRuleProblems
    )
    // The fixture has to contain the shapes being judged, or the sweep above
    // passes over a tree with no boundaries in it at all.
    const fileRules = fileSeq.filter((e) => e.kind === 'rule')
    const fileRows = fileSeq.filter((e) => e.kind === 'row')
    t.equal('one rule per row but the first', fileRules.length, Math.max(0, fileRows.length - 1))
    t.check(
      'the tree under test holds files as well as folders',
      fileRows.some((r) => !r.dir) && fileRows.some((r) => r.dir),
      fileRows.map((r) => `${r.name}${r.dir ? '/' : ''}`)
    )
    // The pairing that was exempt until last.
    const ruledFirstChild = fileSeq.some(
      (e, i) =>
        e.kind === 'rule' &&
        fileSeq[i - 1]?.kind === 'row' &&
        fileSeq[i + 1]?.kind === 'row' &&
        fileSeq[i + 1].depth > fileSeq[i - 1].depth
    )
    t.check('a folder and its first child are ruled apart too', ruledFirstChild, fileSeq)

    // ── The file tree's own geometry, kept for the git tree to be judged
    //    against once that tab is on screen ──────────────────────────────────
    const filePads = await win.evaluate(() => {
      const out = {}
      for (const el of document.querySelectorAll('[data-tree-item]')) {
        const d = Number(el.getAttribute('data-tree-depth'))
        if (!(d in out)) out[d] = parseFloat(getComputedStyle(el).paddingLeft)
      }
      return out
    })

    // The file tree draws NO vertical indent guides. It used to carry one
    // hairline per level down every row; they were removed outright, so the
    // claim is an absence — measured on a tree that is actually nested, or the
    // check passes over a flat list that never had a guide to draw.
    const guides = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-tree-item]')]
      return {
        deepestDepth: rows.reduce(
          (m, r) => Math.max(m, Number(r.getAttribute('data-tree-depth'))),
          0
        ),
        guides: document.querySelectorAll('.tree-guide').length,
        // Anything absolutely positioned inside a row would be a guide under
        // another name — the row itself no longer establishes a containing
        // block for one.
        absolutesInRows: rows.filter((r) =>
          [...r.children].some((c) => getComputedStyle(c).position === 'absolute')
        ).length
      }
    })
    t.check('the tree under test is nested', guides.deepestDepth >= 1, guides)
    t.equal('the file tree draws no indent guides', guides.guides, 0)
    t.equal('and no row carries an absolutely positioned line', guides.absolutesInRows, 0)
    // Drawn on the block's own indentation, not full-bleed across the tree.
    const ruleInsets = await win.evaluate(() =>
      [...document.querySelectorAll('[data-file-tree-rule]')].map((el) => ({
        depth: Number(el.getAttribute('data-file-tree-rule')),
        left: el.getBoundingClientRect().left
      }))
    )
    const byDepth = new Map()
    for (const r of ruleInsets) byDepth.set(r.depth, r.left)
    t.check(
      'a deeper rule is inset further than a shallower one',
      [...byDepth.entries()]
        .sort((a, b) => a[0] - b[0])
        .every(([d, left], i, all) => i === 0 || left > all[i - 1][1]),
      [...byDepth.entries()]
    )

    // ── The guide token is gone from every theme ─────────────────────────
    // "Removed" has to mean removed, not hidden: a --tree-guide-color left
    // standing in one theme is a guide one class away from coming back. Swept
    // over ALL FOUR themes because each declares its own palette block.
    const tokenSweep = await win.evaluate(async () => {
      const was = (await window.electronAPI.skinsList()).activeId
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      document.body.appendChild(probe)
      const out = {}
      for (const theme of ['dark', 'charcoal', 'light', 'coffee']) {
        await window.electronAPI.skinsActivate(theme)
        probe.style.backgroundColor = ''
        probe.style.backgroundColor = 'var(--tree-guide-color)'
        // An undefined custom property makes the declaration invalid at
        // computed-value time, so background-color falls back to transparent.
        out[theme] = getComputedStyle(probe).backgroundColor
      }
      if (was) await window.electronAPI.skinsActivate(was)
      probe.remove()
      return out
    })
    t.check(
      'no theme still declares a tree-guide colour',
      Object.values(tokenSweep).every((c) => c === 'rgba(0, 0, 0, 0)'),
      tokenSweep
    )

    await win.click('[data-panel-bar="path"] [aria-label="Collapse all"]')
    await win.waitForTimeout(800)
    t.equal(
      'the shared collapse-all folds the file tree',
      await win.evaluate(() => document.querySelectorAll('[data-tree-item]').length),
      rowsBeforeFilter
    )

    // ── Row height: the two tabs are one list to the eye ──────────────────
    // Inside a repo, the git tab used to pack its rows at 20px against the file
    // tree's 28px, so opening a repo dropped you into a denser list than the one
    // you came from and read as clutter. Measured, not asserted from the CSS: a
    // row that grows a taller child grows with it, and that is what would break
    // the parity again.
    const fileRowHeights = await win.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll('[data-tree-item]')].map((el) => el.getBoundingClientRect().height)
      )
    ])
    t.check(
      'every row of the file tree is one height — a folder is not shorter than a file',
      fileRowHeights.length === 1,
      fileRowHeights
    )
    const FILE_ROW_H = fileRowHeights[0]

    // ── The git tab ───────────────────────────────────────────────────────
    await win.evaluate(() => {
      ;[...document.querySelectorAll('.panel-tab')]
        .find((b) => b.textContent.trim() === 'Git')
        ?.click()
    })
    await win.waitForTimeout(6000)

    // What the bar owes at any width: every control it draws is INSIDE it. The
    // old promise here was "one line", and the bar kept it the dishonest way —
    // its six controls are a flex-shrink-0 cluster, so holding them on one line
    // at 240px simply ran the last two off the panel and out of the window.
    // Reach is the assertion; the line count is the bar's business, capped at
    // two so a regression that stacks its parts is still caught.
    const readGitBar = () =>
      win.evaluate(() => {
        const el = document.querySelector('[data-panel-bar="git"]')
        if (!el) return null
        const box = el.getBoundingClientRect()
        const spill = [...el.querySelectorAll('button')]
          .map((b) => b.getBoundingClientRect())
          .filter((r) => r.right > box.right + 0.5 || r.left < box.left - 0.5).length
        return { height: el.offsetHeight, width: el.clientWidth, spill }
      })

    const gitBar = await readGitBar()
    t.check('the git tab has a bar of its own', gitBar !== null)
    t.equal('the git tab keeps no collapse-all of its own', await straysIn('git'), 0)
    t.check(
      'at the default width every git control is inside the bar',
      gitBar?.spill === 0,
      gitBar
    )
    t.check('and the bar is at most two lines', (gitBar?.height ?? 99) <= 64, gitBar)

    // The real test of the cluster: drag the panel to its 180px minimum, where
    // the bar's contents no longer fit on one line. The cluster must move down
    // whole — never spill past the panel, never drop one orphan icon.
    const narrowed = await (async () => {
      const box = await win.evaluate(() => {
        const el = document
          .querySelector('[data-panel-bar="git"]')
          .closest('[class*="overflow-hidden"]')
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, height: r.height }
      })
      await win.mouse.move(box.x + 2, box.y + box.height / 2)
      await win.mouse.down()
      // Well past the 180px clamp, so the drag lands ON the minimum.
      await win.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 8 })
      await win.mouse.up()
      await win.waitForTimeout(1200)
      return readGitBar()
    })()
    t.check('the panel actually narrowed', narrowed.width < (gitBar?.width ?? 0), {
      gitBar,
      narrowed
    })
    t.check(
      'at the minimum width every git control is still inside the bar',
      narrowed.spill === 0,
      narrowed
    )
    // Three rows is allowed HERE and nowhere else: at 180px six controls do not
    // fit end to end on any single line, so the cluster wraps inside itself. A
    // third row is the price of every control staying reachable, which is the
    // assertion above and the one that matters.
    t.check('and it takes a third row at most to do it', narrowed.height <= 96, narrowed)

    // The git tab now opens with every folder SHUT (the panel's shared
    // expansion set — see panel-shared-expansion.spec.mjs), so the tree starts
    // as its top-level rows alone. Everything below judges nesting: depths,
    // the indent step between levels, a folder's first child, and what
    // collapse-all has left to fold. Open the folders first, or each of those
    // measures a one-level tree and passes or fails for the wrong reason.
    const openGitDir = async (name) => {
      await win.evaluate((n) => {
        const row = [...document.querySelectorAll('[data-tree-row][data-tree-kind="dir"]')].find(
          (r) =>
            r.getAttribute('data-tree-name') === n &&
            r.getAttribute('data-tree-collapsed') === 'true'
        )
        row?.click()
      }, name)
      await win.waitForTimeout(1500)
    }
    await openGitDir('labs')
    await openGitDir('products')

    const seq = await readTree(win)
    const rows = seq.filter((e) => e.kind !== 'rule')
    t.check('the repo tree rendered', rows.length >= REPOS.length, seq)

    // The same measurement inside a repo. The shared collapse-all fired on the
    // file tab folds every repo, mounted or not, so unfold one by hand first.
    await win.evaluate(() => {
      document.querySelector('[data-tree-kind="repo"]')?.click()
    })
    await win.waitForTimeout(2500)

    // Both view modes, because they are two different row components and only
    // one of them is on screen at a time — a height fixed in the list rows and
    // left behind in the tree rows is exactly the regression this misses if it
    // only ever looks at the default.
    const measureGitRows = () =>
      win.evaluate(() => {
        const els = [...document.querySelectorAll('[data-git-row]')]
        return {
          count: els.length,
          kinds: [...new Set(els.map((el) => el.getAttribute('data-git-row')))].sort(),
          heights: [...new Set(els.map((el) => el.getBoundingClientRect().height))]
        }
      })

    const listRows = await measureGitRows()
    t.check('a repo unfolded to its files', listRows.count > 0, listRows)
    t.check(
      'a repo’s rows are the height of the file tree’s rows',
      listRows.heights.length === 1 && listRows.heights[0] === FILE_ROW_H,
      { listRows, FILE_ROW_H }
    )

    await win.click('[data-panel-bar="git"] [aria-label="Tree view"]')
    await win.waitForTimeout(1500)
    const treeRows = await measureGitRows()
    t.check(
      'tree view renders folders as well as files',
      treeRows.count > 0 && treeRows.kinds.includes('dir') && treeRows.kinds.includes('file'),
      treeRows
    )
    t.check(
      'and both are the height of the file tree’s rows',
      treeRows.heights.length === 1 && treeRows.heights[0] === FILE_ROW_H,
      { treeRows, FILE_ROW_H }
    )
    await win.click('[data-panel-bar="git"] [aria-label="List view"]')
    await win.waitForTimeout(1500)

    // ── One geometry for both trees ───────────────────────────────────────
    // The file tree ran on an 8px gutter and 8px per level against the git
    // tree's 12px, which beside it read as a denser, smaller list rather than
    // as the same tree showing different things. Both measured from rendered
    // rows, because the numbers live in two files and drifting apart is exactly
    // what they did.
    const gitPads = await win.evaluate(() => {
      const out = {}
      for (const el of document.querySelectorAll('[data-tree-row]')) {
        const d = Number(el.getAttribute('data-tree-row'))
        if (!(d in out)) out[d] = parseFloat(getComputedStyle(el).paddingLeft)
      }
      return out
    })
    const step = (m) => (m[0] !== undefined && m[1] !== undefined ? m[1] - m[0] : null)
    t.equal('both trees start on the same gutter', filePads[0], gitPads[0])
    t.check(
      'and step in by the same indent per level',
      step(filePads) !== null && step(filePads) === step(gitPads),
      { filePads, gitPads }
    )

    // ── The tones: modified is not a warning ──────────────────────────────
    // Orange is reserved for the one row that is actually a heads-up (a file an
    // incoming change and the working tree both touch). A modified file and an
    // incoming commit are the normal life of a repo and must not wear it.
    //
    // Colors are compared through a probe element rather than against a literal
    // rgb(): tailwind v4 declares its palette in oklch and Chromium hands that
    // string back unconverted, so a hardcoded `rgb(251, 146, 60)` matches
    // nothing and the check passes no matter what color the row is wearing.
    const tones = await win.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.position = 'fixed'
      probe.style.opacity = '0'
      document.body.appendChild(probe)
      const resolve = (expr) => {
        probe.style.color = ''
        probe.style.color = expr
        return getComputedStyle(probe).color
      }
      const wanted = {
        modified: resolve('var(--color-git-modified)'),
        incoming: resolve('var(--color-git-incoming)'),
        orange: resolve('var(--color-orange-400)')
      }
      const letters = [...document.querySelectorAll('[data-git-row="file"] .font-mono')].map(
        (el) => ({ letter: el.textContent.trim(), color: getComputedStyle(el).color })
      )
      const badges = [...document.querySelectorAll('.git-sync-badge')].map((el) => ({
        text: el.textContent.trim(),
        color: getComputedStyle(el).color
      }))
      probe.remove()
      return { wanted, letters, badges }
    })
    t.check(
      'the tones resolve to three distinct colors',
      new Set(Object.values(tones.wanted)).size === 3,
      tones.wanted
    )
    const modifiedLetters = tones.letters.filter((l) => l.letter === 'M')
    t.check('the repo has a modified file to judge', modifiedLetters.length > 0, tones.letters)
    t.check(
      'a modified file wears the modified tone, not orange',
      modifiedLetters.every((l) => l.color === tones.wanted.modified),
      { modifiedLetters, wanted: tones.wanted.modified }
    )
    t.check(
      'no status letter is painted orange',
      tones.letters.every((l) => l.color !== tones.wanted.orange),
      tones.letters
    )
    const incomingBadges = tones.badges.filter((b) => b.text.startsWith('\u2193'))
    t.check(
      'a repo is behind its upstream, so there is an incoming badge to judge',
      incomingBadges.length > 0,
      tones.badges
    )
    t.check(
      'the incoming badge wears the incoming tone, not orange',
      incomingBadges.every((b) => b.color === tones.wanted.incoming),
      { incomingBadges, wanted: tones.wanted.incoming }
    )
    t.check(
      'no sync badge is painted orange',
      tones.badges.every((b) => b.color !== tones.wanted.orange),
      tones.badges
    )

    // ── The rules: one between every pair of rows, none anywhere else ─────
    // Every row but the first is ruled off from the one above it, at its OWN
    // depth — the depth of the row below a line is the only one knowable at the
    // boundary, since the row above it sits wherever its subtree ended.
    const problems = []
    let prev = null
    let pendingRule = null
    for (const entry of seq) {
      if (entry.kind === 'rule') {
        if (pendingRule !== null) problems.push(`two rules in a row before ${entry.depth}`)
        pendingRule = entry.depth
        continue
      }
      if (prev === null) {
        if (pendingRule !== null) problems.push(`rule above the first row (${entry.name})`)
      } else {
        if (pendingRule === null) {
          problems.push(
            `no rule between ${prev.name}(${prev.depth}) and ${entry.name}(${entry.depth})`
          )
        } else if (pendingRule !== entry.depth) {
          problems.push(`rule above ${entry.name} at depth ${pendingRule}, wanted ${entry.depth}`)
        }
      }
      pendingRule = null
      prev = entry
    }
    t.check(
      'every pair of rows is ruled apart, at the lower row’s depth',
      problems.length === 0,
      problems
    )
    // The pairing that was exempt until last: a folder and the first repo
    // inside it. Asserted as its own claim, because the sweep above would also
    // pass on a tree that happened to have no first child in it.
    const ruledFirstChildGit = seq.some(
      (e, i) =>
        e.kind === 'rule' &&
        seq[i - 1]?.kind !== 'rule' &&
        seq[i + 1] &&
        seq[i + 1].depth > (seq[i - 1]?.depth ?? -1)
    )
    t.check('a folder’s first child is ruled off from it too', ruledFirstChildGit, seq)

    // The bug in one assertion: folders never got a rule at all, so a mixed
    // tree ruled under repos and nowhere else.
    const ruledDirs = seq.filter(
      (e, i) => e.kind === 'dir' && i > 0 && seq[i - 1].kind === 'rule'
    ).length
    t.check('a folder closing the block above it is ruled off', ruledDirs > 0, seq)

    // ── Collapse-all reaches the repo tree from the same button ───────────
    const rowsExpanded = (await readTree(win)).filter((e) => e.kind !== 'rule').length
    await win.click('[data-panel-bar="path"] [aria-label="Collapse all"]')
    await win.waitForTimeout(1200)
    const afterCollapse = (await readTree(win)).filter((e) => e.kind !== 'rule')
    t.check('the shared collapse-all folds the repo tree', afterCollapse.length < rowsExpanded, {
      rowsExpanded,
      after: afterCollapse.length
    })
    t.check(
      'and leaves only top-level rows',
      afterCollapse.length > 0 && afterCollapse.every((r) => r.depth === 0),
      afterCollapse
    )
    // Folding must not leave the rules behind: the boundaries are recomputed
    // from the rows that remain.
    const foldedSeq = await readTree(win)
    let foldedProblems = 0
    for (let i = 0; i < foldedSeq.length; i++) {
      if (foldedSeq[i].kind !== 'rule') continue
      const next = foldedSeq[i + 1]
      if (!next || next.kind === 'rule' || next.depth !== foldedSeq[i].depth) foldedProblems++
    }
    t.equal('folded, every rule still sits above a row of its own depth', foldedProblems, 0)
    // ── The paused-updates footnote ───────────────────────────────────────
    // Reached the way a user reaches it: the folder picker in the root chip's
    // menu, pointed at a folder with more repos than the DEFAULT limit.
    // (Setting the limit by hand needs a reload, and a reloaded window has no
    // focused session, so the panel would be paused about the workspace root
    // rather than the big folder.)
    await stubFolderDialog(app, { returns: BIG_ROOT })
    await win.click('[data-panel-bar="path"] [data-panel-scope]')
    await win.waitForTimeout(300)
    await win.click('[data-scope-option="folder"]')
    await win.waitForTimeout(9000)

    const note = await win.evaluate(() => {
      const el = document.querySelector('[data-git-footnote]')
      if (!el) return null
      const scroller = document.querySelector('[data-tree-row]')?.closest('.overflow-y-auto')
      return {
        text: el.textContent.trim(),
        body: !!el.querySelector('[data-git-footnote-body]'),
        // Below the list, not above it: the whole point of moving it.
        belowTree: scroller
          ? el.getBoundingClientRect().top >= scroller.getBoundingClientRect().bottom - 1
          : null
      }
    })
    // Asserted on the path, not on the footnote below: two separate claims, and
    // conflating them made a missing footnote read as a broken folder picker.
    const landedOn = await win.evaluate(
      () => document.querySelector('[data-panel-bar="tabs"]')?.parentElement?.textContent ?? ''
    )
    t.check(
      'the folder picker in the root menu navigates the panel',
      landedOn.includes('side-panel-big'),
      landedOn.slice(0, 80)
    )
    t.check('a footnote appears when live updates pause', note !== null, note)
    t.check('it sits below the tree, not above it', note?.belowTree === true, note)
    t.check('it is folded by default', note?.body === false, note)
    // Folded it is one short line. The old banner spelled the count, the pause
    // and the timestamp across the top of the list you came to read.
    t.check('folded, it is a short line', (note?.text.length ?? 999) < 60, note?.text)

    await win.click('[data-git-footnote-toggle]')
    await win.waitForTimeout(600)
    const opened = await win.evaluate(() => {
      const body = document.querySelector('[data-git-footnote-body]')
      return body
        ? {
            text: body.textContent.trim(),
            settings: !!document.querySelector('[data-git-footnote-settings]'),
            buttons: body.querySelectorAll('.git-footnote-buttons button').length
          }
        : null
    })
    t.check('opening it explains why', (opened?.text.length ?? 0) > 60, opened)
    t.check('and offers one way to change the limit', opened?.settings === true, opened)
    t.equal('exactly one button, not a menu of them', opened?.buttons ?? -1, 1)

    const limitBefore = await win.evaluate(() =>
      localStorage.getItem('clave-git-live-poll-limit')
    )
    await win.click('[data-git-footnote-settings]')
    await win.waitForTimeout(1500)

    // It opens the setting; it does not silently move it. A button that changed
    // the limit and then retired the note left no way back to what it changed.
    t.check(
      'the button opens the setting rather than changing it',
      await win.evaluate(() => document.body.innerText.includes('Pause live updates above')),
      (await win.evaluate(() => document.body.innerText)).slice(0, 200)
    )
    t.equal(
      'and the limit is untouched until the user edits it',
      await win.evaluate(() => localStorage.getItem('clave-git-live-poll-limit')),
      limitBefore
    )

  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(BIG_ROOT, { recursive: true, force: true })
  }
}
