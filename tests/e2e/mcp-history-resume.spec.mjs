// Pinned to the in-process server: the History is read from this Mac's
// transcript store by main (`listHistory`), and the spawn's evidence is the
// terminal journal, which only an in-process terminal manager writes
// (`spawnJournal` in harness.mjs).
/**
 * An agent can reopen any past conversation (PRDCT-4236, delivery 2).
 *
 * On 9 November 2026 Romain clicked eleven titles in the History dialog by
 * hand because no tool could list a past conversation or reopen one from its
 * transcript. `clave_history` now lists what the dialog shows and
 * `clave_open_session` with `resume` reopens one. What this proves on the real
 * app, over the real MCP endpoint with an agent tab's own token:
 *
 * - a transcript the ledger never saw (seeded under CLAVE_TRANSCRIPTS_ROOT the
 *   way Claude Code writes one) is a History row: its id, its directory, its
 *   transcript on disk, resumable, held by no tab; `query` finds it by its
 *   title and a query that matches nothing answers no rows;
 * - `clave_open_session { resume, chat: false }` with no `cwd` opens a tab in
 *   the conversation's own directory whose spawn carries the id to resume, and
 *   whose CLI starts with `--resume <id>`;
 * - the History then says which tab holds it (`open: { sessionId, alive }`),
 *   and a second resume of the same id answers that tab (`alreadyOpen`), with
 *   no second tab in the sidebar;
 * - a tab whose CLI process ENDED still holds its conversation: the History
 *   names it `open: { sessionId, alive: false }` (the restore listing leaves
 *   out a hosted session whose process ended, so the tool reads those records
 *   by id), and a resume of the conversation resumes THAT tab in place
 *   (`alreadyOpen`, `resumed: true`), its CLI relaunched with `--resume <id>`,
 *   with no second tab (round 1, F2);
 * - an id the History does not know, and an open with neither `cwd` nor
 *   `resume`, are refused in words;
 * - a Codex conversation (a rollout seeded under CLAVE_CODEX_ROOT the way the
 *   Codex CLI writes one) is a History row of provider `codex`, resumable, and
 *   `clave_open_session { resume }` WITHOUT `mode` reopens it as a Codex tab
 *   whose spawn carries the thread id; naming `mode: 'claude'` for it is
 *   refused in words (round 1, F1: the schema used to default `mode` to
 *   `claude`, so a Codex or Pi conversation could not be resumed at all).
 *
 * The spawn's evidence is read twice, at two depths. The terminal journal
 * (`spawnJournal`) carries the options the terminal manager received, so its
 * `resumeSessionId` proves the id crossed the tool, the served open and the
 * server's start; it does not carry the command line (the journal writes the
 * options, not the argv `buildAgentArgv` makes from them). The stand-in
 * `claude`'s own argv log, written once the pane mounts and the process
 * starts, is what proves the CLI got `--resume <id>` and not a fresh
 * `--session-id`.
 *
 * Fails if: the seeded transcript is not listed or not resumable (the
 * History's synthesis or the tool's rules), the query filter ignores the
 * title, the resume needs a `cwd`, the spawn loses `resumeSessionId` on the
 * served road, the CLI starts without `--resume`, the History does not see the
 * new tab as the conversation's holder, a second resume starts a second tab,
 * a tab whose process ended is not seen as the holder or a resume of its
 * conversation opens a second tab instead of relaunching it, either refusal
 * is missing, the Codex rollout is not a resumable `codex` row, a resume of
 * it without `mode` errors or spawns no Codex tab on the thread, or a
 * mismatched `mode` is not refused.
 *
 * - the History remembers what a conversation was launched on (PRDCT-4236):
 *   reopened with `dangerous: true` and closed, its row carries
 *   `launch.dangerous`, and a resume naming no `dangerous` starts it in
 *   bypass again.
 *
 * Nothing here reaches Anthropic or OpenAI: `claude` and `codex` on PATH are
 * stand-ins that log their argv and wait; CLAVE_TRANSCRIPTS_ROOT, CLAVE_CODEX_ROOT and CLAVE_PI_ROOT
 * point the History at fixture folders, never at the person's own stores.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  spawnJournal,
  callMcp,
  recordsRootOf,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('mcp-history-resume')
const ROOT = fixturePath('mcp-history-resume-root')
const TRANSCRIPTS = path.join(ROOT, 'transcripts')
const CODEX = path.join(ROOT, 'codex-sessions')
const PI = path.join(ROOT, 'pi-sessions')
const ARGV_LOG = path.join(ROOT, 'argv.jsonl')
const CODEX_ARGV_LOG = path.join(ROOT, 'codex-argv.jsonl')
const CONVERSATION = '5e5e5e5e-0000-4000-8000-00000000a236'
const UNKNOWN = '00000000-0000-4000-8000-00000000dead'
const TITLE = 'Odoo accounting research'
/** The Codex thread, and the first human message its row is titled by. */
const CODEX_THREAD = '6c6c6c6c-0000-4000-8000-00000000c0de'
const CODEX_TITLE = 'Draft the Peppol invoice export'
const WS = {
  id: 'cdcdcdcd-0000-4000-8000-0000000004a6',
  name: 'History resume',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** Every start of a stand-in, oldest first, from its argv log. */
const readLog = (file) => {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
/** Every start of the stand-in `claude`, oldest first. */
const launches = () => readLog(ARGV_LOG)
/** Every start of the stand-in `codex`, oldest first. */
const codexLaunches = () => readLog(CODEX_ARGV_LOG)
const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
const rowCount = (win, id) =>
  win.evaluate((sid) => document.querySelectorAll(`[data-sidebar-item-id="${sid}"]`).length, id)
/** The History rows of the seeded conversation, from one `clave_history` answer. */
const rowsOf = (payload, id = CONVERSATION) =>
  (payload?.conversations ?? []).filter((r) => r.conversationId === id)
const textOf = (rpc) => rpc?.result?.content?.find((c) => c.type === 'text')?.text ?? ''

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(path.join(ROOT, 'bin'), { recursive: true })
  mkdirSync(CODEX, { recursive: true })
  mkdirSync(PI, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // The past conversation, where Claude Code keeps it: <root>/<cwd, dashed>/<id>.jsonl.
  // The head gives the peek its cwd and start, the user line its last human
  // message, the ai-title at the tail its title.
  const project = path.join(TRANSCRIPTS, ROOT.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(
    path.join(project, `${CONVERSATION}.jsonl`),
    [
      {
        type: 'user',
        sessionId: CONVERSATION,
        uuid: '7a7a7a7a-0000-4000-8000-000000000001',
        cwd: ROOT,
        timestamp: '2026-11-09T08:00:00.000Z',
        message: { role: 'user', content: 'research odoo accounting' }
      },
      {
        type: 'assistant',
        sessionId: CONVERSATION,
        uuid: '7a7a7a7a-0000-4000-8000-000000000002',
        cwd: ROOT,
        timestamp: '2026-11-09T08:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }
      },
      { type: 'ai-title', aiTitle: TITLE }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  // The stand-in CLI: logs its argv and the tab it runs in, then waits. The
  // title helper's one-shot (`-p`) is not a tab's CLI and stays out of the log.
  writeFileSync(
    path.join(ROOT, 'bin', 'claude'),
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('-p')) process.exit(0);
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ pid: process.pid, tab: process.env.CLAVE_SESSION_ID ?? null, argv }) + '\\n');
process.stdout.write('stand-in claude\\r\\n');
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
  // The Codex thread, where the Codex CLI keeps it: <root>/YYYY/MM/DD/
  // rollout-<time>-<threadId>.jsonl. The `session_meta` head names the
  // thread, its cwd and its start (`scanCodexHead`); the user message after
  // it titles the row.
  const day = path.join(CODEX, '2026', '11', '09')
  mkdirSync(day, { recursive: true })
  writeFileSync(
    path.join(day, `rollout-2026-11-09T08-00-00-${CODEX_THREAD}.jsonl`),
    [
      {
        timestamp: '2026-11-09T08:00:00.100Z',
        type: 'session_meta',
        payload: {
          id: CODEX_THREAD,
          timestamp: '2026-11-09T08:00:00.000Z',
          cwd: ROOT,
          originator: 'codex-tui',
          thread_source: 'user'
        }
      },
      {
        timestamp: '2026-11-09T08:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: CODEX_TITLE }]
        }
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  // The stand-in Codex CLI, the same shape: logs its argv and its tab, waits.
  writeFileSync(
    path.join(ROOT, 'bin', 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CODEX_ARGV_LOG)}, JSON.stringify({ pid: process.pid, tab: process.env.CLAVE_SESSION_ID ?? null, argv }) + '\\n');
process.stdout.write('stand-in codex\\r\\n');
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
  // A login shell that keeps the stand-ins first on PATH.
  writeFileSync(
    path.join(ROOT, 'bin', 'sh'),
    `#!/bin/sh
export PATH='${ROOT}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: path.join(ROOT, 'bin', 'sh'),
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS,
    CLAVE_CODEX_ROOT: CODEX,
    CLAVE_PI_ROOT: PI
  }
  let app = null
  try {
    const launched = await launchApp(DIR, { server: 'in-process', env })
    app = launched.app
    const win = launched.win
    const agent = await spawnAgentTabIn(app, win, DIR)
    t.check('an agent tab holds an MCP token', !!agent?.token, agent)
    if (!agent?.token) throw new Error('no agent token: no tool can be called')
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()

    // ── b. The History lists the transcript ──
    const listed = await client.call('clave_history', {})
    t.check('clave_history answers', !toolErrored(listed), textOf(listed))
    const all = toolPayload(listed)
    const seeded = rowsOf(all)
    t.equal('the seeded conversation is one row of the History', seeded.length, 1)
    const row = seeded[0]
    t.equal('its directory is the transcript’s own', row?.cwd, ROOT)
    t.equal('its title is the transcript’s ai-title', row?.title, TITLE)
    t.equal('it is Claude’s', row?.provider, 'claude')
    t.equal('its transcript is on disk', row?.transcriptExists, true)
    t.equal('it is resumable', row?.resumable, true)
    t.equal('no tab holds it yet', row?.open, null)
    t.check('the answer counts what it shows', all?.shown === all?.conversations?.length, all)

    const found = toolPayload(await client.call('clave_history', { query: 'odoo' }))
    t.equal('query finds it by its title', rowsOf(found).length, 1)
    const none = toolPayload(await client.call('clave_history', { query: 'zzz-nothing' }))
    t.equal('a query that matches nothing answers no rows', none?.conversations?.length, 0)

    // ── c. Reopen it: no cwd, a terminal tab, the spawn carries the id ──
    const spawns = spawnJournal(DIR)
    const opened = await client.call('clave_open_session', { resume: CONVERSATION, chat: false })
    t.check('clave_open_session with resume answers', !toolErrored(opened), textOf(opened))
    const tab = toolPayload(opened)?.sessionId
    t.check('it answers the new tab’s id', typeof tab === 'string', toolPayload(opened))
    const drawn = await until(async () => ((await rowCount(win, tab)) === 1 ? true : null))
    t.check('the new tab has its own sidebar row', drawn === true)

    const spawn = await until(async () =>
      (await spawns()).find((s) => s.resumeSessionId === CONVERSATION)
    )
    t.check('the spawn carries the conversation to resume', !!spawn, await spawns())
    t.equal('in the conversation’s own directory', spawn?.cwd, ROOT)
    t.equal('as a Claude terminal tab', spawn?.claudeMode, true)

    // The CLI starts when the pane mounts: show the tab as the person does.
    if (drawn) await win.click(`[data-sidebar-item-id="${tab}"]`)
    const started = await until(() => launches().find((l) => l.tab === tab), {
      tries: 60,
      gapMs: 250
    })
    t.check('the new tab started its CLI', !!started, launches())
    t.equal(
      'the CLI was launched with --resume <conversation>',
      argAfter(started?.argv ?? [], '--resume'),
      CONVERSATION
    )
    t.check(
      'and not as a fresh --session-id conversation',
      !!started && !started.argv.includes('--session-id'),
      started?.argv
    )

    // ── d. The History sees the tab that holds it ──
    const held = await until(async () => {
      const r = rowsOf(toolPayload(await client.call('clave_history', { open: true })))
      return r.length === 1 && r[0].open?.alive === true ? r : null
    })
    t.check(
      'with open: true the row names the new tab, alive',
      held?.[0]?.open?.sessionId === tab && held?.[0]?.open?.alive === true,
      rowsOf(toolPayload(await client.call('clave_history', { open: true })))
    )

    // ── e. A second resume answers the same tab ──
    const again = toolPayload(await client.call('clave_open_session', { resume: CONVERSATION }))
    t.check('a second resume answers alreadyOpen', again?.alreadyOpen === true, again)
    t.equal('with the same tab', again?.sessionId, tab)
    t.equal('and resumes nothing', again?.resumed, false)
    await new Promise((r) => setTimeout(r, 1000))
    t.equal('the sidebar still has one row for it', await rowCount(win, tab), 1)
    t.equal(
      'and no other tab was started on the conversation',
      (await spawns()).filter((s) => s.resumeSessionId === CONVERSATION).length,
      1
    )

    // ── e2. A tab whose process ended still holds it, and is resumed in place (F2) ──
    // The stand-in's end is the pty's: the History sees the tab stopped once
    // the exit is seen.
    try {
      if (started) process.kill(started.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    const stopped = await until(
      async () => {
        const r = rowsOf(toolPayload(await client.call('clave_history', { open: true })))
        return r.length === 1 && r[0].open?.alive === false ? r : null
      },
      { tries: 60 }
    )
    t.check(
      'once its CLI ended, the History still names the tab, stopped',
      stopped?.[0]?.open?.sessionId === tab && stopped?.[0]?.open?.alive === false,
      rowsOf(toolPayload(await client.call('clave_history', { open: true })))
    )
    const revived = await client.call('clave_open_session', { resume: CONVERSATION })
    t.check(
      'a resume of the stopped tab’s conversation answers',
      !toolErrored(revived),
      textOf(revived)
    )
    const revivedPayload = toolPayload(revived)
    t.check('it answers alreadyOpen', revivedPayload?.alreadyOpen === true, revivedPayload)
    t.equal('it resumed the tab', revivedPayload?.resumed, true)
    t.equal('the same tab, in place', revivedPayload?.sessionId, tab)
    const relaunched = await until(
      () => {
        const mine = launches().filter((l) => l.tab === tab)
        return mine.length === 2 ? mine[1] : null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check(
      'the tab relaunched its CLI once',
      !!relaunched,
      launches().filter((l) => l.tab === tab)
    )
    t.equal(
      'on the same conversation (--resume)',
      argAfter(relaunched?.argv ?? [], '--resume'),
      CONVERSATION
    )
    await new Promise((r) => setTimeout(r, 1000))
    t.equal('the sidebar still has one row for the tab', await rowCount(win, tab), 1)
    const aliveAgain = await until(async () => {
      const r = rowsOf(toolPayload(await client.call('clave_history', { open: true })))
      return r.length === 1 && r[0].open?.sessionId === tab && r[0].open?.alive === true ? r : null
    })
    t.check('the History names the tab alive again', !!aliveAgain)

    // ── f. An id the History does not know ──
    const unknown = await client.call('clave_open_session', { resume: UNKNOWN })
    t.check('an unknown conversation is refused', toolErrored(unknown), textOf(unknown))
    t.check('in words that name it', textOf(unknown).includes('No conversation'), textOf(unknown))

    // ── g. Neither cwd nor resume ──
    const bare = await client.call('clave_open_session', {})
    t.check('an open with neither cwd nor resume is refused', toolErrored(bare), textOf(bare))
    t.check('because cwd is required', textOf(bare).includes('cwd is required'), textOf(bare))

    // ── h. A Codex conversation resumes without naming `mode` (F1) ──
    const codexListed = toolPayload(await client.call('clave_history', { provider: 'codex' }))
    const codexRows = rowsOf(codexListed, CODEX_THREAD)
    t.equal('the seeded Codex thread is one row of the History', codexRows.length, 1)
    t.equal('it is Codex’s', codexRows[0]?.provider, 'codex')
    t.equal('in the thread’s own directory', codexRows[0]?.cwd, ROOT)
    t.equal('it is resumable', codexRows[0]?.resumable, true)
    t.equal('no tab holds it yet', codexRows[0]?.open, null)

    const wrongMode = await client.call('clave_open_session', {
      resume: CODEX_THREAD,
      mode: 'claude'
    })
    t.check('a resume of it as claude is refused', toolErrored(wrongMode), textOf(wrongMode))
    t.check(
      'in words that say the mode cannot resume it',
      textOf(wrongMode).includes('cannot resume it'),
      textOf(wrongMode)
    )

    const codexSpawns = spawnJournal(DIR)
    const codexOpened = await client.call('clave_open_session', {
      resume: CODEX_THREAD,
      chat: false
    })
    t.check('a resume of it with no mode answers', !toolErrored(codexOpened), textOf(codexOpened))
    const codexTab = toolPayload(codexOpened)?.sessionId
    t.check(
      'it answers a tab id, a new one',
      typeof codexTab === 'string' && codexTab !== tab,
      toolPayload(codexOpened)
    )
    const codexSpawn = await until(async () =>
      (await codexSpawns()).find((s) => s.resumeSessionId === CODEX_THREAD)
    )
    t.check('the spawn carries the thread to resume', !!codexSpawn, await codexSpawns())
    t.equal('as a Codex tab', codexSpawn?.codexMode, true)
    t.equal('in the thread’s own directory', codexSpawn?.cwd, ROOT)

    // ── i. The History remembers the launch, and a resume defaults to it ──
    // Romain: "If I launched in Yolo … it gets back to that on relaunch,
    // from the History as well." The conversation's tab is closed, reopened
    // with dangerous, closed again; the History's row then says it ran in
    // bypass, and a resume naming nothing starts it in bypass.
    const closeAndWait = async (id) => {
      const closed = await client.call('clave_close_session', { sessionId: id })
      t.check('the tab closes', !toolErrored(closed), textOf(closed))
      return until(
        async () => {
          const r = rowsOf(toolPayload(await client.call('clave_history', {})))
          return r.length === 1 && r[0].open === null ? r[0] : null
        },
        { tries: 60 }
      )
    }
    const released = await closeAndWait(tab)
    t.check('once closed, no tab holds the conversation', !!released, released)
    const yoloSpawns = spawnJournal(DIR)
    const yolo = await client.call('clave_open_session', {
      resume: CONVERSATION,
      chat: false,
      dangerous: true
    })
    t.check('a resume with dangerous answers', !toolErrored(yolo), textOf(yolo))
    const yoloTab = toolPayload(yolo)?.sessionId
    t.check('as a new tab', typeof yoloTab === 'string' && yoloTab !== tab, toolPayload(yolo))
    const yoloDrawn = await until(async () => ((await rowCount(win, yoloTab)) === 1 ? true : null))
    t.check('the bypass tab has its sidebar row', yoloDrawn === true)
    const yoloSpawn = await until(async () =>
      (await yoloSpawns()).find((s) => s.resumeSessionId === CONVERSATION)
    )
    t.equal('its spawn ran in bypass', yoloSpawn?.dangerousMode, true)
    const remembered = await closeAndWait(yoloTab)
    t.check('closed, the History row is free again', !!remembered, remembered)
    t.equal('and remembers the launch in bypass', remembered?.launch?.dangerous, true)

    const relaunchSpawns = spawnJournal(DIR)
    const plain = await client.call('clave_open_session', { resume: CONVERSATION, chat: false })
    t.check('a resume naming no dangerous answers', !toolErrored(plain), textOf(plain))
    const relaunchSpawn = await until(async () =>
      (await relaunchSpawns()).find((s) => s.resumeSessionId === CONVERSATION)
    )
    t.check('its spawn resumes the conversation', !!relaunchSpawn, await relaunchSpawns())
    t.equal('in bypass, as it was last launched', relaunchSpawn?.dangerousMode, true)

    // ── j. A conversation that left bypass for plan comes back in plan after its tab is closed (round 6, V6-F1) ──
    // The provider's mode report writes the record; here the record is written
    // as the report would write it, then the tab is closed by the agent: the
    // ledger must have learnt the mode before the record went.
    const planTab = toolPayload(plain)?.sessionId
    t.check(
      'the bypass tab reopened in step i is the one to switch',
      typeof planTab === 'string',
      toolPayload(plain)
    )
    // A terminal's record is keyed by its tmux name, so it is found by its id.
    const recordsDir = path.join(recordsRootOf(DIR), 'session-records')
    const recordOfTab = () => {
      try {
        return readdirSync(recordsDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.join(recordsDir, f))
          .find((file) => {
            try {
              return JSON.parse(readFileSync(file, 'utf8')).id === planTab
            } catch {
              return false
            }
          })
      } catch {
        return undefined
      }
    }
    const planRecord = await until(() => recordOfTab() ?? null, { tries: 60 })
    t.check('the reopened tab has its record', !!planRecord, recordsDir)
    if (planRecord) {
      const record = JSON.parse(readFileSync(planRecord, 'utf8'))
      writeFileSync(
        planRecord,
        JSON.stringify({ ...record, permissionMode: 'plan', effort: 'high' })
      )
    }
    // Closed the way the person closes (the window's road through the
    // preload's kill, which every close button and key takes), not the
    // agent's (round 7, V7-F1).
    await callMcp(app, 'closeSession', { sessionId: planTab })
    const afterSwitch = await until(async () => {
      const r = rowsOf(toolPayload(await client.call('clave_history', {})))
      return r.length === 1 && r[0].open === null ? r[0] : null
    })
    t.check('closed after the switch, the History row is free', !!afterSwitch, afterSwitch)
    t.check(
      'and remembers plan, bypass off, effort high',
      afterSwitch?.launch?.permissionMode === 'plan' &&
        afterSwitch?.launch?.dangerous === false &&
        afterSwitch?.launch?.effort === 'high',
      afterSwitch?.launch
    )
    const planSpawns = spawnJournal(DIR)
    const planAgain = await client.call('clave_open_session', { resume: CONVERSATION, chat: false })
    t.check('a resume naming no mode answers', !toolErrored(planAgain), textOf(planAgain))
    const planSpawn = await until(async () =>
      (await planSpawns()).find((s) => s.resumeSessionId === CONVERSATION)
    )
    t.check('its spawn has bypass off', !!planSpawn && planSpawn.dangerousMode === false, planSpawn)
    // The journal keeps the spawn's flags, not its mode: the CLI's own argv
    // says it, once the pane mounts and the stand-in starts.
    const planTabAgain = toolPayload(planAgain)?.sessionId
    const planDrawn = await until(async () =>
      (await rowCount(win, planTabAgain)) === 1 ? true : null
    )
    t.check('the reopened tab has its row', planDrawn === true)
    if (planDrawn) await win.click(`[data-sidebar-item-id="${planTabAgain}"]`)
    const planLaunch = await until(() => launches().find((l) => l.tab === planTabAgain) ?? null, {
      tries: 60
    })
    t.check('its CLI starts', !!planLaunch, launches())
    t.equal(
      'in plan (--permission-mode plan)',
      argAfter(planLaunch?.argv ?? [], '--permission-mode'),
      'plan'
    )
    t.equal('at effort high (--effort high)', argAfter(planLaunch?.argv ?? [], '--effort'), 'high')
    t.check(
      'and not in bypass',
      !!planLaunch && !planLaunch.argv.includes('--dangerously-skip-permissions'),
      planLaunch?.argv
    )

    // ── k. The agent's own close road remembers the mode too ──
    const editsRecord = await until(() => {
      try {
        return (
          readdirSync(recordsDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => path.join(recordsDir, f))
            .find((file) => {
              try {
                return JSON.parse(readFileSync(file, 'utf8')).id === planTabAgain
              } catch {
                return false
              }
            }) ?? null
        )
      } catch {
        return null
      }
    })
    t.check('the plan tab has its record', !!editsRecord, recordsDir)
    if (editsRecord) {
      const record = JSON.parse(readFileSync(editsRecord, 'utf8'))
      writeFileSync(editsRecord, JSON.stringify({ ...record, permissionMode: 'acceptEdits' }))
    }
    const afterEdits = await closeAndWait(planTabAgain)
    t.check(
      'closed by the agent after a second switch, the History remembers acceptEdits',
      afterEdits?.launch?.permissionMode === 'acceptEdits' &&
        afterEdits?.launch?.dangerous === false,
      afterEdits?.launch
    )
  } finally {
    if (app) await app.close()
    // Only the stand-ins this spec started are ours to kill, by PID.
    for (const { pid } of [...launches(), ...codexLaunches()]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') console.error('Stand-in cleanup failed', error)
      }
    }
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
