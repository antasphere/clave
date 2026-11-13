/**
 * A Clave server keeps its own History, and the Mac's History dialog lists it
 * and reopens it on the server (PRDCT-4321). One daemon, one Mac, each with a
 * transcripts root of its own (CLAVE_TRANSCRIPTS_ROOT), so the conversation's
 * transcript sits on the server's disk only and never on the Mac's. A Claude
 * chat runs on the daemon over the local stream-json stand-in
 * (`fixtures/claude-stream-stub.mjs`, a claude-family launch profile posted to
 * `/launch-profiles`) and gets its conversation from a first message typed in
 * the Mac's composer; its transcript is written under the daemon's root with
 * a title and a last prompt; the tab is deleted from the Mac's sidebar (its
 * close cross, then Delete). The daemon's `/history/list` still names the
 * conversation, closed, its transcript present; the Mac's History shows it as
 * a row of that server, online and resumable, finds it by a phrase of its
 * human line, and a click on it starts a new tab ON THE SERVER on the same
 * conversation, in its folder and its server workspace, and nothing on the
 * Mac. That tab deleted too, a second server tab is moved onto two new
 * conversations from the Mac's window, as its pane does after each `/clear`,
 * and deleted: the server's History lists all three conversations it ran.
 * Then the daemon is stopped: the row stays, read from the Mac's kept copy of
 * the server's last answer, offline and blocked, and a click on it starts
 * nothing.
 *
 * Fails if: a deleted tab's conversation drops out of the server's History
 * (its last word not stamped before its record goes), the Mac does not lay a
 * server's list into its own (no `data-history-server` row, or a row that
 * reads "Transcript gone" because it looked on the Mac's disk), the server's
 * transcript is not searched, a click resumes the conversation on the Mac (or
 * nowhere) instead of on the server, a `/clear` of a server tab misses the
 * server's record or a conversation between two of them goes unlisted, an
 * offline server's rows vanish or stay clickable, or anything is written into
 * the Mac's own transcripts root.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath, until } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

/** Claude Code's project-directory encoding of a cwd, the app's own
 *  (`transcriptProjectDirName`, src/main/exchange-capture/contract/workstream-events.ts). */
const projectDir = (cwd) => cwd.replace(/[/.]/g, '-')

const TITLE = 'Fleet history probe'
const LAST_PROMPT = 'the probe’s last words'
const PHRASE = 'marigold lantern'

/** Every file under a directory, recursively (empty when it does not exist). */
function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]
  )
}

export async function run(t) {
  // Two transcripts roots: the daemon's, where the conversation is written,
  // and the Mac's own, empty, which must stay so.
  const serverRoot = fixturePath(`fleet-history-server-transcripts-${process.pid}`)
  const macRoot = fixturePath(`fleet-history-mac-transcripts-${process.pid}`)
  const macCodex = fixturePath(`fleet-history-mac-codex-${process.pid}`)
  for (const dir of [serverRoot, macRoot, macCodex]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  const world = await fleetWorld('fleet-history', {
    count: 1,
    env: { CLAVE_TRANSCRIPTS_ROOT: serverRoot }
  })
  try {
    const [server] = world.servers
    const daemonSessions = () => request(server, '/sessions')
    // A chat's conversation id is on its record (the adoptable records
    // route), not on the session the list answers.
    const daemonRecords = () => request(server, '/sessions/records')
    const daemonHistory = async () => (await request(server, '/history/list')).conversations

    await request(server, '/launch-profiles', {
      profile: {
        id: 'fleet-history-stub',
        name: 'Fleet history stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:fleet-history-stub' }
    })
    const rawId = started.id

    // The Mac seals the server's token with the OS encryption: a mock
    // keychain keeps the run off the developer's login keychain, as the
    // daemons' run keychain does (a keychain prompt nobody answers would
    // hold the save, and the whole spec, forever).
    const mac = await world.mac('history', {
      args: ['--use-mock-keychain'],
      env: { CLAVE_TRANSCRIPTS_ROOT: macRoot, CLAVE_CODEX_ROOT: macCodex }
    })
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const key = owned('session', owner, rawId)
    const { win } = mac
    await showServer(mac, 0)

    // The chat's CLI starts on its first message, and with it the
    // conversation: typed in the composer, as a person does.
    const tab = win.locator(`[data-sidebar-item-id="${key}"]`)
    await tab.click()
    const chat = win.locator(`[data-session-id="${key}"] [data-testid="chat-view"]`)
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await chat.waitFor()
    await eventually(() => composer.isEnabled(), 'the live chat’s composer is enabled')
    const first = `Where does the ${PHRASE} hang tonight?`
    await composer.fill(first)
    await composer.press('Enter')
    await chat
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: `stub heard: ${first}` })
      .first()
      .waitFor()
    let conversation = null
    let ranIn = null
    await eventually(async () => {
      const record = (await daemonRecords()).find((r) => r.id === rawId)
      conversation = record?.claudeSessionId ?? null
      ranIn = record?.workspaceId ?? null
      return !!conversation
    }, 'the chat on the server carries its conversation id')
    t.check('the chat on the server names its conversation', !!conversation, conversation)

    // What the real CLI leaves on the server's disk (the stub writes none),
    // plus what Claude Code writes at its tail: the title and the last prompt.
    const dir = path.join(serverRoot, projectDir(server.root))
    const transcript = path.join(dir, `${conversation}.jsonl`)
    mkdirSync(dir, { recursive: true })
    const tail = [
      { type: 'ai-title', aiTitle: TITLE },
      { type: 'last-prompt', lastPrompt: LAST_PROMPT }
    ]
    const line = (value) => JSON.stringify(value) + '\n'
    if (existsSync(transcript)) appendFileSync(transcript, tail.map(line).join(''))
    else
      writeFileSync(
        transcript,
        [
          {
            type: 'user',
            sessionId: conversation,
            uuid: '00000000-0000-4000-8000-000000000001',
            timestamp: new Date().toISOString(),
            cwd: server.root,
            message: { role: 'user', content: first }
          },
          ...tail
        ]
          .map(line)
          .join('')
      )

    // --- The tab is deleted the way a person does: its close cross, then Delete ---
    const deleteTab = async (id) => {
      const row = win.locator(`[data-sidebar-item-id="${owned('session', owner, id)}"]`)
      await row.hover()
      await row.getByRole('button', { name: 'Close', exact: true }).click()
      const confirm = win.getByRole('dialog', { name: 'Delete session', exact: true })
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      // The confirmation holds the focus until it is gone: a shortcut pressed
      // during its exit is swallowed, so the next step waits for it.
      await confirm.waitFor({ state: 'detached', timeout: 15_000 })
      await eventually(async () => (await row.count()) === 0, 'the deleted tab leaves the sidebar')
      await eventually(
        async () =>
          !(await daemonSessions()).some((s) => s.id === id) &&
          !(await daemonRecords()).some((r) => r.id === id),
        'the server no longer holds the deleted tab'
      )
    }
    const heldOnServer = async () =>
      (await daemonHistory()).find((c) => c.conversationId === conversation) ?? null
    await deleteTab(rawId)
    t.check('the tab is deleted on the server from the Mac’s sidebar', true)

    const kept = await heldOnServer()
    t.check('the server’s History still lists the deleted tab’s conversation', !!kept, kept)
    t.equal('no tab holds it any more (held: closed)', kept?.held, 'closed')
    t.equal(
      'its transcript is on the server’s disk (transcript: present)',
      kept?.transcript,
      'present'
    )
    t.equal('the server read its title from the transcript', kept?.title, TITLE)
    t.equal('and its folder is the tab’s', kept?.cwd, server.root)

    // --- The Mac's History lays the server's list into its own ---
    // This Mac's own tabs: its session list also carries every connected
    // server's, under their owner keys.
    const macSessionCount = async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).filter(
        (s) => !s.id.startsWith('clave-owner:')
      ).length
    const macBefore = await macSessionCount()
    // ⌘⇧H toggles the dialog: pressed once, then waited for (a loaded
    // machine draws it late, and a second press would close it).
    const openHistory = async () => {
      await win.keyboard.press('Meta+Shift+H')
      await win.waitForSelector('[data-history-dialog]', { timeout: 15_000 })
    }
    const row = win.locator(`[data-history-row="${conversation}"]`)
    const readRow = () =>
      win.evaluate((id) => {
        const el = document.querySelector(`[data-history-row="${id}"]`)
        if (!el) return null
        const tag = el.querySelector('[data-history-server-tag]')
        return {
          server: el.getAttribute('data-history-server'),
          blocked: el.getAttribute('data-blocked'),
          missing: el.getAttribute('data-missing'),
          title: el.querySelector('.history-row-title')?.textContent ?? null,
          prompt: el.querySelector('.history-row-prompt')?.textContent ?? null,
          tag: tag?.getAttribute('data-history-server-tag') ?? null,
          online: tag?.getAttribute('data-online') ?? null
        }
      }, conversation)
    await openHistory()
    await row.waitFor({ timeout: 10_000 })
    const listed = await readRow()
    t.equal('the row is the server’s (data-history-server)', listed?.server, owner)
    t.equal('its title is the transcript’s ai-title', listed?.title, TITLE)
    t.equal('its tag names the server', listed?.tag, owner)
    t.equal('the tag reads the server online', listed?.online, 'true')
    t.equal('the row is not blocked', listed?.blocked, null)
    t.equal('its second line is the last prompt, read on the server', listed?.prompt, LAST_PROMPT)
    t.check('never "Transcript gone"', !/Transcript gone/.test(listed?.prompt ?? ''), listed)

    // --- A phrase of the human line finds the server's row ---
    await win.fill('[data-history-filter]', PHRASE)
    await win.waitForTimeout(400)
    const searched = await until(async () => {
      const r = await win.evaluate((id) => {
        const el = document.querySelector(`[data-history-row="${id}"]`)
        return {
          footer: document.querySelector('[data-history-footer]')?.textContent ?? '',
          rows: [...document.querySelectorAll('[data-history-row]')].map((e) =>
            e.getAttribute('data-history-row')
          ),
          server: el?.getAttribute('data-history-server') ?? null,
          hits: el ? [...el.querySelectorAll('[data-history-hit]')].map((h) => h.textContent) : []
        }
      }, conversation)
      return /\d+ hits? in/.test(r.footer) ? r : null
    })
    t.check(
      'the search lists the server’s row',
      searched?.rows.includes(conversation) && searched?.server === owner,
      searched
    )
    t.check(
      'with a hit in the human line, read on the server',
      (searched?.hits ?? []).some((h) => h?.includes(PHRASE)),
      searched
    )
    await win.fill('[data-history-filter]', '')
    await eventually(
      async () =>
        (await row.locator('.history-row-prompt').count()) > 0 &&
        (await row.locator('[data-history-hit]').count()) === 0,
      'the row is back to its last prompt once the search is cleared'
    )

    // --- A click reopens the conversation on the server, never on the Mac ---
    const before = new Set((await daemonRecords()).map((r) => r.id))
    await row.click()
    let resumed = null
    await until(
      async () => {
        resumed = (await daemonRecords()).find((r) => !before.has(r.id)) ?? null
        return resumed?.claudeSessionId ? resumed : null
      },
      { tries: 100, gapMs: 100 }
    )
    t.check('the click starts a new tab on the server', !!resumed, await daemonRecords())
    t.equal(
      'on the same conversation (its record’s claudeSessionId)',
      resumed?.claudeSessionId,
      conversation
    )
    t.equal('in the conversation’s folder', resumed?.cwd, server.root)
    t.equal('in the server workspace it ran in', resumed?.workspaceId, ranIn)
    // The way it ran (PRDCT-4321): its chat view, on the server's own profile.
    t.equal(
      'on the launch profile it ran on (its chat view)',
      resumed?.launchProfileId,
      'chat:claude:fleet-history-stub'
    )
    t.check(
      'the dialog closed on the click',
      await win.evaluate(() => !document.querySelector('[data-history-dialog]'))
    )
    if (resumed)
      await eventually(
        async () =>
          (await win
            .locator(`[data-sidebar-item-id="${owned('session', owner, resumed.id)}"]`)
            .count()) > 0,
        'the resumed server tab shows in the Mac’s sidebar'
      )
    t.equal('no tab started on the Mac', await macSessionCount(), macBefore)

    // --- Offline: the server's last answer, kept on the Mac, blocked ---
    // The resumed tab is deleted first: a conversation an open tab holds is
    // focused from the History whatever its server's state, so the offline
    // case is the conversation no tab holds. The History, opened once more
    // while the server answers, keeps that answer on the Mac.
    if (resumed) await deleteTab(resumed.id)
    t.equal(
      'the resumed tab deleted, the server holds it closed again',
      (await heldOnServer())?.held,
      'closed'
    )
    await openHistory()
    await row.waitFor({ timeout: 10_000 })
    t.equal('online, the row is resumable again', (await readRow())?.blocked, null)
    await win.keyboard.press('Escape')
    await win.locator('[data-history-dialog]').waitFor({ state: 'detached' })

    // --- A `/clear` in a server tab: every conversation it ran stays listed ---
    // The pane keeps each rotation through the window's API, with the tab's
    // key (use-terminal.ts); here twice, then the tab is deleted.
    const clearedTab = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:fleet-history-stub' }
    })
    let beforeClear = null
    await eventually(async () => {
      beforeClear =
        (await daemonRecords()).find((r) => r.id === clearedTab.id)?.claudeSessionId ?? null
      return !!beforeClear
    }, 'the second server tab carries its conversation id')
    const rotations = [randomUUID(), randomUUID()]
    for (const rotated of rotations)
      await win.evaluate(
        ({ key, rotated }) => window.electronAPI.setSessionClaudeSessionId(key, rotated),
        { key: owned('session', owner, clearedTab.id), rotated }
      )
    t.equal(
      'the server’s record follows the tab’s last /clear',
      (await daemonRecords()).find((r) => r.id === clearedTab.id)?.claudeSessionId,
      rotations[1]
    )
    await request(server, '/sessions/stop', { id: clearedTab.id })
    const ranByCleared = (await daemonHistory())
      .filter((c) => c.sessionId === clearedTab.id)
      .map((c) => c.conversationId)
      .sort()
    t.equal(
      'the server’s History lists every conversation the cleared tab ran',
      JSON.stringify(ranByCleared),
      JSON.stringify([beforeClear, ...rotations].sort())
    )

    await server.stop()
    // The renderer's own word on the connection: the preload refuses a
    // snapshot of a server it is not connected to.
    await eventually(
      () =>
        win.evaluate(
          (id) =>
            window.electronAPI.fleetSnapshot(id).then(
              () => false,
              () => true
            ),
          owner
        ),
      'the Mac sees the server go offline'
    )
    await openHistory()
    await row.waitFor({ timeout: 10_000 })
    // The tag follows the fleet store, which hears the drop on its own beat.
    await until(async () => (await readRow())?.online === 'false', { tries: 100, gapMs: 100 })
    const offline = await readRow()
    t.equal('offline, the row is still listed as the server’s', offline?.server, owner)
    t.equal('its title is kept', offline?.title, TITLE)
    t.equal('the tag reads the server offline', offline?.online, 'false')
    t.equal('the row is blocked', offline?.blocked, 'true')
    t.check('and says so on its second line', /offline/.test(offline?.prompt ?? ''), offline)
    const macOffline = await macSessionCount()
    await row.click()
    await win.waitForTimeout(800)
    t.check(
      'a click on the offline row leaves the dialog open',
      await win.evaluate(() => !!document.querySelector('[data-history-dialog]'))
    )
    t.equal('and starts nothing on the Mac', await macSessionCount(), macOffline)

    t.equal(
      'nothing was written into the Mac’s own transcripts root',
      JSON.stringify(filesUnder(macRoot)),
      JSON.stringify([])
    )
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
