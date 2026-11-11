// A tab on a server shows and switches the SERVER's accounts (PRDCT-4328).
// Account ids are random per machine, so a server tab's id never exists in
// this Mac's lists: the chip read "removed account" over two "Reading
// usage…" that never loaded, and no other account could be picked. On the
// fleet harness: one standalone server with two token accounts of its own
// (Work, Play) and its usage reads recorded, never a provider; a chat tab
// opened on the server on Work, from a Mac that has no account but its
// Default. The chip and the tab menu must name Work with its sign-in, load
// its usage from the server, offer Play, and picking Play must restart the
// tab ON THE SERVER on Play: the server's record and the token the restarted
// process got, never a badge. `clave_list` reports the server's account.
//
// Fails if: the seam reads this Mac's list for a server tab (the chip says
// "Removed account"), the usage is read from this Mac's store ("Reading
// usage…" forever), the switch list is emptied for a server tab, or the
// switch sends an id the server does not hold.
//
// Not proven here: that each reader loads a server's accounts as it draws
// (the launcher loads every connected server anyway); `session-accounts-
// mount.test.tsx` holds that, one test per reader.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { callMcp, fixturePath, until } from './harness.mjs'
import { connectMac, eventually, fleetWorld, request, showServer } from './fixtures/fleet-world.mjs'

const WORK_TOKEN = `sk-ant-oat01-served-work-${'w'.repeat(60)}`
const PLAY_TOKEN = `sk-ant-oat01-served-play-${'p'.repeat(60)}`
const STUB_ID = 'served-accounts-stub'

/** A Claude chat CLI that records its argv and token, answers every message
 *  and stays up until it is signalled, as the real one does between turns. */
function writeStub(dir, processes, transcripts) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'claude-stub.cjs')
  writeFileSync(
    file,
    `const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) { process.stdout.write('fixture title\\n'); process.exit(0); }
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
fs.appendFileSync(${JSON.stringify(processes)}, JSON.stringify({ pid: process.pid, argv, token }) + '\\n');
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const transcript = path.join(${JSON.stringify(transcripts)}, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
const record = (line) => { fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify(line) + '\\n'); };
const name = token === ${JSON.stringify(PLAY_TOKEN)} ? 'PLAY' : 'WORK';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  const content = input.message.content;
  record({ type: 'user', message: { role: 'user', content } });
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  const answer = 'ANSWER FROM ' + name + ' to ' + content;
  record({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] }, session_id: sid });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid });
});
setInterval(() => {}, 1000);
`
  )
  return file
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

export async function run(t) {
  const dir = fixturePath(`served-accounts-${process.pid}`)
  const processes = path.join(dir, 'processes.jsonl')
  const transcripts = path.join(dir, 'transcripts')
  mkdirSync(transcripts, { recursive: true })
  const stub = writeStub(dir, processes, transcripts)
  const world = await fleetWorld('server-accounts', {
    count: 1,
    env: { CLAVE_TRANSCRIPTS_ROOT: transcripts }
  })
  try {
    const [server] = world.servers
    // The daemon's usage reads are recorded and answered per account: Work
    // has 60% of its 5-hour block left, Play 90%. Never a provider.
    await server.fixture.evaluate(() => {
      const { usageClock } = globalThis.__claveE2E
      if (!usageClock) throw new Error('the daemon has no usage clock fixture')
      globalThis.__reads = []
      globalThis.__used = {}
      globalThis.__usedNext = 40
      for (const provider of ['claude', 'codex']) {
        usageClock[provider].source.read = async (accountId) => {
          globalThis.__reads.push({ provider, accountId })
          const now = Date.now()
          return {
            windows: [
              {
                key: 'session:Current session (5h)',
                label: 'Current session (5h)',
                kind: 'session',
                scope: null,
                usedPercentage: globalThis.__used[accountId] ?? globalThis.__usedNext,
                resetsAt: now + 3_600_000,
                severity: null
              }
            ],
            fetchedAt: now
          }
        }
      }
    })
    const work = await request(server, '/accounts/claude', { label: 'Work' })
    await request(server, '/accounts/claude/token', { id: work.id, token: WORK_TOKEN })
    // The read the token set makes is what the server holds for the account.
    await server.fixture.evaluate(() => {
      globalThis.__usedNext = 10
    })
    const play = await request(server, '/accounts/claude', { label: 'Play' })
    await request(server, '/accounts/claude/token', { id: play.id, token: PLAY_TOKEN })
    await server.fixture.evaluate(
      ({ work, play }) => {
        globalThis.__used[work] = 40
        globalThis.__used[play] = 10
        globalThis.__used.default = 70
      },
      { work: work.id, play: play.id }
    )

    const mac = await world.mac('a')
    const { win, app } = mac
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    t.check(
      "this Mac holds neither of the server's accounts",
      !(await win.evaluate(() => window.electronAPI.claudeAccountsList())).some(
        (a) => a.label === 'Work' || a.label === 'Play'
      )
    )
    // The server's stub CLI, as a launch profile of the server: its chat
    // variant is what the tab runs.
    await win.evaluate(
      ({ owner, profile }) => window.electronAPI.fleetLaunchProfileUpsert(owner, profile),
      {
        owner,
        profile: {
          id: STUB_ID,
          name: 'Served accounts stub',
          family: 'claude',
          command: [process.execPath, stub],
          additionalArgs: []
        }
      }
    )
    await showServer(mac, 0)
    const opened = await callMcp(app, 'openSession', {
      server: owner,
      cwd: server.root,
      mode: 'claude',
      profile: `chat:claude:${STUB_ID}`,
      account: 'Work',
      name: 'Served chat'
    })
    const id = opened.sessionId
    t.check('the tab is a server tab', id?.startsWith('clave-owner:session:'), id)
    const wireId = decodeURIComponent(id.split(':').pop())
    const record = async () =>
      (await request(server, '/sessions/records')).find((r) => r.id === wireId)
    t.equal('the server started it on Work', (await record())?.claudeProfileId, work.id)
    await eventually(
      async () => lines(processes).some((p) => p.token === WORK_TOKEN),
      'the process on the server got the Work token'
    )
    await callMcp(app, 'focus', { sessionId: id })
    const pane = win.locator(`.chat-host[data-session-id="${id}"]`)
    await pane.locator('[data-testid="chat-view"]').first().waitFor({ timeout: 15_000 })
    // The chip lives on the Terminal view's status line: the tab is put on it
    // from its session menu, as a reader picks it.
    await win.getByLabel('Session menu', { exact: true }).click()
    const tile = win.locator('.view-tile', { hasText: /^Enclave$/ })
    await tile.waitFor()
    await win.waitForTimeout(500)
    await tile.click({ force: true })
    await pane.locator('[data-testid="terminal-view"] .term-status').waitFor({ timeout: 10_000 })

    // One exchange on Work, so the move has a conversation to resume.
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'first question' }),
      id
    )
    await pane.getByText('ANSWER FROM WORK to first question').first().waitFor({ timeout: 15_000 })

    // ── The chip names the server's account and its usage ──
    const chip = pane.locator(`[data-account-chip="${work.id}"]`)
    await chip.waitFor({ timeout: 10_000 })
    t.equal('the chip is the server’s', await chip.getAttribute('data-account-owner'), owner)
    const named = await until(
      async () => {
        const text = await chip.innerText()
        return /Work/.test(text) && /60% left/.test(text)
      },
      { tries: 120, gapMs: 100 }
    )
    t.check(
      'the chip names Work with the server’s 60% left',
      named,
      `${await chip.innerText()} | ${JSON.stringify(await server.fixture.evaluate(() => globalThis.__reads))}`
    )
    if (!named) throw new Error('chip')
    t.check('never "Removed account"', !/Removed account/i.test(await chip.innerText()))

    // ── Its popover: the header, the usage, the server's other account ──
    await chip.getByRole('button', { name: 'Account' }).click()
    const menu = win.locator('.term-account-menu')
    await menu.waitFor()
    const header = menu.locator(`[data-account-header="${work.id}"]`)
    await eventually(
      async () => /Work · Token/.test(await header.innerText()),
      'the header names Work and how it signs in on the server'
    )
    t.check('the header never says removed', !/removed account/i.test(await header.innerText()))
    await eventually(
      async () => !/Reading usage/.test(await menu.innerText()),
      'the usage loads in the header'
    )
    t.check(
      'the header draws the server’s cap',
      (await menu.locator('[data-usage-window]').count()) >= 1
    )
    const playRow = menu.locator(`[data-account-switch-row="${play.id}"]`)
    t.equal('the list offers Play, the server’s other account', await playRow.count(), 1)
    t.equal(
      'and not Work, the account the tab is on',
      await menu.locator(`[data-account-switch-row="${work.id}"]`).count(),
      0
    )
    t.equal(
      'the pin is offered: it holds an agent’s ask',
      await menu.getByText('Pin to this account').count(),
      1
    )
    t.equal(
      'the mode is worded for the agents’ asks it governs on a server tab',
      await menu.getByText('Let agents switch without asking').count(),
      1
    )
    t.equal(
      'no knob only this Mac’s policy reads',
      await menu.getByText(/Switch automatically at limit|Keep on this model/).count(),
      0
    )

    // ── The switch restarts the tab ON THE SERVER on Play ──
    await menu.getByRole('menuitem', { name: 'Play' }).click()
    await eventually(
      async () => (await record())?.claudeProfileId === play.id,
      'the server’s record says Play'
    )
    await eventually(
      async () => lines(processes).some((p) => p.token === PLAY_TOKEN),
      'the restarted process on the server got the Play token'
    )
    const onPlay = lines(processes).find((p) => p.token === PLAY_TOKEN)
    t.check(
      'and was told to resume the conversation',
      onPlay?.argv.includes('--resume'),
      JSON.stringify(onPlay?.argv)
    )
    await eventually(
      async () => (await pane.locator(`[data-account-chip="${play.id}"]`).count()) === 1,
      'the chip follows the tab to Play'
    )

    // ── The agent tools: the server's account, by its name ──
    const listed = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check(
      'clave_list reports the server’s account',
      listed?.account?.id === play.id && listed.account.label === 'Play' && !listed.account.removed,
      JSON.stringify(listed?.account)
    )
    // Propose mode (the default): the agent's ask is proposed in the tab,
    // as on this Mac, and the person's accept makes it.
    const asked = await callMcp(app, 'switchAccount', { sessionId: id, account: 'Work' })
    t.check(
      'clave_switch_account resolves a name in the server’s list and, in propose mode, proposes it',
      asked?.account?.id === work.id && asked.proposed === true && asked.switched === false,
      JSON.stringify(asked)
    )
    const proposal = win.locator(`[data-account-proposal="${work.id}"]`).first()
    await proposal.waitFor({ timeout: 10_000 })
    t.equal(
      'the server’s record did not move on the ask',
      (await record())?.claudeProfileId,
      play.id
    )
    await proposal.locator('[data-account-proposal-accept]').click()
    await eventually(
      async () => (await record())?.claudeProfileId === work.id,
      'the accepted proposal moves the tab to Work on the server'
    )

    // The chip's menu, opened fresh each time (a menu still closing would
    // swallow the click that opens the next).
    const chipMenu = async (theChip, item) => {
      const surface = win.locator('.term-account-menu')
      await surface.waitFor({ state: 'detached' }).catch(() => {})
      await theChip.getByRole('button', { name: 'Account' }).click()
      await surface.waitFor()
      await surface.getByText(item, { exact: true }).click()
      await surface.waitFor({ state: 'detached' })
    }
    // A pinned server tab refuses the agent's move.
    const workChip = pane.locator(`[data-account-chip="${work.id}"]`)
    await workChip.waitFor({ timeout: 10_000 })
    await chipMenu(workChip, 'Pin to this account')
    const refused = await callMcp(app, 'switchAccount', { sessionId: id, account: 'Play' }).then(
      () => null,
      (error) => String(error?.message ?? error)
    )
    t.check('a pinned server tab refuses the agent’s move', /pinned/.test(refused ?? ''), refused)
    await chipMenu(workChip, 'Unpin from this account')

    // Automatic mode, set on the tab: "any" moves it at once, in the
    // server's pool (Play: 90% left; the server's Default: 30%).
    await chipMenu(workChip, 'Let agents switch without asking')
    const anyMove = await callMcp(app, 'switchAccount', { sessionId: id, account: 'any' })
    t.check(
      '"any" picks the server’s account with the most headroom and moves the tab',
      anyMove?.account?.id === play.id && anyMove.switched === true,
      JSON.stringify(anyMove)
    )
    await eventually(
      async () => (await record())?.claudeProfileId === play.id,
      'the server’s record says Play after "any"'
    )

    // ── The server removes the account the tab runs on: that IS removed ──
    await request(server, '/accounts/claude/remove', { id: play.id })
    const playChip = pane.locator(`[data-account-chip="${play.id}"]`)
    await eventually(
      async () => /Play/.test(await playChip.innerText().catch(() => '')),
      'the chip keeps the label the tab started with'
    )
    await playChip.getByRole('button', { name: 'Account' }).click()
    await eventually(
      async () =>
        /removed account/.test(
          await win.locator(`[data-account-header="${play.id}"]`).first().innerText()
        ),
      'the header says the server removed the account'
    )
    await win.keyboard.press('Escape')
    const afterRemoval = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check(
      'clave_list says removed',
      afterRemoval?.account?.removed === true,
      JSON.stringify(afterRemoval?.account)
    )

    // ── A tab on the SERVER's Default: the server's machine login, never this Mac's ──
    const onDefault = await callMcp(app, 'openSession', {
      server: owner,
      cwd: server.root,
      mode: 'claude',
      profile: `chat:claude:${STUB_ID}`,
      account: 'Default',
      name: 'Served default'
    })
    const defaultPane = win.locator(`.chat-host[data-session-id="${onDefault.sessionId}"]`)
    await callMcp(app, 'focus', { sessionId: onDefault.sessionId })
    // A new chat opens in the view the reader picked last (Enclave, above).
    const defaultStatus = defaultPane.locator('[data-testid="terminal-view"] .term-status')
    const inEnclave = await defaultStatus
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!inEnclave) {
      await win.getByLabel('Session menu', { exact: true }).click()
      const tile2 = win.locator('.view-tile', { hasText: /^Enclave$/ })
      await tile2.waitFor()
      await win.waitForTimeout(500)
      await tile2.click({ force: true })
      await defaultStatus.waitFor({ timeout: 10_000 })
    }
    const defaultChip = defaultPane.locator('[data-account-chip="default"]')
    await defaultChip.waitFor({ timeout: 10_000 })
    t.equal(
      'the Default chip is the server’s',
      await defaultChip.getAttribute('data-account-owner'),
      owner
    )
    const reads = await until(async () => /30% left/.test(await defaultChip.innerText()), {
      tries: 120,
      gapMs: 100
    })
    t.check(
      'it shows the SERVER’s Default usage (30% left; this Mac reads none in a test run)',
      reads,
      await defaultChip.innerText()
    )
    await callMcp(app, 'focus', { sessionId: id })

    // ── The tab menu in the sidebar: the same header and list ──
    const row = win.locator(`[data-sidebar-item-id="${id}"]`)
    await row.click({ button: 'right' })
    const sideHeader = win.locator(`[data-account-header="${play.id}"]`).first()
    await eventually(
      async () => /removed account/.test(await sideHeader.innerText()),
      'the tab menu header says the server removed the account'
    )
    const entry = win.locator('[role="menuitem"]', { hasText: 'Switch account' })
    t.equal('the tab menu offers Switch account', await entry.count(), 1)
    t.equal(
      'and the pin, which holds an agent’s ask',
      await win.locator('[role="menuitem"]', { hasText: 'Pin to this account' }).count(),
      1
    )
    t.equal(
      'but not "Keep on this model", which only this Mac’s policy reads',
      await win.locator('[role="menuitem"]', { hasText: 'Keep on this model' }).count(),
      0
    )
    await win.keyboard.press('Escape')

    // ── The tab menu opened before the server's accounts are read: a loading
    // row, filled in while the menu stays open (the verifier's recipe: the
    // server's usage snapshot, which the Mac's settings load waits on, slowed
    // by 8 s, and a fresh window holding none of the server's settings). ──
    await server.fixture.evaluate(() => {
      const usage = globalThis.__claveE2E.settings.usage
      const original = usage.claudeSnapshot.bind(usage)
      usage.claudeSnapshot = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 8_000))
        return original(...args)
      }
    })
    await win.reload()
    const freshRow = win.locator(`[data-sidebar-item-id="${id}"]`)
    await freshRow.waitFor({ timeout: 30_000 })
    await freshRow.click({ button: 'right' })
    const pendingEntry = win.locator('[role="menuitem"]', { hasText: 'Switch account' })
    await pendingEntry.waitFor({ timeout: 5_000 })
    await pendingEntry.hover()
    const loadingRow = win.locator('[role="menuitem"]', {
      hasText: 'Reading the server’s accounts'
    })
    t.check(
      'the entry is there with a loading row while the server is unread',
      await loadingRow
        .waitFor({ timeout: 4_000 })
        .then(() => true)
        .catch(() => false)
    )
    const filledRow = win.locator('[role="menu"]').locator(`[data-account-switch-row="${work.id}"]`)
    t.check(
      'and fills in with the server’s Work while the menu stays open',
      await filledRow
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false),
      `loading row still there: ${await loadingRow.count()}`
    )
    t.equal('the loading row is gone', await loadingRow.count(), 0)
    await win.keyboard.press('Escape')

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
