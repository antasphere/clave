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
// Alphabetically after the worktree's name, so the order check has a repo
// that must NOT slip between the source and its worktree.
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

  commit(APP, 'base.txt', 'base two')
  commit(APP, 'base.txt', 'base three')

  mkdirSync(OTHER, { recursive: true })
  git(OTHER, 'init', '-q', '-b', 'main')
  commit(OTHER, 'README.md', 'zed')
}

/** The repo tree's rows in order: kind, name, and the badges each carries. */
function readRows(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-kind="repo"], [data-tree-kind="worktree"]')].map(
      (el) => ({
        kind: el.dataset.treeKind,
        name: el.dataset.treeName,
        of: el.dataset.treeWorktreeOf ?? null,
        last: el.dataset.treeWorktreeLast === 'true',
        stem: el.dataset.treeHasWorktrees === 'true',
        guide: !!el.querySelector('.git-worktree-guide'),
        base: el.querySelector('[data-git-base-badge]')?.textContent.trim() ?? null,
        baseKind: el.querySelector('[data-git-base-badge]')?.dataset.gitBaseBadge ?? null,
        worktreeCount:
          el.querySelector('[data-git-sync-tone="worktree"]')?.textContent.trim() ?? null,
        incoming: el.querySelector('[data-git-sync-tone="incoming"]')?.textContent.trim() ?? null,
        outgoing: el.querySelector('[data-git-sync-tone="outgoing"]')?.textContent.trim() ?? null
      })
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
      'the worktree sits directly under its repo, the other repo after it',
      rows.map((r) => `${r.kind}:${r.name}`).join(' ') === 'repo:app worktree:wt-feature repo:zed',
      rows
    )
    const wt = rows.find((r) => r.kind === 'worktree')
    const src = rows.find((r) => r.name === 'app')
    t.check('the worktree row names its source', wt?.of === APP, wt)
    t.check('the worktree row carries the guide, no icon, and ends the line', wt?.guide && wt?.last, wt)
    t.check('the source row draws the stem the guide continues', src?.stem === true, src)
    t.check('the base badge reads main−2', wt?.base === 'main−2' && wt?.baseKind === 'drift', wt)
    t.check('the purple count reads +3', wt?.worktreeCount === '3', wt)
    t.check('the source row has neither badge', src?.base === null && src?.worktreeCount === null, src)
    // No remote in the fixture, so nothing is incoming; the ↑ carries the
    // existing "unpublished commits" count on every row here and is not this
    // change's to assert.
    t.check('the blue badge stays off a repo with no remote', wt?.incoming === null, wt)

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
