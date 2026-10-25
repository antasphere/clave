/**
 * The git panel on a Clave server's checkout (wave wcs1023, lane C, #242).
 *
 * Two standalone daemons, each root a git repository with a bare origin
 * beside it, one Mac attached to both through the HTTP observer. The session
 * on owner one runs in that repository, and its Git tab must act on THAT
 * checkout: every git route completes on daemon one and never reaches daemon
 * two, the commit lands in owner one's working tree and its origin, and the
 * Mac's own git IPC — re-handled here to count and refuse — is never asked
 * for a write. A change on the server's disk reaches the panel through the
 * server's watch; a commit message asked of the server answers the sentence
 * about its missing Claude login (the daemon's `claude` is a signed-out
 * stub); and the draft typed for the server checkout is absent from a Mac
 * session on the same path, which keeps its own.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  ownerReady,
  clickReady,
  showMac,
  showServer,
  step
} from './fixtures/fleet-world.mjs'
import { assertFileEndpoint } from './fixtures/fleet-http-observer.mjs'
import { callMcp } from './harness.mjs'

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  }).trim()
const NOT_SIGNED_IN = "This server's Claude is not signed in"
const WRITE_CHANNELS = [
  'git:stage',
  'git:unstage',
  'git:commit',
  'git:push',
  'git:publish-branch',
  'git:pull',
  'git:discard',
  'git:magic-sync',
  'git:magic-pull',
  'git:generate-commit-message'
]

export async function run(t) {
  const world = await fleetWorld('git', { gitRepo: true })
  try {
    const report = world.load()
    const [a, b] = world.servers
    const observers = await world.observeFiles()
    const mark = () => observers.map((observer) => observer.entries.length)
    const value = report.values.first
    const mac = await world.mac('a')
    await connectMac(mac, world.servers)
    // A server's tabs show in that server's workspace (lane B): the window
    // moves to owner one's before its session row is read.
    await showServer(mac, 0)
    const { win } = mac
    const owner = mac.owners[0].id
    const session = owned('session', owner, value.sessionId)
    await ownerReady(mac, owner, session)

    // The Mac's own git IPC must never serve a server checkout. Every write
    // channel is re-handled to record and refuse, so a wrong route fails the
    // operation in the panel AND leaves a record here; a Mac repository read
    // (status, log) stays on its real handler.
    await mac.app.evaluate(({ ipcMain }, channels) => {
      globalThis.__wcsLocalGitWrites = []
      for (const channel of channels) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, ...args) => {
          globalThis.__wcsLocalGitWrites.push([channel, ...args])
          throw new Error(`The Mac's git IPC was asked for a server checkout: ${channel}`)
        })
      }
    }, WRITE_CHANNELS)
    const localWrites = () => mac.app.evaluate(() => globalThis.__wcsLocalGitWrites)

    await clickReady(win.locator(`[data-sidebar-item-id="${session}"]`))
    const tabs = win.locator('[data-panel-bar="tabs"]')
    if (!(await tabs.isVisible())) await clickReady(win.getByTitle(/^File tree/))
    const gitTab = tabs.getByRole('button', { name: 'Git', exact: true })
    await gitTab.waitFor({ state: 'visible' })
    t.check('a session on a Clave server has a Git tab', true)

    const bar = win.locator('[data-panel-bar="git"]')
    const opening = mark()
    await step('git tab shows the server repository', async () => {
      await clickReady(gitTab)
      await bar.waitFor({ state: 'visible' })
      await eventually(async () => (await bar.innerText()).includes('main'), 'branch of owner one')
    })
    assertFileEndpoint(observers, opening, 0, '/git/status')
    await eventually(
      () => observers[0].entries.some((e) => e.path === '/git/watches' && e.status === 200),
      'the panel sent the server its watch map naming the repository'
    )
    assert.deepEqual(
      observers[1].entries.filter((e) => e.path.startsWith('/git/')),
      [],
      'daemon two saw no git request'
    )
    t.check('the Git tab reads the server checkout and watches it there', true)

    // A change on the server's disk: the server's watch tells the panel.
    writeFileSync(path.join(a.root, 'from-server.txt'), 'written on the server\n')
    await step('server-side change reaches the panel', async () => {
      await win
        .locator('[data-git-row="file"]:visible')
        .getByText('from-server.txt', { exact: true })
        .first()
        .waitFor({ state: 'visible' })
    })
    t.check('a file written on the server’s disk appears in the panel', true)

    // Stage, commit and push through the panel: owner one's checkout and its
    // origin take the commit; owner two and the Mac's git IPC see nothing.
    const writing = mark()
    const message = `feat: committed from the Mac onto owner one ${world.run}`
    await step('stage, commit and push on the server', async () => {
      // The commit bar is off by default (agents commit; the panel reads).
      const showBar = win.getByRole('button', { name: 'Show commit bar', exact: true })
      if ((await showBar.count()) > 0) await clickReady(showBar.first())
      await clickReady(win.getByTitle('Include in commit', { exact: true }).first())
      const draft = win.locator('textarea[placeholder="Commit message..."]')
      await draft.waitFor({ state: 'visible' })
      await draft.fill(message)
      await clickReady(win.getByRole('button', { name: 'Commit', exact: true }))
      await eventually(
        () => git(a.root, 'log', '-1', '--format=%s') === message,
        'the commit lands in owner one’s working tree'
      )
      await clickReady(win.getByRole('button', { name: /Push/ }))
      await eventually(
        () => git(a.origin, 'log', '-1', '--format=%s') === message,
        'the push lands in owner one’s origin'
      )
    })
    // The disk shows a write before the daemon's reply has travelled back
    // through the observer: wait for the record before reading it.
    const recorded = (route, since) =>
      eventually(
        () => observers[0].entries.slice(since[0]).some((e) => e.path === route),
        `${route} recorded on daemon one`
      )
    for (const route of ['/git/stage', '/git/commit', '/git/push']) {
      await recorded(route, writing)
      assertFileEndpoint(observers, writing, 0, route)
    }
    assert.equal(git(b.root, 'log', '-1', '--format=%s'), 'init', 'owner two is untouched')
    assert.equal(
      git(b.origin, 'log', '-1', '--format=%s'),
      'init',
      'owner two’s origin is untouched'
    )
    assert.deepEqual(await localWrites(), [], 'the Mac’s git IPC was never asked for a write')
    t.check(
      'stage, commit and push act on the server’s checkout and origin, through daemon one only',
      true
    )

    // A commit message asked of the server is written by the server's claude,
    // a signed-out stub here: the panel reads one sentence about the login.
    writeFileSync(path.join(a.root, 'second.txt'), 'a second change\n')
    const generating = mark()
    await step('the server names its missing Claude login', async () => {
      await win
        .locator('[data-git-row="file"]:visible')
        .getByText('second.txt', { exact: true })
        .first()
        .waitFor({ state: 'visible' })
      await clickReady(win.locator('textarea[placeholder="Commit message..."] ~ button').first())
      await win.getByText(NOT_SIGNED_IN, { exact: false }).first().waitFor({ state: 'visible' })
    })
    await recorded('/git/generate-commit-message', generating)
    // The server REFUSED, as declared (a 422 carrying the sentence): that
    // refusal is daemon one's, and daemon two never heard the question.
    const refused = observers.map((observer, index) =>
      observer.entries
        .slice(generating[index])
        .filter((e) => e.path === '/git/generate-commit-message')
    )
    assert.ok(
      refused[0].some((e) => e.status === 422),
      `the server declared its refusal: ${JSON.stringify(refused)}`
    )
    assert.deepEqual(refused[1], [], 'daemon two was never asked for a commit message')
    const syncing = mark()
    await step('Magic sync on the server reports the same reason', async () => {
      await clickReady(win.getByRole('button', { name: 'Commit and push all', exact: true }))
      await clickReady(win.getByRole('button', { name: 'Commit and push', exact: true }))
      const progress = win.locator('[role="progressbar"][aria-label="Magic sync progress"]')
      await eventually(
        async () => ((await progress.getAttribute('aria-valuetext')) ?? '').includes('1 failed'),
        'the bar names the failed repository'
      )
      const held = progress.getByRole('button', { name: /1 failed/ })
      await held.hover()
      // The reason must be in the bar's OWN tooltip: the commit bar above
      // still shows the same sentence from the generate step, and a search of
      // the whole window would pass with the tooltip's reason removed
      // (verifier round 1, finding 6).
      const tooltip = win.locator('.panel-progress-failures')
      await tooltip.waitFor({ state: 'visible' })
      assert.ok(
        (await tooltip.innerText()).includes(NOT_SIGNED_IN),
        `the sync failure tooltip names the reason: ${await tooltip.innerText()}`
      )
    })
    await recorded('/git/magic-sync', syncing)
    assertFileEndpoint(observers, syncing, 0, '/git/magic-sync')
    assert.deepEqual(await localWrites(), [], 'Magic sync never reached the Mac’s git IPC')
    t.check(
      'a commit message on a server without a Claude login fails with one clear sentence',
      true
    )

    // The same path on both machines keeps separate panel state: a draft typed
    // for the server checkout is not the Mac session's, and comes back with it.
    const serverDraft = win.locator('textarea[placeholder="Commit message..."]')
    const draftText = 'draft kept for the server checkout'
    await serverDraft.fill(draftText)
    // Back on the Mac's own workspace, a Mac terminal on the very same path
    // (one host plays both machines here) gets the Mac's repository.
    await showMac(mac)
    const local = await callMcp(mac.app, 'openSession', { cwd: a.root, mode: 'terminal' })
    assert.ok(local?.sessionId, 'a Mac terminal opened on the same path')
    await callMcp(mac.app, 'focus', { sessionId: local.sessionId })
    await step('the Mac session on the same path has its own, empty draft', async () => {
      await eventually(async () => {
        const row = win.locator(`[data-sidebar-item-id="${local.sessionId}"]`)
        return (await row.getAttribute('data-selected')) !== null || (await row.count()) > 0
      }, 'the Mac session is in the sidebar')
      await bar.waitFor({ state: 'visible' })
      await eventually(
        async () => (await win.locator('textarea[placeholder="Commit message..."]').count()) > 0,
        'the Mac repository shows its commit bar'
      )
      await eventually(
        async () =>
          (await win.locator('textarea[placeholder="Commit message..."]').inputValue()) === '',
        'no draft of the server’s reaches the Mac repository'
      )
    })
    await showServer(mac, 0)
    await clickReady(win.locator(`[data-sidebar-item-id="${session}"]`))
    await eventually(
      async () =>
        (await win.locator('textarea[placeholder="Commit message..."]').inputValue()) === draftText,
      'the server checkout’s draft comes back with its session'
    )
    t.check('the same path on the Mac and on the server keep separate drafts', true)

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
