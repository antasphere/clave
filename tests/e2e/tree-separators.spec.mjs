/**
 * The rules between rows, and the one setting that owns their weight.
 *
 * Two things this covers:
 *
 * 1. A repo's CONTENTS were the one list in the panel that drew no rules at
 *    all — the repo tree above them was ruled, the Files tab beside them was
 *    ruled, and the changed files inside a repo ran together. Both view modes
 *    rule now, by the same sentence as the trees above: a rule above every row
 *    but the first of its section, at that row's own indentation.
 * 2. Appearance → Tree separators sets the weight of every one of them at once.
 *    The mechanism is one custom property on the root element, which is what
 *    lets "all the trees" be a claim rather than a hope: the Files tab and the
 *    git panel resolve the same --rule-color, so the check that they match is
 *    the check that nothing drew its own line.
 *
 * `/private/tmp` rather than `/tmp`, so git's resolved repo root matches the
 * discovered path (the symlink otherwise reparents every repo).
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// The user-data dir and the fixture must not be the same folder: /tmp is a
// symlink to /private/tmp, so two names that look distinct can land on one.
const DIR = userDataDir('tree-separators-data')
const ROOT = fixturePath('tree-rules', { real: true })
const REPO = path.join(ROOT, 'app')
// A second repo, so the repo TREE has a pair of rows to rule as well — with one
// repo it draws no rule at all and the "every tree" claim would go unchecked.
const SECOND_REPO = path.join(ROOT, 'lib', 'tool')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'Rules',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** One repo, dirty in three sections so the panel renders more than one block,
 *  under a root with enough beside it that the Files tab has rows to rule. */
function seedRepo() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(path.join(ROOT, 'notes'), { recursive: true })
  writeFileSync(path.join(ROOT, 'notes', 'one.md'), 'one\n')
  writeFileSync(path.join(ROOT, 'top.md'), 'top\n')
  mkdirSync(path.join(REPO, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { stdio: 'ignore' })
  writeFileSync(path.join(REPO, 'README.md'), '# app\n')
  writeFileSync(path.join(REPO, 'src', 'one.txt'), 'one\n')
  writeFileSync(path.join(REPO, 'src', 'two.txt'), 'two\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
  writeFileSync(path.join(REPO, 'README.md'), '# app\n\nedited\n')
  writeFileSync(path.join(REPO, 'src', 'one.txt'), 'one edited\n')
  writeFileSync(path.join(REPO, 'src', 'two.txt'), 'two edited\n')
  writeFileSync(path.join(REPO, 'untracked.txt'), 'new\n')
  git('add', 'src/one.txt')

  mkdirSync(SECOND_REPO, { recursive: true })
  const git2 = (...args) => execFileSync('git', ['-C', SECOND_REPO, ...args], { stdio: 'ignore' })
  writeFileSync(path.join(SECOND_REPO, 'README.md'), '# tool\n')
  git2('init', '-q', '-b', 'main')
  git2('add', '-A')
  git2('-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
}

/** Rows, rules and section headers of the git panel's contents, in order. */
function readContents(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[data-git-row], [data-git-file-rule], .git-section-header')].map(
      (el) =>
        el.hasAttribute('data-git-file-rule')
          ? { kind: 'rule' }
          : el.classList.contains('git-section-header')
            ? { kind: 'header', name: el.textContent.trim() }
            : { kind: 'row', name: el.textContent.trim() }
    )
  )
}

/** Every row but a section's first is ruled off from the row above it. */
function ruleProblems(seq) {
  const problems = []
  let previous = null
  for (const entry of seq) {
    if (entry.kind === 'header') {
      previous = null
      continue
    }
    if (entry.kind === 'rule') {
      if (previous === null) problems.push('rule above a section’s first row')
      if (previous === 'rule') problems.push('two rules in a row')
      previous = 'rule'
      continue
    }
    if (previous === 'row') problems.push(`no rule above ${entry.name}`)
    previous = 'row'
  }
  return problems
}

/** The colour a tree's hairline actually resolves to, per surface. */
function readRuleColors(win) {
  return win.evaluate(() => {
    const colorOf = (selector) => {
      const el = document.querySelector(selector)
      return el ? getComputedStyle(el).backgroundColor : null
    }
    return {
      intensity: getComputedStyle(document.documentElement)
        .getPropertyValue('--rule-intensity')
        .trim(),
      git: colorOf('[data-git-file-rule]'),
      repoTree: colorOf('[data-tree-rule]'),
      files: colorOf('[data-file-tree-rule]')
    }
  })
}

/** Alpha of an rgb()/rgba() string — 1 when it carries no alpha at all. */
function alphaOf(color) {
  if (!color) return null
  if (color === 'rgba(0, 0, 0, 0)') return 0
  const parts = color.match(/[\d.]+/g)
  return parts && parts.length === 4 ? Number(parts[3]) : 1
}

/** Put the git panel in one of its two view modes. The bar carries a single
 *  toggle button, labelled with the mode it would switch TO, so asking for the
 *  mode already showing is a no-op rather than a flip. */
async function setGitViewMode(win, mode) {
  await win.evaluate((wanted) => {
    document.querySelector(`[data-panel-bar="git"] [aria-label="${wanted} view"]`)?.click()
  }, mode)
  await win.waitForTimeout(2000)
}

/** Pick a weight in Appearance → Tree separators. */
async function pickWeight(win, label) {
  await win.evaluate(() => {
    document.querySelector('.sidebar-footer-btn[aria-label="Settings"]')?.click()
  })
  await win.waitForTimeout(600)
  await win.evaluate(() => {
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Appearance')
      ?.click()
  })
  await win.waitForTimeout(600)
  await win.evaluate((wanted) => {
    ;[...document.querySelectorAll('.segmented-item')]
      .find((b) => b.textContent.trim() === wanted)
      ?.click()
  }, label)
  await win.waitForTimeout(500)
}

export async function run(t) {
  seedRepo()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(2000)

    // The Files tab first: its rules are the reference the git panel must match.
    const fileRules = await win.evaluate(
      () => document.querySelectorAll('[data-file-tree-rule]').length
    )
    t.check('the Files tab rules its rows', fileRules > 0, fileRules)

    // ── The git tab ───────────────────────────────────────────────────────
    await win.evaluate(() => {
      ;[...document.querySelectorAll('.panel-tab')]
        .find((b) => b.textContent.trim() === 'Git')
        ?.click()
    })
    await win.waitForTimeout(6000)
    // A lone repo unfolds itself; click only if this one did not.
    if ((await win.evaluate(() => document.querySelectorAll('[data-git-row]').length)) === 0) {
      await win.evaluate(() => document.querySelector('[data-tree-kind="repo"]')?.click())
      await win.waitForTimeout(3000)
    }

    // Both modes are checked because they are two different row components, and
    // a rule added to one is not in the other.
    await setGitViewMode(win, 'Tree')
    const treeSeq = await readContents(win)
    const treeRows = treeSeq.filter((e) => e.kind === 'row')
    t.check('the repo unfolded to its changed files', treeRows.length >= 3, treeSeq)
    t.check(
      'tree mode rules them apart',
      treeSeq.filter((e) => e.kind === 'rule').length > 0,
      treeSeq
    )
    t.check(
      'every pair of rows in a section, and no rule anywhere else',
      ruleProblems(treeSeq).length === 0,
      ruleProblems(treeSeq)
    )

    t.check(
      'tree mode is showing — it has folder rows',
      await win.evaluate(() => document.querySelectorAll('[data-git-row="dir"]').length > 0),
      treeSeq
    )

    await setGitViewMode(win, 'List')
    const listSeq = await readContents(win)
    t.equal(
      'list mode is showing — no folder rows left',
      await win.evaluate(() => document.querySelectorAll('[data-git-row="dir"]').length),
      0
    )
    t.check(
      'list mode rules its rows too',
      listSeq.filter((e) => e.kind === 'rule').length > 0,
      listSeq
    )
    t.check('by the same sentence', ruleProblems(listSeq).length === 0, ruleProblems(listSeq))

    // ── One weight for every tree ─────────────────────────────────────────
    const normal = await readRuleColors(win)
    t.equal('the default intensity is 1', normal.intensity, '1')
    t.check(
      'all three trees draw the same hairline',
      normal.git && normal.git === normal.repoTree && normal.git === normal.files,
      normal
    )

    await pickWeight(win, 'Strong')
    const strong = await readRuleColors(win)
    t.check('Strong raises the weight of the line', alphaOf(strong.git) > alphaOf(normal.git), {
      normal: normal.git,
      strong: strong.git
    })
    t.check(
      'and raises it in every tree at once',
      strong.git === strong.repoTree && strong.git === strong.files,
      strong
    )

    await pickWeight(win, 'Off')
    const off = await readRuleColors(win)
    t.equal('Off draws no line at all', alphaOf(off.git), 0)
    t.equal('in the Files tab as well', alphaOf(off.files), 0)

    await pickWeight(win, 'Soft')
    const soft = await readRuleColors(win)
    t.check(
      'Soft sits between Off and the default',
      alphaOf(soft.git) > 0 && alphaOf(soft.git) < alphaOf(normal.git),
      {
        soft: soft.git,
        normal: normal.git
      }
    )
  } finally {
    await app.close()
  }

  // ── And the choice survives a restart ───────────────────────────────────
  await new Promise((r) => setTimeout(r, 1200))
  const second = await launchApp(DIR)
  try {
    t.equal(
      'the chosen weight is remembered',
      await second.win.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--rule-intensity').trim()
      ),
      '0.55'
    )
  } finally {
    await second.app.close()
  }
}
