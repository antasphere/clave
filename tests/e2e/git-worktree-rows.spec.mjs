/**
 * A worktree's row in the git panel (PRDCT-2356).
 *
 * A worktree used to be one more repo in the alphabetical list, its row
 * answering the remote question (↓ ↑) and not the one its reader asks: what
 * has it done since it was cut, and how far has its base moved. Now:
 *
 * 1. The worktree row sits directly under the repo it belongs to, behind a
 *    guide and with no icon; the repos stay alphabetical around it.
 * 2. The row carries the base badge, `main−2` when main gained two commits the
 *    worktree lacks, and a purple `+3` for the three commits it added.
 * 3. Each opens its own file list under the row: `Since main` with the three
 *    files the worktree added, `Behind main` with the one file the base
 *    changed. The main checkout's own row carries neither badge.
 *
 * `/private/tmp` rather than `/tmp`, so git's resolved repo root matches the
 * discovered path (the symlink otherwise reparents every repo).
 */
import { launchApp, seedWorkspaces, seedTrustedRoots, userDataDir, until } from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('git-worktree-rows-data')
const ROOT = '/private/tmp/clave-e2e-worktree-rows'
const APP = path.join(ROOT, 'app')
const WT = path.join(ROOT, 'wt-feature')
// A long name on a row with four badges (base, count, unpublished, changes):
// the row where the name's floor is load-bearing (verifier round 2, gap 12).
const WT_LONG = path.join(ROOT, 'wt-long-feature-name-for-the-floor')
// Cut after the base moved: no drift, so its base badge is a label, not a button.
const WT_STILL = path.join(ROOT, 'wt-still')
// Alphabetically after the worktrees' names, so the order check has a repo
// that must NOT slip between the source and its worktrees.
const OTHER = path.join(ROOT, 'zed')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000002e',
  name: 'Worktrees',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
const commit = (cwd, file, message) => {
  writeFileSync(path.join(cwd, file), `${message}\n`)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', message)
}

/** `app` on main, a worktree cut from it with three commits, then main moves on by two. */
function seed() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(APP, { recursive: true })
  git(APP, 'init', '-q', '-b', 'main')
  commit(APP, 'README.md', 'seed')
  commit(APP, 'base.txt', 'base one')

  git(APP, 'worktree', 'add', '-q', WT, '-b', 'feature', 'main')
  commit(WT, 'a.txt', 'feature a')
  commit(WT, 'b.txt', 'feature b')
  commit(WT, 'c.txt', 'feature c')

  git(APP, 'worktree', 'add', '-q', WT_LONG, '-b', 'long', 'main')
  commit(WT_LONG, 'l1.txt', 'long one')
  commit(WT_LONG, 'l2.txt', 'long two')
  commit(WT_LONG, 'l3.txt', 'long three')
  writeFileSync(path.join(WT_LONG, 'dirty.txt'), 'dirty\n')

  commit(APP, 'base.txt', 'base two')
  commit(APP, 'base.txt', 'base three')
  git(APP, 'worktree', 'add', '-q', WT_STILL, '-b', 'still', 'main')

  mkdirSync(OTHER, { recursive: true })
  git(OTHER, 'init', '-q', '-b', 'main')
  commit(OTHER, 'README.md', 'zed')
}

/** The repo tree's rows in order: kind, name, the badges each carries, and
 *  the geometry the flags are meant to produce — the drawing, not the data
 *  (verifier round 1, gap 8). */
function readRows(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-kind="repo"], [data-tree-kind="worktree"]')].map(
      (el) => {
        const badge = el.querySelector('[data-git-base-badge]')
        const name = el.querySelector('.git-tree-row-name')
        const guide = el.querySelector('.git-worktree-guide')
        const stem = el.querySelector('.git-worktree-stem')
        const guideLine = guide ? getComputedStyle(guide, '::before') : null
        const visible = (node) =>
          node ? [...node.childNodes].filter((n) => n.nodeType !== 1 || getComputedStyle(n).display !== 'none').map((n) => n.textContent).join('').trim() : null
        const rowStyle = getComputedStyle(el)
        const rowW = el.getBoundingClientRect().width
        return {
          kind: el.dataset.treeKind,
          name: el.dataset.treeName,
          of: el.dataset.treeWorktreeOf ?? null,
          last: el.dataset.treeWorktreeLast === 'true',
          collapsed: el.dataset.treeCollapsed === 'true',
          rowW,
          // The container query measures the content box, not the row.
          contentW: rowW - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
          overflows: el.scrollWidth > el.clientWidth,
          baseDisplay: badge ? getComputedStyle(badge).display : null,
          badgeCount: el.querySelectorAll('.git-sync-badge').length,
          nameW: name?.getBoundingClientRect().width ?? null,
          nameScroll: name?.scrollWidth ?? null,
          stem: !!stem,
          stemX: stem ? stem.getBoundingClientRect().left : null,
          guide: !!guide,
          guideH: guide?.getBoundingClientRect().height ?? null,
          lineX: guide ? guide.getBoundingClientRect().left + parseFloat(guideLine.left) : null,
          lineBottom: guide ? parseFloat(guideLine.bottom) : null,
          base: visible(badge),
          baseTitle: badge?.title ?? null,
          baseKind: badge?.dataset.gitBaseBadge ?? null,
          baseCursor: badge ? getComputedStyle(badge).cursor : null,
          worktreeCount:
            el.querySelector('[data-git-sync-tone="worktree"]')?.textContent.trim() ?? null,
          incoming: el.querySelector('[data-git-sync-tone="incoming"]')?.textContent.trim() ?? null,
          outgoing: el.querySelector('[data-git-sync-tone="outgoing"]')?.textContent.trim() ?? null
        }
      }
    )
  )
}

/** Section headers and file rows under the repo tree, in order. */
function readSections(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.git-section-header, [data-git-row]')].map((el) =>
      el.classList.contains('git-section-header')
        ? { kind: 'header', text: el.textContent.trim() }
        : { kind: 'row', text: el.textContent.trim() }
    )
  )
}

async function clickIn(win, rowName, selector) {
  await win.evaluate(
    ({ rowName, selector }) => {
      document.querySelector(`[data-tree-name="${rowName}"] ${selector}`)?.click()
    },
    { rowName, selector }
  )
}

export async function run(t) {
  seed()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1500)
    await win.evaluate(() => {
      ;[...document.querySelectorAll('.panel-tab')].find((b) => b.textContent.trim() === 'Git')?.click()
    })
    // The worktree reading lands with the status batch; wait for the badge
    // rather than a fixed pause.
    await until(async () => (await readRows(win)).some((r) => r.kind === 'worktree' && r.base))

    const rows = await readRows(win)
    t.check(
      'the worktrees sit directly under their repo, alphabetical, the other repo after them',
      rows.map((r) => `${r.kind}:${r.name}`).join(' ') ===
        'repo:app worktree:wt-feature worktree:wt-long-feature-name-for-the-floor worktree:wt-still repo:zed',
      rows
    )
    const wt = rows.find((r) => r.name === 'wt-feature')
    const long = rows.find((r) => r.name === 'wt-long-feature-name-for-the-floor')
    const still = rows.find((r) => r.name === 'wt-still')
    const src = rows.find((r) => r.name === 'app')
    t.check('the worktree row names its source', wt?.of === APP, wt)
    t.check('both worktree rows carry the guide, no icon', wt?.guide && still?.guide, { wt, still })
    t.check('the line runs through the first worktree and ends at the last', wt?.lineBottom === 0 && !wt?.last && still?.last, { wt, still })
    t.check(
      'the last guide ends at the middle of its row',
      still && Math.abs(still.lineBottom - still.guideH / 2) <= 0.5,
      still
    )
    t.check('the source row draws the stem the guide continues', src?.stem === true, src)
    t.check(
      'the stem and the guide line sit on one column',
      src && wt && Math.abs(src.stemX - wt.lineX) <= 0.01,
      { stemX: src?.stemX, lineX: wt?.lineX }
    )
    // The panel opens narrow; the base name folds away when the row's CONTENT
    // box is under 300px (the container query measures that, not the row) and
    // the drift stays, the title still naming the base.
    const narrow = (wt?.contentW ?? 0) < 300
    t.check(
      `the base badge reads ${narrow ? '−2, its title naming main,' : 'main−2'} (row ${wt?.rowW}px, content ${wt?.contentW}px)`,
      wt?.baseKind === 'drift' && wt?.base === (narrow ? '−2' : 'main−2') && /main/.test(wt?.baseTitle ?? ''),
      wt
    )
    t.check('the purple count reads +3', wt?.worktreeCount === '3', wt)
    // The floor, on the row where it is load-bearing: a long name behind four
    // badges. Without the floor the name shrinks below five characters; with
    // it the row must still not overflow its width.
    t.check(
      'a long name behind four badges keeps at least five characters of room',
      long?.badgeCount === 4 && (long?.nameW ?? 0) >= 38 && (long?.nameScroll ?? 0) > (long?.nameW ?? 0),
      { badgeCount: long?.badgeCount, nameW: long?.nameW, nameScroll: long?.nameScroll }
    )
    t.check('and the row does not overflow', long?.overflows === false, long)
    t.check('the source row has neither badge', src?.base === null && src?.worktreeCount === null, src)
    // No remote in the fixture, so nothing is incoming; the ↑ carries the
    // existing "unpublished commits" count on every row here and is not this
    // change's to assert.
    t.check('the blue badge stays off a repo with no remote', wt?.incoming === null, wt)

    // A base with no drift: a label, with a label's cursor, whose click
    // neither opens a section nor unfolds the row (verifier round 1, findings 3 and 4).
    t.check('a base that has not moved is a label with no count', still?.baseKind === 'label' && still?.worktreeCount === null, still)
    t.check('the label has a label’s cursor', still?.baseCursor === 'default', still)
    // In a narrow row the label goes entirely, never an empty pill (verifier round 2, finding 10).
    t.check(
      narrow ? 'in a narrow row the label is not displayed at all' : 'in a wide row the label shows the base',
      narrow ? still?.baseDisplay === 'none' : still?.baseDisplay !== 'none' && still?.base === 'main',
      { baseDisplay: still?.baseDisplay, base: still?.base }
    )
    await clickIn(win, 'wt-still', '[data-git-base-badge="label"]')
    await win.waitForTimeout(400)
    const stillAfter = (await readRows(win)).find((r) => r.name === 'wt-still')
    t.check('clicking the label leaves the row folded', stillAfter?.collapsed === true, stillAfter)
    if (!narrow) {
      await win.hover('[data-tree-name="wt-still"] [data-git-base-badge="label"]')
      await win.waitForTimeout(300)
      const hovered = await win.evaluate(() => {
        const el = document.querySelector('[data-tree-name="wt-still"] [data-git-base-badge="label"]')
        return el ? getComputedStyle(el).backgroundColor : null
      })
      t.check('hovering the label fills nothing', hovered === 'rgba(0, 0, 0, 0)', hovered)
    }

    // The +3 opens what the worktree added.
    await clickIn(win, 'wt-feature', '[data-git-sync-tone="worktree"]')
    await until(async () => (await readSections(win)).some((s) => s.kind === 'header'))
    let sections = await readSections(win)
    const since = sections.findIndex((s) => s.kind === 'header' && s.text.startsWith('Since main'))
    t.check('the count opens a "Since main" section', since >= 0, sections)
    const sinceRows = sections.slice(since + 1).filter((s) => s.kind === 'row').map((s) => s.text)
    t.check(
      'listing the three files the worktree added',
      ['a.txt', 'b.txt', 'c.txt'].every((f) => sinceRows.some((r) => r.includes(f))) && sinceRows.length === 3,
      sinceRows
    )

    // The base badge opens what the base gained.
    await clickIn(win, 'wt-feature', '[data-git-base-badge="drift"]')
    await until(async () =>
      (await readSections(win)).some((s) => s.kind === 'header' && s.text.startsWith('Behind main'))
    )
    sections = await readSections(win)
    const behind = sections.findIndex((s) => s.kind === 'header' && s.text.startsWith('Behind main'))
    const behindRows = []
    for (const s of sections.slice(behind + 1)) {
      if (s.kind === 'header') break
      behindRows.push(s.text)
    }
    t.check('the base badge opens a "Behind main" section', behind >= 0, sections)
    t.check(
      'listing the one file the base changed',
      behindRows.length === 1 && behindRows[0].includes('base.txt'),
      behindRows
    )
    t.check('the base section has no Pull or Push action', !sections.some((s) => s.kind === 'header' && /Pull|Push/.test(s.text)), sections)
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
