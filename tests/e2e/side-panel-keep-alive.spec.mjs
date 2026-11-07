/**
 * A visited side panel tab stays loaded (PRDCT-4142).
 *
 * Files, Git and the GitHub pane are three panes of one panel. Switching
 * between them used to tear the pane you left down and rebuild the one you
 * came back to: the git list came back with every row folded, the GitHub
 * pane read its pull request again through `gh` and dropped the comment being
 * typed, and a visit to the GitHub pane threw the file tree away too. Now
 * every pane visited stays mounted and is hidden in place, so a return shows
 * it as it was left and reads nothing.
 *
 * The proof is on the DOM: the very elements of each pane are the same
 * objects after the round trip (a remount would make new ones), the open row
 * is still open in the FIRST frame after the switch, the list is scrolled
 * where it was left, the log view shows no spinner, the comment is still in
 * the composer, and the `gh` stub was asked for the pull request exactly once.
 *
 * The first open of the Git tab is read in stages: every row is there by name
 * before any status, a worktree already under its repository, in the order
 * that holds once the statuses land; a row clicked while still reading opens
 * without harm. `git status` is slowed on the PATH while that is observed.
 *
 * `/private/tmp` rather than `/tmp`, so git's resolved repo root matches the
 * discovered path. `gh` on the PATH is a stub answering from the fixtures and
 * recording every call, the way github-pull-panel.spec.mjs does it.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  until,
  fixturePath,
  REPO
} from './harness.mjs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('side-panel-keep-alive-data')
const ROOT = fixturePath('side-panel-keep-alive', { real: true })
const APP = path.join(ROOT, 'app')
const LIB = path.join(ROOT, 'lib')
const WT = path.join(ROOT, 'wt-lane')
// Enough rows to overflow the list at the window height set below.
const MORE = Array.from({ length: 38 }, (_, i) => `r${String(i + 3).padStart(2, '0')}`)
const BIN = fixturePath('side-panel-keep-alive-bin')
const CALLS = `${BIN}/gh-calls.jsonl`
const SLOW_STATUS = `${BIN}/slow-status`
const REAL_GIT = '/usr/bin/git'
const PULL_URL = 'https://github.com/acme/widgets/pull/42'
const COMMENT = 'Half a thought, left in the composer'
const WS = {
  id: 'eeeeeeee-0000-4000-8000-000000000041',
  name: 'Side panel keep-alive',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
const commit = (cwd, file, message) => {
  writeFileSync(path.join(cwd, file), `${message}\n`)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', message)
}

function seed() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const repo of [APP, LIB, ...MORE.map((name) => path.join(ROOT, name))]) {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, 'README.md', `seed ${path.basename(repo)}`)
    // Dirty, so an open row has a file list to show.
    writeFileSync(path.join(repo, 'notes.md'), 'work in progress\n')
  }
  git(APP, 'worktree', 'add', '-q', WT, '-b', 'lane', 'main')
}

function writeStubs() {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  // A login shell fixture preserves the stub-first PATH instead of the host's path_helper.
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // git itself, with `status` held back while the marker file exists: long
  // enough for the rows to be seen before their statuses, short enough for
  // forty of them to land within the run.
  writeFileSync(
    `${BIN}/git`,
    `#!/bin/sh\ncase " $* " in *" status "*) [ -f "${SLOW_STATUS}" ] && sleep 0.6 ;; esac\nexec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 }
  )
  writeFileSync(SLOW_STATUS, '')
  const fixture = (name) => JSON.stringify(path.join(REPO, 'tests/e2e/fixtures/github', name))
  writeFileSync(
    `${BIN}/gh`,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args }) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(fs.readFileSync(${fixture('pull-42.json')}, 'utf8'));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {
  process.stdout.write(fs.readFileSync(${fixture('pull-42.diff')}, 'utf8'));
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  )
}

const viewCalls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((call) => call.args[0] === 'pr' && call.args[1] === 'view').length
    : 0

const openTab = (win, label) =>
  win.evaluate((label) => {
    ;[...document.querySelectorAll('.panel-tab')]
      .find((b) => b.textContent.trim() === label)
      ?.click()
  }, label)

/** Click a tab and read the panel in the first frame the switch draws. The
 *  readers live inside the page function: the renderer's content policy
 *  allows no evaluated source, so a reader cannot travel as text. */
const openTabFirstFrame = (win, label, what) =>
  win.evaluate(
    ([label, what]) =>
      new Promise((resolve) => {
        ;[...document.querySelectorAll('.panel-tab')]
          .find((b) => b.textContent.trim() === label)
          ?.click()
        requestAnimationFrame(() => {
          if (what === 'app-row-open') {
            resolve(
              document.querySelector('[data-tree-kind="repo"][data-tree-name="app"]')?.dataset
                .treeCollapsed === undefined
            )
            return
          }
          if (what === 'git-list') {
            const pane = document.querySelector('[data-pane="git"]')
            const text = pane?.textContent ?? ''
            resolve({
              appOpen:
                document.querySelector('[data-tree-kind="repo"][data-tree-name="app"]')?.dataset
                  .treeCollapsed === undefined,
              scrollTop: pane?.querySelector('.git-repo-list')?.scrollTop ?? null,
              logLoading: text.includes('Loading history'),
              logShown: text.includes('seed app')
            })
            return
          }
          resolve({
            title: document.querySelector('[data-testid="pr-title"]')?.textContent ?? null,
            loading: document.querySelector('.pr-loading') !== null,
            draft: document.querySelector('[data-testid="pr-composer"]')?.value ?? null
          })
        })
      }),
    [label, what]
  )

/** Every repository and worktree row, in the list's order, with what it is. */
const rows = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-kind="repo"], [data-tree-kind="worktree"]')].map(
      (el) => ({
        name: el.dataset.treeName,
        kind: el.dataset.treeKind,
        of: el.dataset.treeWorktreeOf ?? null,
        reading: el.dataset.treeReading === 'true',
        open: el.dataset.treeCollapsed === undefined
      })
    )
  )
const gitList = (win) =>
  win.evaluate(() => {
    const list = document.querySelector('[data-pane="git"] .git-repo-list')
    return list
      ? {
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight
        }
      : null
  })
const appRowOpen = (win) =>
  win.evaluate(
    () =>
      document.querySelector('[data-tree-kind="repo"][data-tree-name="app"]')?.dataset
        .treeCollapsed === undefined
  )
const paneState = (win) =>
  win.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.panel-pane')].map((el) => [
        el.dataset.pane,
        el.dataset.active === 'true'
      ])
    )
  )
/** Remember the pane elements as they are now, to compare identities later. */
const stashPanes = (win) =>
  win.evaluate(() => {
    window.__panes = {
      files: document.querySelector('[data-pane="files"] > *'),
      git: document.querySelector('[data-pane="git"] .git-repo-list'),
      pr: document.querySelector('[data-testid="pr-panel"]')
    }
  })
const samePanes = (win) =>
  win.evaluate(() => ({
    files: window.__panes.files === document.querySelector('[data-pane="files"] > *'),
    git: window.__panes.git === document.querySelector('[data-pane="git"] .git-repo-list'),
    pr: window.__panes.pr === document.querySelector('[data-testid="pr-panel"]')
  }))

export async function run(t) {
  seed()
  writeStubs()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR, {
    env: { SHELL: `${BIN}/bash`, PATH: `${BIN}:${process.env.PATH}` }
  })
  try {
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1500)
    const initial = await paneState(win)
    t.check(
      'Files is the active pane; the git pane is mounted beside it, hidden; no plugin pane yet',
      initial.files === true && initial.git === false && !('plugin:pull-request' in initial),
      initial
    )

    // A window short enough for forty rows to overflow the list.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1100, 560)
    })
    await win.waitForTimeout(300)

    // Git, read in stages: the rows by name before any status, the worktree
    // already under its repository, a row clicked while reading.
    await openTab(win, 'Git')
    const total = MORE.length + 3 // app, lib, the worktree, and the rest
    await until(async () => (await rows(win)).length === total, { tries: 80, gapMs: 250 })
    const early = await rows(win)
    t.check(
      'every row is listed by name before its status has been read',
      early.length === total && early.some((r) => r.reading),
      { rows: early.length, reading: early.filter((r) => r.reading).length }
    )
    const worktreeEarly = early.find((r) => r.name === 'wt-lane')
    t.check(
      'the worktree hangs under its repository from the first frame, before its status',
      worktreeEarly?.kind === 'worktree' &&
        early.findIndex((r) => r.name === 'app') + 1 === early.indexOf(worktreeEarly),
      worktreeEarly
    )
    const readingRow = early.find((r) => r.reading && r.kind === 'repo' && r.name.startsWith('r'))
    if (readingRow) {
      await win.click(`[data-tree-kind="repo"][data-tree-name="${readingRow.name}"]`)
      await win.waitForTimeout(300)
      const afterClick = await rows(win)
      t.check(
        'a row clicked while still reading opens without harm to the list',
        afterClick.length === total &&
          afterClick.find((r) => r.name === readingRow.name)?.open === true,
        { clicked: readingRow.name, rows: afterClick.length }
      )
    } else {
      t.check('a row was still reading when the list appeared', false, early)
    }
    await until(async () => (await rows(win)).every((r) => !r.reading), { tries: 120, gapMs: 250 })
    rmSync(SLOW_STATUS, { force: true })
    const settled = await rows(win)
    t.check(
      'the rows keep the order they appeared in once every status has landed',
      settled.map((r) => r.name).join(',') === early.map((r) => r.name).join(','),
      { early: early.map((r) => r.name).join(','), settled: settled.map((r) => r.name).join(',') }
    )
    if (readingRow) {
      const opened = await win.evaluate(
        (name) =>
          document
            .querySelector(`[data-tree-kind="repo"][data-tree-name="${name}"]`)
            ?.parentElement?.textContent.includes('notes.md') ?? false,
        readingRow.name
      )
      t.check('and the row opened while reading shows its files once its status landed', opened)
    }

    // The app row open, in log mode, and the list scrolled to its end.
    await win.click('[data-tree-kind="repo"][data-tree-name="app"]')
    await until(() => appRowOpen(win))
    t.check('the app row is open on the git tab', await appRowOpen(win))
    await win.click('[data-panel-bar="git"] button[aria-label="Commit log"]')
    await until(async () =>
      win.evaluate(() => {
        const text = document.querySelector('[data-pane="git"]')?.textContent ?? ''
        return text.includes('seed app') && !text.includes('Loading history')
      })
    )
    await win.evaluate(() => {
      const list = document.querySelector('[data-pane="git"] .git-repo-list')
      list.scrollTop = list.scrollHeight
    })
    const scrolledTo = await gitList(win)
    t.check('the list overflows and was scrolled to its end', scrolledTo.scrollTop > 0, scrolledTo)

    // Straight to Files and back: the hidden git list gets a taller box behind
    // Files (no controls row there) and is clamped while hidden; the first
    // frame back must read the position it was left at.
    await openTab(win, 'Files')
    await win.waitForTimeout(300)
    const hidden = await gitList(win)
    const backFromFiles = await openTabFirstFrame(win, 'Git', 'git-list')
    t.check(
      'back from Files, the list is scrolled where it was left in the first frame',
      backFromFiles.scrollTop === scrolledTo.scrollTop,
      { left: scrolledTo.scrollTop, hidden: hidden?.scrollTop, back: backFromFiles.scrollTop }
    )

    // GitHub: a pull request pasted into the empty state, a comment started.
    await until(async () =>
      win.evaluate(() =>
        [...document.querySelectorAll('.panel-tab')].some((b) => b.textContent.trim() === 'GitHub')
      )
    )
    await openTab(win, 'GitHub')
    await win.fill('[data-testid="pr-empty"] input', PULL_URL)
    await win.press('[data-testid="pr-empty"] input', 'Enter')
    await win.waitForSelector('[data-testid="pr-title"]')
    await win.fill('[data-testid="pr-composer"]', COMMENT)
    const viewsAfterOpen = viewCalls()
    t.check('the pull request was read once through gh', viewsAfterOpen === 1, { viewsAfterOpen })
    await stashPanes(win)
    const withPlugin = await paneState(win)
    t.check(
      'with the GitHub pane active, Files and Git are still mounted, hidden',
      withPlugin['plugin:pull-request'] === true &&
        withPlugin.files === false &&
        withPlugin.git === false,
      withPlugin
    )

    // Files again: the tree is the same element it was before the GitHub visit.
    await openTab(win, 'Files')
    await win.waitForTimeout(300)
    const afterFiles = await samePanes(win)
    t.check(
      'back on Files, the tree, the git list and the pull request pane are the same elements',
      afterFiles.files && afterFiles.git && afterFiles.pr,
      afterFiles
    )

    // Git again: the app row is open, its log shown without a spinner and the
    // list scrolled where it was left, all in the FIRST frame after the switch.
    const gitFirstFrame = await openTabFirstFrame(win, 'Git', 'git-list')
    t.check(
      'back on Git, the app row is still open in the first frame',
      gitFirstFrame.appOpen === true,
      {
        gitFirstFrame
      }
    )
    t.check(
      'the log view is on screen in the first frame with no spinner',
      gitFirstFrame.logShown && !gitFirstFrame.logLoading,
      gitFirstFrame
    )
    t.check(
      'the list is scrolled where it was left',
      gitFirstFrame.scrollTop === scrolledTo.scrollTop,
      { left: scrolledTo.scrollTop, back: gitFirstFrame.scrollTop }
    )

    // GitHub again: the record is on screen at once, the comment intact, no new read.
    const prFirstFrame = await openTabFirstFrame(win, 'GitHub', 'pr-state')
    t.check(
      'back on GitHub, the pull request is on screen in the first frame with no loading state',
      prFirstFrame.title !== null && prFirstFrame.loading === false,
      prFirstFrame
    )
    t.check('the comment being typed is still in the composer', prFirstFrame.draft === COMMENT, {
      draft: prFirstFrame.draft
    })
    await win.waitForTimeout(500)
    const viewsAfterReturn = viewCalls()
    t.check(
      'coming back to the GitHub pane asked gh for nothing',
      viewsAfterReturn === viewsAfterOpen,
      { viewsAfterOpen, viewsAfterReturn }
    )
    const finalPanes = await samePanes(win)
    t.check(
      'after the round trip every pane is still the same element',
      finalPanes.files && finalPanes.git && finalPanes.pr,
      finalPanes
    )
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(BIN, { recursive: true, force: true })
  }
}
