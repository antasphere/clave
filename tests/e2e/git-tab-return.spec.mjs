/**
 * The git tab comes back as it was, and learns of a commit on its own
 * (PRDCT-3776, PRDCT-3775).
 *
 * 1. Files → Git used to reset the panel to its loading state and wait for
 *    every repo to be read again. Now the rows are there in the first frame
 *    after the switch.
 * 2. A commit in a worktree reaches its row through the repo watcher, well
 *    inside the thirty-second safety-net timer the panel keeps once every
 *    repo is watched.
 *
 * `/private/tmp` rather than `/tmp`, so git's resolved repo root matches the
 * discovered path.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  until,
  fixturePath
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('git-tab-return-data')
const ROOT = fixturePath('git-tab-return', { real: true })
const APP = path.join(ROOT, 'app')
const LIB = path.join(ROOT, 'lib')
const WT = path.join(ROOT, 'wt-lane')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000003f',
  name: 'Git tab return',
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
  for (const repo of [APP, LIB]) {
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, 'README.md', `seed ${path.basename(repo)}`)
  }
  git(APP, 'worktree', 'add', '-q', WT, '-b', 'lane', 'main')
}

const openTab = (win, label) =>
  win.evaluate((label) => {
    ;[...document.querySelectorAll('.panel-tab')]
      .find((b) => b.textContent.trim() === label)
      ?.click()
  }, label)

const rowNames = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('[data-tree-kind="repo"], [data-tree-kind="worktree"]')].map(
      (el) => el.dataset.treeName
    )
  )

const worktreeCount = (win) =>
  win.evaluate(
    () =>
      document
        .querySelector('[data-tree-kind="worktree"] [data-git-sync-tone="worktree"]')
        ?.textContent.trim() ?? null
  )

export async function run(t) {
  seed()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1500)
    await openTab(win, 'Git')
    await until(async () => (await rowNames(win)).length === 3)
    t.check('the git tab lists the two repos and the worktree', true, await rowNames(win))

    await openTab(win, 'Files')
    await win.waitForTimeout(500)
    // Back to Git, counted in the first frame the switch draws.
    const firstFrame = await win.evaluate(
      () =>
        new Promise((resolve) => {
          ;[...document.querySelectorAll('.panel-tab')]
            .find((b) => b.textContent.trim() === 'Git')
            ?.click()
          requestAnimationFrame(() =>
            resolve(
              document.querySelectorAll('[data-tree-kind="repo"], [data-tree-kind="worktree"]')
                .length
            )
          )
        })
    )
    t.check('back on the git tab, the rows are there in the first frame', firstFrame === 3, {
      firstFrame
    })

    // Let the watch come up, then commit in the worktree.
    await win.waitForTimeout(1500)
    const before = await worktreeCount(win)
    commit(WT, 'a.txt', 'lane a')
    const started = Date.now()
    let after = before
    await until(async () => (after = await worktreeCount(win)) === '1', { tries: 40, gapMs: 250 })
    const took = Date.now() - started
    t.check(
      'a commit in the worktree reaches its row within a few seconds, not the thirty-second timer',
      after === '1' && took < 10_000,
      { before, after, took }
    )
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
  }
}
