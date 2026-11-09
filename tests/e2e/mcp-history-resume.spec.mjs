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
 * - an id the History does not know, and an open with neither `cwd` nor
 *   `resume`, are refused in words.
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
 * or either refusal is missing.
 *
 * Nothing here reaches Anthropic: `claude` on PATH is a stand-in that logs its
 * argv and waits; CLAVE_TRANSCRIPTS_ROOT, CLAVE_CODEX_ROOT and CLAVE_PI_ROOT
 * point the History at fixture folders, never at the person's own stores.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const CONVERSATION = '5e5e5e5e-0000-4000-8000-00000000a236'
const UNKNOWN = '00000000-0000-4000-8000-00000000dead'
const TITLE = 'Odoo accounting research'
const WS = {
  id: 'cdcdcdcd-0000-4000-8000-0000000004a6',
  name: 'History resume',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** Every start of the stand-in `claude`, oldest first. */
const launches = () => {
  try {
    return readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
const argAfter = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
const rowCount = (win, id) =>
  win.evaluate((sid) => document.querySelectorAll(`[data-sidebar-item-id="${sid}"]`).length, id)
/** The History rows of the seeded conversation, from one `clave_history` answer. */
const rowsOf = (payload) =>
  (payload?.conversations ?? []).filter((r) => r.conversationId === CONVERSATION)
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
  // A login shell that keeps the stand-in first on PATH.
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

    // ── f. An id the History does not know ──
    const unknown = await client.call('clave_open_session', { resume: UNKNOWN })
    t.check('an unknown conversation is refused', toolErrored(unknown), textOf(unknown))
    t.check('in words that name it', textOf(unknown).includes('No conversation'), textOf(unknown))

    // ── g. Neither cwd nor resume ──
    const bare = await client.call('clave_open_session', {})
    t.check('an open with neither cwd nor resume is refused', toolErrored(bare), textOf(bare))
    t.check('because cwd is required', textOf(bare).includes('cwd is required'), textOf(bare))
  } finally {
    if (app) await app.close()
    // Only the stand-ins this spec started are ours to kill, by PID.
    for (const { pid } of launches()) {
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
