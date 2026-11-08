/**
 * The launcher offers a paired server what THAT server can start
 * (PRDCT-4162): its "Run on <server>" section is built from the server's
 * own launch profiles and accounts, chat forms included, the same way the
 * top section is built for this Mac, and a server workspace's own launcher
 * is built from the server too. On the fleet harness: one standalone server
 * whose repository the Mac workspace is a clone of (the pairing of
 * PRDCT-4151), a launch profile only the server has, another only the Mac
 * has.
 *
 * Fails if: the server section still hard-codes three rows (no chat, no
 * skip-permissions row, no saved profile), the server section shows the
 * Mac's profile or hides the server's, a Claude chat picked in the server
 * section starts anywhere but on the server with its chat profile, or the
 * server workspace's own launcher offers no chat.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  request,
  clickReady,
  showServer
} from './fixtures/fleet-world.mjs'
import { fixturePath, REPO } from './harness.mjs'

const SERVER_ONLY = 'Server only recorder'
const MAC_ONLY = 'Mac only recorder'

/** The launch profile rows of the open submenu, by the name they show. */
async function profileRows(win) {
  const rows = win.locator('[data-launch-profile-entry]')
  await rows.first().waitFor()
  return rows.evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-launch-profile-entry'),
      name: el.textContent?.trim() ?? ''
    }))
  )
}

export async function run(t) {
  const world = await fleetWorld('launcher-server', { gitRepo: true })
  try {
    const [server, other] = world.servers
    const rootA = fixturePath(`${world.run}-local-a`)
    execFileSync('git', ['clone', '-q', server.origin, rootA], { stdio: 'inherit' })
    const mac = await world.mac('a')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const { win } = mac

    // One profile the server alone has, one this Mac alone has.
    const recorder = (suffix) => [
      process.execPath,
      path.join(REPO, 'tests/e2e/fixtures/argv-recorder.mjs'),
      `${suffix}-${world.run}`
    ]
    await win.evaluate(
      ({ owner, profile }) => window.electronAPI.fleetLaunchProfileUpsert(owner, profile),
      {
        owner,
        profile: {
          id: 'server-only-recorder',
          name: SERVER_ONLY,
          family: 'claude',
          command: recorder('server-only'),
          additionalArgs: []
        }
      }
    )
    await win.evaluate((profile) => window.electronAPI.launchProfileUpsert(profile), {
      id: 'mac-only-recorder',
      name: MAC_ONLY,
      family: 'claude',
      command: recorder('mac-only'),
      additionalArgs: []
    })
    const serverProfiles = await request(server, '/launch-profiles')
    assert.ok(
      serverProfiles.customProfiles.some((p) => p.id === 'claude-chat'),
      'the server lists its Claude chat profile'
    )

    // The pairing: the server's repository as a server workspace, confirmed once.
    await win.evaluate(
      ({ owner, root }) => window.electronAPI.fleetAddWorkspace(owner, { rootDir: root }),
      { owner, root: server.root }
    )
    const notice = win.getByTestId('pairing-proposal')
    await notice.waitFor()
    await clickReady(notice.getByRole('button', { name: 'Combine', exact: true }))
    await notice.waitFor({ state: 'hidden' })

    const known = new Set((await request(server, '/sessions')).map((s) => s.id))
    const startedOnServer = async () => {
      let started
      await eventually(async () => {
        started = (await request(server, '/sessions')).find((s) => !known.has(s.id))
        return !!started
      }, 'the server started a session')
      known.add(started.id)
      const records = await request(server, '/sessions/records')
      return { session: started, record: records.find((r) => r.id === started.id) }
    }

    // ── The "Run on <server>" section of the Mac workspace ──
    await clickReady(win.locator('.launcher-caret'))
    const section = win.locator(`[data-run-on-server="${owner}"]`)
    await section.waitFor()
    t.equal(
      'the server section has a skip-permissions row',
      await section.locator('[data-claude-entry="Claude Code (skip permissions)"]').count(),
      1
    )
    t.equal(
      'and a YOLO Codex row',
      await section.locator('[data-codex-entry="Codex CLI (YOLO)"]').count(),
      1
    )
    const claude = section.locator('[data-claude-entry="Claude Code"]')
    t.equal(
      'the server’s Claude Code row opens its launch profiles',
      await claude.getAttribute('aria-haspopup'),
      'menu'
    )
    await claude.hover()
    const rows = await profileRows(win)
    const names = rows.map((r) => r.name)
    t.check('the server section offers the Claude chat', names.includes('Claude (chat)'), names)
    t.check('and the profile only the server has', names.includes(SERVER_ONLY), names)
    t.check('and its chat form', names.includes(`${SERVER_ONLY} (chat)`), names)
    t.check('and not the profile only this Mac has', !names.includes(MAC_ONLY), names)
    const peerBefore = (await request(other, '/sessions')).length
    const macBefore = (await win.evaluate(() => window.electronAPI.listSessions())).length
    await win.locator('[data-launch-profile-entry="claude-chat"]').click()
    const chat = await startedOnServer()
    t.equal(
      'a Claude chat picked there starts on the server with its chat profile',
      chat.record?.launchProfileId,
      'claude-chat'
    )
    t.equal(
      'in the server workspace root',
      path.resolve(chat.session.cwd),
      path.resolve(server.root)
    )
    t.equal(
      'the other server started nothing',
      (await request(other, '/sessions')).length,
      peerBefore
    )
    t.equal(
      'and this Mac started nothing',
      (await win.evaluate(() => window.electronAPI.listSessions())).length,
      macBefore
    )

    // The server's own profile, picked there, runs the server's definition.
    await clickReady(win.locator('.launcher-caret'))
    await section.waitFor()
    await section.locator('[data-claude-entry="Claude Code"]').hover()
    await win.locator('[data-launch-profile-entry="server-only-recorder"]').click()
    const own = await startedOnServer()
    t.equal(
      'the server’s own profile starts on the server by its id',
      own.record?.launchProfileId,
      'server-only-recorder'
    )

    // ── The server workspace's own launcher ──
    await showServer(mac, 0)
    await clickReady(win.locator('.launcher-caret'))
    const topLabel = win.locator(`[data-launch-source="${owner}"]`)
    await topLabel.waitFor()
    t.check(
      'in the server workspace the menu names the server at its top',
      (await topLabel.innerText()).includes('Personal VPS 1')
    )
    t.equal(
      'and draws no separate Run on section for it',
      await win.locator(`[data-run-on-server="${owner}"]`).count(),
      0
    )
    const topClaude = win.locator('[data-claude-entry="Claude Code"]').first()
    await topClaude.hover()
    const topNames = (await profileRows(win)).map((r) => r.name)
    t.check(
      'the server workspace’s launcher offers the server’s chat and profile, not the Mac’s',
      topNames.includes('Claude (chat)') &&
        topNames.includes(SERVER_ONLY) &&
        !topNames.includes(MAC_ONLY),
      topNames
    )
    await win.locator('[data-launch-profile-entry="claude-chat"]').first().click()
    const second = await startedOnServer()
    t.equal(
      'a chat picked in the server workspace starts on the server with its chat profile',
      second.record?.launchProfileId,
      'claude-chat'
    )

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
