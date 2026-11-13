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
 * Since PRDCT-4423 a section has one row per harness the server exposes: a
 * click launches it on the transport of the interaction mode (Chat by
 * default, so the family's chat), its saved profiles sit under Advanced, and
 * with more than one account a model offers the connections.
 *
 * Fails if: the server section is not the same row shape as this Mac's (no
 * row per family, a permission-flag row, no saved profile under Advanced),
 * the server section shows the Mac's profile or hides the server's, a Claude
 * chat launched in the server section starts anywhere but on the server with
 * its chat profile, or the server workspace's own launcher offers no chat.
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
import { fixturePath, REPO, until } from './harness.mjs'

const SERVER_ONLY = 'Server only recorder'
const MAC_ONLY = 'Mac only recorder'

/** The launch profile rows of the open Advanced submenu, by the name they show. */
async function profileRows(win) {
  const rows = win.locator('[role="menu"] [data-launch-profile-entry]')
  await rows.first().waitFor()
  return rows.evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute('data-launch-profile-entry'),
      name: el.textContent?.trim() ?? ''
    }))
  )
}

export async function run(t) {
  // The server's usage reads stay off the network: the fixture token is never
  // refused, so the menu offers the second account (it greys a dead one out).
  const world = await fleetWorld('launcher-server', {
    gitRepo: true,
    env: { CLAVE_E2E_USAGE_OFFLINE: '1' }
  })
  try {
    const [server, other] = world.servers
    const rootA = fixturePath(`${world.run}-local-a`)
    execFileSync('git', ['clone', '-q', server.origin, rootA], { stdio: 'inherit' })
    const mac = await world.mac('a')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const { win } = mac
    // This spec proves the Chat mode's road: a row click opens the server's chat.
    await win.evaluate(() => window.electronAPI.launchSettingsSet({ interactionMode: 'chat' }))

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
    // The chat a Claude Code row opens there (interaction mode Chat): the
    // server's default profile in its chat form, else its built-in chat.
    const serverDefault = serverProfiles.globalDefaults?.claude
    const serverChat =
      serverProfiles.customProfiles.find((p) => p.sourceProfileId === serverDefault)?.id ??
      'claude-chat'
    assert.ok(serverChat.startsWith('chat:') || serverChat === 'claude-chat', serverChat)

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
    const familyRows = await section
      .locator('[data-harness-row]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-harness-row')))
    t.check(
      'the server section has a row per harness family, Claude Code and Codex among them',
      familyRows.includes('claude') && familyRows.includes('codex'),
      familyRows
    )
    t.check(
      'and no permission-flag row: the dangerous launch is the shortcut',
      !/YOLO|skip permissions/.test(await section.innerText()),
      await section.innerText()
    )
    const claude = section.locator('[data-harness-row="claude"]')
    t.equal(
      'the server’s Claude Code row opens a submenu',
      await claude.getAttribute('aria-haspopup'),
      'menu'
    )
    await claude.hover()
    await win.locator('[role="menu"] [data-harness-advanced="claude"]').last().hover()
    const rows = await profileRows(win)
    const names = rows.map((r) => r.name)
    t.check(
      'the server section’s Advanced offers the profile only the server has',
      names.includes(SERVER_ONLY),
      names
    )
    t.check(
      'and never a chat twin',
      rows.every((r) => !r.id.startsWith('chat:') && r.id !== 'claude-chat'),
      rows
    )
    t.check('and not the profile only this Mac has', !names.includes(MAC_ONLY), names)
    await win.keyboard.press('Escape')
    await until(async () => (await win.locator('[role="menu"]').count()) === 0, {
      tries: 30,
      gapMs: 100
    })
    const peerBefore = (await request(other, '/sessions')).length
    const macBefore = (await win.evaluate(() => window.electronAPI.listSessions())).length
    // The interaction mode is Chat (the default): the row's click is the chat.
    await clickReady(win.locator('.launcher-caret'))
    await section.waitFor()
    await clickReady(section.locator('[data-harness-row="claude"]'))
    const chat = await startedOnServer()
    t.equal(
      'a Claude Code row clicked there starts on the server with its chat profile',
      chat.record?.launchProfileId,
      serverChat
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

    // The server's own profile, picked there under Advanced, runs the server's definition.
    await clickReady(win.locator('.launcher-caret'))
    await section.waitFor()
    await section.locator('[data-harness-row="claude"]').hover()
    await win.locator('[role="menu"] [data-harness-advanced="claude"]').last().hover()
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
    const topClaude = win.locator('[data-harness-row="claude"]').first()
    await topClaude.hover()
    await win.locator('[role="menu"] [data-harness-advanced="claude"]').first().hover()
    const topNames = (await profileRows(win)).map((r) => r.name)
    t.check(
      'the server workspace’s launcher offers the server’s profile, not the Mac’s',
      topNames.includes(SERVER_ONLY) && !topNames.includes(MAC_ONLY),
      topNames
    )
    await win.keyboard.press('Escape')
    await until(async () => (await win.locator('[role="menu"]').count()) === 0, {
      tries: 30,
      gapMs: 100
    })
    await clickReady(win.locator('.launcher-caret'))
    await clickReady(win.locator('[data-harness-row="claude"]').first())
    const second = await startedOnServer()
    t.equal(
      'the Claude Code row clicked in the server workspace starts the server’s chat',
      second.record?.launchProfileId,
      serverChat
    )

    // ── A second account on the server: picked from the menu, then replayed by the main button ──
    // (verifier, round 1: the button named the account and started without it)
    const account = await request(server, '/accounts/claude', { label: 'Second server account' })
    await request(server, '/accounts/claude/token', {
      id: account.id,
      token: `sk-ant-oat01-${'x'.repeat(80)}`
    })
    // With two accounts on the server, a model offers its connections.
    await eventually(async () => {
      await clickReady(win.locator('.launcher-caret'))
      const entry = win.locator('[data-harness-row="claude"]').first()
      await entry.hover()
      const model = win
        .locator('[role="menu"] [data-harness-model]:not([data-harness-model="default"])')
        .first()
      await model.waitFor()
      if ((await model.getAttribute('aria-haspopup')) !== 'menu') {
        await win.keyboard.press('Escape')
        return false
      }
      await model.hover()
      // The server's token reaches this Mac's view of its pool on an event:
      // until then the connection is drawn but not usable.
      const connection = win.locator(`[data-harness-connection="${account.id}"]`).first()
      await connection.waitFor()
      if ((await connection.getAttribute('aria-disabled')) === 'true') {
        await win.keyboard.press('Escape')
        return false
      }
      await connection.click()
      return true
    }, 'the server’s accounts reach the menu')
    const picked = await startedOnServer()
    t.equal(
      'a model and a connection picked on the server start on the server’s chat',
      picked.record?.launchProfileId,
      serverChat
    )
    t.equal('on the server account picked', picked.record?.claudeProfileId, account.id)
    const button = win.locator('[data-launcher-agent]')
    await eventually(
      async () => ((await button.getAttribute('title')) ?? '').includes('Second server account'),
      'the main button names the picked server account'
    )
    await clickReady(button)
    const replayed = await startedOnServer()
    t.equal(
      'the main button starts the server’s profile it names',
      replayed.record?.launchProfileId,
      serverChat
    )
    t.equal('on the server account it names', replayed.record?.claudeProfileId, account.id)

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
