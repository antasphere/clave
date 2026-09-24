/**
 * Pull all pulls what the panel shows, and the refresh is what goes looking.
 *
 * Two things are checked here, and they are two halves of one promise:
 *
 *  1. ↓ acts on the ↓ badges. A repo with commits waiting on the server that
 *     nothing has fetched carries no badge, and Pull all leaves it alone — it
 *     does not sweep ninety remotes to find out, which is what used to make a
 *     click take a minute with nothing on screen.
 *  2. The refresh is the sweep, and it says so: it fetches every repo, reports
 *     on the same progress row, and the badges it lands are what makes the next
 *     ↓ complete.
 *
 * The fixture is deliberately OVER the live-poll limit (51 repos), because that
 * is the case the whole thing is about: under the limit the panel fetches every
 * 30s on its own and the badges look after themselves; over it, nothing does,
 * and the split between "pull" and "go and look" is the only thing that keeps
 * the button honest.
 *
 * The row is sampled across each run rather than queried once: a pull of one
 * repo is over in a few hundred milliseconds, and a single late query would
 * find an empty bar and call it a pass.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath
} from './harness.mjs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const DIR = userDataDir('git-batch-progress')
// /private/tmp, not /tmp: git resolves the symlink, and a repo root that
// disagrees with the discovered path makes every repo look nested.
const ROOT = fixturePath('git-batch-root', { real: true })
const ORIGINS = fixturePath('git-batch-origins', { real: true })
// Over the default live-poll limit of 50, so the panel pauses: no background
// fetch, and therefore no badge nobody asked for.
const PADDING = 48
const TOTAL_REPOS = PADDING + 3

const WS = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  name: 'Batch',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })

function seedRepos() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(ORIGINS, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(ORIGINS, { recursive: true })

  // Three repos that matter: one behind and badged, one behind on the server
  // with nobody aware of it, one level with its remote.
  for (const name of ['known-behind', 'stale-behind', 'up-to-date']) {
    const bare = path.join(ORIGINS, `${name}.git`)
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' })

    const repo = path.join(ROOT, name)
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`)
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    if (name === 'up-to-date') continue

    const work = path.join(ORIGINS, `${name}-push`)
    execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' })
    writeFileSync(path.join(work, 'incoming.txt'), `from the remote: ${name}\n`)
    git(work, 'add', '-A')
    git(work, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'remote work')
    git(work, 'push', '-q')

    // Only this one fetches — so only this one carries a ↓.
    if (name === 'known-behind') git(repo, 'fetch', '-q')
  }

  // Padding, to push the folder over the live-poll limit. They share one empty
  // bare remote so the refresh sweep has something real to talk to for each.
  const shared = path.join(ORIGINS, 'padding.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', shared], { stdio: 'ignore' })
  for (let i = 0; i < PADDING; i++) {
    const repo = path.join(ROOT, `padding-${String(i).padStart(2, '0')}`)
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'README.md'), `# padding ${i}\n`)
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=e2e@clave', '-c', 'user.name=e2e', 'commit', '-qm', 'init')
    git(repo, 'remote', 'add', 'origin', shared)
  }
}

/** Sample the progress row on every frame for `ms`, starting NOW. */
function startSampling(win, ms) {
  return win.evaluate((duration) => {
    window.__batchSamples = []
    const started = performance.now()
    const tick = () => {
      const row = document.querySelector('.panel-bar-progress')
      if (row) {
        const bar = row.closest('.panel-bar')
        const button = document.querySelector('[aria-label="Pull all"]')
        const fill = row.querySelector('.panel-progress-fill')
        const track = row.querySelector('.panel-progress-track')
        const rowBox = row.getBoundingClientRect()
        const barBox = bar?.getBoundingClientRect() ?? null
        const btnBox = button?.getBoundingClientRect() ?? null
        window.__batchSamples.push({
          count: row.querySelector('.panel-progress-count')?.textContent?.trim() ?? '',
          fillFraction:
            fill && track && track.getBoundingClientRect().width > 0
              ? fill.getBoundingClientRect().width / track.getBoundingClientRect().width
              : 0,
          indeterminate: !!track?.classList.contains('is-indeterminate'),
          inSameBar: !!bar && !!button && bar.contains(button),
          belowButton: !!btnBox && rowBox.top >= btnBox.bottom - 1,
          widthShare: barBox && barBox.width > 0 ? rowBox.width / barBox.width : 0,
          op: row.getAttribute('data-op')
        })
      }
      if (performance.now() - started < duration) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  }, ms)
}

const samples = (win) => win.evaluate(() => window.__batchSamples ?? [])

/** What each repo's own status says — the numbers the badges are drawn from. */
function repoState(win, root) {
  return win.evaluate(async (r) => {
    const names = ['known-behind', 'stale-behind', 'up-to-date']
    const statuses = await window.electronAPI.getGitStatusBatch(names.map((n) => `${r}/${n}`))
    return Object.fromEntries(
      statuses.map((s, i) => [names[i], { behind: s.status.behind, ahead: s.status.ahead }])
    )
  }, root)
}

export async function run(t) {
  seedRepos()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'batch' })
    await win.waitForTimeout(2000)
    await win.click('button[title^="File tree"]')
    await win.waitForTimeout(1200)
    await win.click('.panel-tab:has-text("Git")')
    await win.waitForTimeout(3000)

    // ── The fixture is the case this feature is about ──────────────────────
    const opening = await win.evaluate(() => ({
      button: !!document.querySelector('[aria-label="Pull all"]'),
      row: !!document.querySelector('.panel-bar-progress'),
      label: document.querySelector('[data-panel-bar="git"] .panel-bar-label')?.textContent ?? '',
      paused: !!document.querySelector('[data-git-footnote]'),
      refresh: !!document.querySelector('.git-footnote-action')
    }))
    t.check('the git bar offers Pull all', opening.button, opening)
    t.check('and shows no progress row at rest', opening.row === false, opening)
    t.check(
      `the panel found all ${TOTAL_REPOS} repos`,
      opening.label.includes(`${TOTAL_REPOS} repos`),
      opening.label
    )
    t.check('live updates are paused at this size', opening.paused, opening)
    t.check('so the panel offers a refresh of its own', opening.refresh, opening)

    const before = await repoState(win, ROOT)
    t.check(
      'one repo is visibly behind, the stale one is not',
      before['known-behind'].behind > 0 && before['stale-behind'].behind === 0,
      before
    )

    // ── ↓ pulls what is badged, and only that ─────────────────────────────
    await startSampling(win, 6000)
    await win.click('[aria-label="Pull all"]')
    await win.waitForTimeout(6200)

    const pullSamples = await samples(win)
    const pullCounts = pullSamples.map((s) => s.count)
    t.check('the progress row appeared for the pull', pullSamples.length > 0, {
      samples: pullSamples.length
    })
    const fraction = pullCounts.find((c) => /^\d+\/\d+$/.test(c))
    t.check('the count reads X/N', !!fraction, pullCounts.slice(0, 12))
    t.equal(
      'and N is the ONE badged repo, not the whole tree',
      fraction?.split('/')[1],
      String(1)
    )
    t.check(
      'it reports which op is running',
      pullSamples.some((s) => s.op === 'pull'),
      pullSamples[0]?.op
    )
    const pullSummary = pullCounts.find((c) => /pulled|up to date|failed/.test(c))
    t.check('the summary lands on the row', !!pullSummary, pullCounts.slice(-6))
    t.check('and says exactly one repo was pulled', pullSummary?.includes('1 pulled'), pullSummary)

    const afterPull = await repoState(win, ROOT)
    t.check(
      'the badged repo is level with its remote now',
      afterPull['known-behind'].behind === 0,
      afterPull
    )
    // The point of the whole design: the unfetched repo was NOT swept.
    const staleUntouched = await win.evaluate((root) =>
      window.electronAPI
        .gitLog(`${root}/stale-behind`, 10)
        .then((entries) => entries.map((e) => e.message))
    , ROOT)
    t.check(
      'the repo nothing had fetched was left alone — no sweep',
      !staleUntouched.includes('remote work'),
      staleUntouched
    )

    // ── The refresh is the half that goes looking ─────────────────────────
    await startSampling(win, 30000)
    await win.click('.git-footnote-action')
    await win.waitForTimeout(30000)

    const fetchSamples = await samples(win)
    const fetchCounts = fetchSamples.map((s) => s.count)
    t.check('the refresh draws on the same row', fetchSamples.length > 0, {
      samples: fetchSamples.length
    })
    t.check(
      'and reports itself as the fetch sweep',
      fetchSamples.some((s) => s.op === 'fetch'),
      [...new Set(fetchSamples.map((s) => s.op))]
    )
    const fetchFraction = fetchCounts.find((c) => /^\d+\/\d+$/.test(c))
    t.equal(
      'this one IS every repo in the tree',
      fetchFraction?.split('/')[1],
      String(TOTAL_REPOS)
    )
    const fetchNumerators = fetchCounts
      .map((c) => /^(\d+)\/\d+$/.exec(c))
      .filter(Boolean)
      .map((m) => Number(m[1]))
    t.check(
      'the counter advances across the sweep',
      fetchNumerators.some((n) => n > 0),
      fetchCounts.filter((c) => /^\d+\/\d+$/.test(c)).slice(0, 10)
    )
    t.check(
      'the fill grows partway before it finishes',
      fetchSamples.some((s) => s.fillFraction > 0.05 && s.fillFraction < 0.99 && !s.indeterminate),
      fetchSamples.map((s) => Number(s.fillFraction.toFixed(2))).slice(0, 20)
    )
    t.check(
      'and lands full',
      fetchSamples.some((s) => s.fillFraction > 0.99),
      { max: Math.max(...fetchSamples.map((s) => s.fillFraction)) }
    )

    // Placement, on whichever op happened to be sampled.
    const placed = [...pullSamples, ...fetchSamples].filter((s) => s.widthShare > 0)
    t.check(
      'the row sits in the same bar as the button',
      placed.length > 0 && placed.every((s) => s.inSameBar),
      placed[0]
    )
    t.check('under it, not beside it', placed.length > 0 && placed.every((s) => s.belowButton), placed[0])
    t.check(
      "and takes most of the bar's width",
      placed.length > 0 && placed.every((s) => s.widthShare > 0.8),
      placed.map((s) => s.widthShare).slice(0, 5)
    )

    // ── What the sweep found, ↓ can now pull ──────────────────────────────
    const afterFetch = await repoState(win, ROOT)
    t.check(
      'the sweep made the stale repo visibly behind',
      afterFetch['stale-behind'].behind > 0,
      afterFetch
    )

    await startSampling(win, 6000)
    await win.click('[aria-label="Pull all"]')
    await win.waitForTimeout(6200)
    const secondSummary = (await samples(win))
      .map((s) => s.count)
      .find((c) => /pulled|up to date|failed/.test(c))
    t.check('a second pull takes the newly found commits', secondSummary?.includes('1 pulled'), secondSummary)

    const finally_ = await repoState(win, ROOT)
    t.check(
      'every repo is level with its remote now',
      Object.values(finally_).every((r) => r.behind === 0),
      finally_
    )

    // The row clears itself once its summary has been read.
    await win.waitForTimeout(500)
    const rowGone = await win.evaluate(() => !!document.querySelector('.panel-bar-progress'))
    t.check('the row clears itself afterwards', rowGone === false, rowGone)
  } finally {
    await app.close()
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(ORIGINS, { recursive: true, force: true })
  }
}
