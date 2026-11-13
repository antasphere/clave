/**
 * The git panel across a server restart (wave wcs1023, lane C, #242; the
 * verifier's V7-F1). A Mac's watch map is in flight to a daemon when that
 * daemon restarts: the old daemon's late answer must not make the panel
 * believe the new daemon watches its folder. The order the network would
 * only produce by accident is produced on purpose through the HTTP observer:
 * the daemon's reply to the panel's first map is held, the daemon restarts,
 * the Mac reconnects and sends its map to the new daemon, which is held too,
 * and only then does the old reply reach the Mac. A change made on the server
 * while the new daemon watches nothing must still reach the panel on its
 * five-second poll (the answer that crossed the connection counts for
 * nothing), not on the thirty-second backstop a "watched" answer would set.
 * Once the held map is released, changes arrive through the server's watch
 * again.
 *
 * The panel hangs from a FILE TAB of the server's checkout rather than from
 * the server session: the session ends with the daemon and its row goes, the
 * tab is the Mac's and stays, so the panel keeps its root across the restart.
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  ownerReady,
  clickReady,
  showServer,
  step
} from './fixtures/fleet-world.mjs'

const isWatchMap = (method, pathname) => method === 'POST' && pathname === '/git/watches'
const within = async (ms, check) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return check()
}

export async function run(t) {
  const world = await fleetWorld('git-restart', { gitRepo: true })
  try {
    const report = world.load()
    const [a] = world.servers
    const [observer] = await world.observeFiles()
    const mac = await world.mac('a')
    await connectMac(mac, world.servers)
    await showServer(mac, 0)
    const { win } = mac
    const owner = mac.owners[0].id
    const session = owned('session', owner, report.values.first.sessionId)
    await ownerReady(mac, owner, session)
    await clickReady(win.locator(`[data-sidebar-item-id="${session}"]`))
    const tabs = win.locator('[data-panel-bar="tabs"]')
    if (!(await tabs.isVisible())) await clickReady(win.getByTitle(/^File tree/))
    await step('a file of the server checkout opens as a tab', async () => {
      await clickReady(tabs.getByRole('button', { name: 'Files', exact: true }))
      const tree = win.locator(`[data-file-tree-root="${owned('file', owner, a.root)}"]`)
      await tree.locator('[data-tree-name="README.md"]').click({ button: 'right' })
      await clickReady(win.getByRole('menuitem', { name: 'Open in Tab', exact: true }))
      await win.locator('.cm-content[contenteditable="true"]:visible').waitFor()
    })

    // The daemon's reply to the panel's first watch map is held before the
    // panel asks for it.
    const heldReply = observer.holdReply(isWatchMap)
    await clickReady(tabs.getByRole('button', { name: 'Git', exact: true }))
    const bar = win.locator('[data-panel-bar="git"]')
    await bar.waitFor({ state: 'visible' })
    await eventually(() => heldReply.taken, 'the panel’s first watch map reached the daemon')

    // The map the Mac will send to the restarted daemon is held before it
    // reaches it, so the new daemon watches nothing for a while.
    const heldRestore = observer.holdRequest(isWatchMap)
    await step('the daemon restarts under a watch map in flight', async () => {
      await world.restart(0)
      await eventually(
        () => heldRestore.taken,
        'the Mac reconnected and sent its map to the new daemon'
      )
    })
    // The old daemon's answer reaches the Mac only now. A panel that took it
    // as "watched" would poll every thirty seconds from here.
    heldReply.release()
    // Let the panel's poll loop re-arm on whatever interval that answer set.
    await new Promise((resolve) => setTimeout(resolve, 6500))

    writeFileSync(path.join(a.root, 'after-restart.txt'), 'written while the restore is pending\n')
    const seen = await within(
      12_000,
      async () => (await win.getByText('after-restart.txt', { exact: true }).count()) > 0
    )
    // What the window shows when this fails: the panel, the focused row, the
    // owner's connection state and the git routes the observer saw.
    const picture = async () =>
      JSON.stringify({
        panel: (
          await win
            .locator('[data-panel-bar="git"]')
            .innerText()
            .catch(() => '(no git bar)')
        ).slice(0, 200),
        body: (
          await win
            .locator('.git-repo-list, [data-git-file-rule]')
            .first()
            .innerText()
            .catch(() => '(no git body)')
        ).slice(0, 300),
        focusedRow: await win.locator(`[data-sidebar-item-id="${session}"]`).count(),
        ownerState: await win
          .locator(`[data-sidebar-item-id="${session}"] [data-fleet-owner]`)
          .getAttribute('data-fleet-state')
          .catch(() => null),
        gitRoutes: observer.entries.filter((e) => e.path.startsWith('/git/')).slice(-12),
        errors: mac.errors
      })
    t.check(
      'a change made while the new daemon watches nothing reaches the panel on its five-second poll',
      seen,
      seen ? undefined : `not shown within twelve seconds; ${await picture()}`
    )

    // The held map lands: the new daemon watches, and the next change arrives
    // through its watch.
    heldRestore.release()
    await eventually(
      () =>
        observer.entries.filter((e) => e.path === '/git/watches' && e.status === 200).length >= 2,
      'the new daemon applied the Mac’s map'
    )
    writeFileSync(path.join(a.root, 'after-restore.txt'), 'written once the new daemon watches\n')
    const seenAfter = await within(
      30_000,
      async () => (await win.getByText('after-restore.txt', { exact: true }).count()) > 0
    )
    t.check(
      'after the restore lands, changes arrive again through the server’s watch',
      seenAfter,
      seenAfter ? undefined : `not shown within thirty seconds; ${await picture()}`
    )
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
