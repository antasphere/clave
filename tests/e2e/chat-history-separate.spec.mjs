/**
 * A Claude chat restored after the update shows its past even when the
 * server's first answer for it is lost, and keeps its name (PRDCT-3526).
 *
 * The bug, on 3.0.0-beta.1: the first launch on the separate server restored
 * every tab while the server was busy doing it, a chat pane's one request for
 * its past went unanswered, the pane swallowed the failure and never asked
 * again, and the chat stayed empty while its new turns arrived. The tabs also
 * came back nameless on the server's records, and a rename from the window
 * reached main's copy of the records only, which the separate server never
 * reads.
 *
 * The flow is the update's: a chat record left by the app before it had a
 * separate server (with its name, and a transcript on disk), then the first
 * launch in the suite's mode (separate: the migration runs first). Before the
 * restore, the server's history answer is made to fail ONCE for the tab
 * (`globalThis.__claveE2E.sessionHost`, in whichever process the server runs),
 * the lost request the busy server produced by timing, here by design. The
 * pane must still show the past, which means it asked again. Then the
 * record the next launch restores from (the server's) must carry the tab's
 * name, and a rename from the window must reach it.
 *
 * Nothing reaches Anthropic: `claude` on PATH is a stub that never answers,
 * CLAVE_TRANSCRIPTS_ROOT points the transcript lookup at a fixture dir, and
 * the CLI only starts on a first message, which this spec never sends.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  seedSessionRecord,
  serverDataDirOf,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('chat-history-separate')
const ROOT = fixturePath('chat-history-separate-root')
const TRANSCRIPTS = `${ROOT}/transcripts`
const TAB = 'b6d1c3a0-6f0e-4c55-9a3e-5e0a7c41d2f9'
const CONVERSATION = '0d3f6c2e-8a41-4b7e-9c55-2f1e7a9b4c60'
const NAME = 'Named before the update'
const RENAMED = 'Renamed after the update'
const PAST = 'a question asked before the update'
const ANSWER = 'the answer kept in the transcript'

const serverRecord = () => {
  try {
    return JSON.parse(
      readFileSync(path.join(serverDataDirOf(DIR), 'session-records', `${TAB}.json`), 'utf8')
    )
  } catch {
    return null
  }
}

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'history-ws', name: 'History', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'history-ws',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(`${ROOT}/bin/claude`, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
  // The conversation as Claude Code keeps it: <root>/<cwd, dashed>/<id>.jsonl.
  const dir = path.join(TRANSCRIPTS, ROOT.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const timestamp = new Date(Date.now() - 86_400_000).toISOString()
  writeFileSync(
    path.join(dir, `${CONVERSATION}.jsonl`),
    [
      { type: 'user', timestamp, message: { role: 'user', content: PAST } },
      { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: ANSWER }] } }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
  // The record the app left before the update, in its own folder: seeded
  // before the first launch, so `seedSessionRecord` writes it where the app
  // keeps its records (and gives a fresh attached server a copy).
  seedSessionRecord(DIR, {
    adapterId: 'claude-chat',
    transport: 'events',
    id: TAB,
    claudeSessionId: CONVERSATION,
    cwd: ROOT,
    folderName: path.basename(ROOT),
    displayName: NAME,
    userRenamed: true,
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    launchProfileId: 'claude-chat',
    workspaceId: 'history-ws'
  })
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS
  }
  let app = null
  try {
    const launched = await launchApp(DIR, { env })
    app = launched.app
    const { win, fixture } = launched
    // The server's first answer for the tab's past is lost; the next ones are not.
    await fixture.evaluate((tab) => {
      const host = globalThis.__claveE2E.sessionHost
      const history = host.history
      globalThis.__historyAsked = []
      host.history = (id, before, limit) => {
        globalThis.__historyAsked.push(id)
        if (id === tab && globalThis.__historyAsked.filter((x) => x === tab).length === 1)
          throw new Error('the first answer is lost (e2e)')
        return history.call(host, id, before, limit)
      }
    }, TAB)

    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false))
    t.check('the restore prompt offers the chat the app left', !!prompted)
    if (!prompted) throw new Error('no restore prompt')
    await restore.click()
    const back = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.some((s) => s.id === TAB)
    )
    t.check('the chat tab is back', !!back)
    await callMcp(app, 'focus', { sessionId: TAB }).catch(() => {})

    const pane = win.locator(`section.chat-host[data-session-id="${TAB}"]`)
    const shown = await until(
      async () => {
        const text = await pane.innerText().catch(() => '')
        return text.includes(PAST) && text.includes(ANSWER) ? text : null
      },
      { tries: 30 }
    )
    const asked = await fixture.evaluate(
      (tab) => globalThis.__historyAsked.filter((x) => x === tab).length,
      TAB
    )
    t.check('the pane shows the past although the first answer was lost', !!shown, {
      asked,
      pane: (await pane.innerText().catch((e) => String(e))).slice(0, 300)
    })
    t.check(
      'and says neither "could not be loaded" nor "Start a conversation"',
      !!shown && !/could not be loaded|Start a conversation/.test(shown)
    )

    // The record the next launch restores from keeps the tab's name.
    const named = await until(() => (serverRecord()?.displayName === NAME ? serverRecord() : null))
    t.check("the server's record of the restored tab keeps its name", !!named, serverRecord())
    t.check('as a name the person gave', named?.userRenamed === true, named)

    // A rename from the window reaches that same record.
    await win.evaluate(({ id, name }) => window.electronAPI.setSessionDisplayName(id, name, true), {
      id: TAB,
      name: RENAMED
    })
    const renamed = await until(() =>
      serverRecord()?.displayName === RENAMED ? serverRecord() : null
    )
    t.check("a rename from the window reaches the server's record", !!renamed, serverRecord())

    // So do a /clear's new conversation, a workspace move and the page on the
    // tab's row (round 2 of the lane's verifier): they took the same road to
    // main's copy only.
    const CLEARED = '7a1c9e44-2b3d-4f6a-8e5c-0d9b1f2a3c4e'
    await win.evaluate(
      ({ id, conversation }) => window.electronAPI.setSessionClaudeSessionId(id, conversation),
      { id: TAB, conversation: CLEARED }
    )
    const cleared = await until(() =>
      serverRecord()?.claudeSessionId === CLEARED ? serverRecord() : null
    )
    t.check("a /clear's new conversation reaches the server's record", !!cleared, serverRecord())
    await win.evaluate(({ id }) => window.electronAPI.setSessionWorkspace(id, 'moved-ws'), {
      id: TAB
    })
    const moved = await until(() =>
      serverRecord()?.workspaceId === 'moved-ws' ? serverRecord() : null
    )
    t.check("a workspace move reaches the server's record", !!moved, serverRecord())
    const PAGE = { url: 'http://127.0.0.1:4826', title: 'The lane page' }
    await win.evaluate(({ id, page }) => window.electronAPI.setSessionViewRecord(id, page), {
      id: TAB,
      page: PAGE
    })
    const paged = await until(() =>
      serverRecord()?.view?.url === PAGE.url ? serverRecord() : null
    )
    t.check(
      "the page on the tab's row reaches the server's record",
      paged?.view?.title === PAGE.title,
      serverRecord()
    )
  } finally {
    if (app) await app.close()
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
