// Pinned to the separate server, the mode the installed app runs (issue #183).
/**
 * A window reload brings back every tab the server still holds, as it was:
 * the same ids, in their group, no provider started twice and none started
 * for a chat nobody opened; and so does a restart.
 *
 * The bug: on 3.0.0-beta.2 a reload of the window left the sidebar empty (or
 * nearly) while the server still held every session, and the console logged
 * one "session already exists" per chat. The server's records listing only
 * left out the sessions its PTY backend runs, so every chat it held came back
 * as a record to spawn, unmarked; the window asked for each one again under
 * its id, the server refused the duplicate, and the failure took the tab out
 * of the store and out of its group. The layout's own road (by id) skipped
 * them too, the record not saying `running`.
 *
 * The check seeds three Claude and three Codex chat records (four in a saved
 * group, two at the top level) through the named fixture scenario
 * `sessions/live-chat-restore`, starts the app on its separate server, opens
 * one chat of each provider (their stub agents start), opens a real terminal
 * in the group, then reloads the window twice and restarts the app. Each time:
 * every tab once, the group as saved, the server holding each chat once, no
 * adoption failure logged, the two opened agents never started again, and no
 * agent started for a chat that is neither shown nor opened.
 *
 * What makes it able to fail: on dev e8d4a9e the first reload logs a failed
 * adoption per chat and the chats leave the sidebar and the group. Mark the
 * host's chats `running` without the renderer skipping their spawn, or the
 * renderer without the server marking them, and it goes red; let `live` say
 * "registered" instead of "started" and every restored chat mounts and starts
 * its agent, which the start log catches. The agents are stubs that only log
 * their start: nothing reaches a provider.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  separateServerDataDir,
  userDataDir,
  fixturePath,
  callMcp,
  until,
  waitForBoot
} from './harness.mjs'

const DIR = userDataDir('live-chat-restore')
const ROOT = fixturePath('live-chat-restore-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = { id: 'live-chat-restore-ws', name: 'Live chats', rootDir: ROOT }
const KEY = 'live-chat-restore-window'
/** The line the renderer logs for a record it failed to adopt. */
const ADOPT_FAILED = 'Failed to adopt session record'

const allStarts = () =>
  existsSync(STARTS)
    ? readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
/** The chats' agents: a start names its session in CLAVE_SESSION_ID. */
const starts = () => allStarts().filter((s) => s.session)
const startsOf = (id) => starts().filter((s) => s.session === id).length

function chatRecord(id, codex, name) {
  return {
    id,
    adapterId: codex ? 'codex-chat' : 'claude-chat',
    transport: 'events',
    ...(codex ? { codexThreadId: randomUUID() } : { claudeSessionId: randomUUID() }),
    cwd: ROOT,
    folderName: 'live-chat-restore-root',
    displayName: name,
    userRenamed: true,
    claudeMode: !codex,
    antigravityMode: false,
    codexMode: codex,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    launchProfileId: codex ? 'chat:codex:stub-codex' : 'chat:claude:stub-claude',
    workspaceId: WS.id,
    windowKey: KEY
  }
}

/** The scenario's SeedChats command: an install that has run on its
 *  separate server before, its chats in a saved group and at the top level. */
function seedChats({ groupId }) {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(`${ROOT}/transcripts`, { recursive: true })
  mkdirSync(`${ROOT}/codex-sessions`, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  for (const name of ['claude', 'codex'])
    writeFileSync(
      `${BIN}/${name}`,
      `#!/bin/sh\necho '{"agent":"${name}","pid":'$$',"session":"'"$CLAVE_SESSION_ID"'"}' >> ${JSON.stringify(STARTS)}\nexec sleep 600\n`,
      { mode: 0o755 }
    )
  writeFileSync(
    path.join(DIR, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'stub-claude',
          name: 'Stub Claude',
          family: 'claude',
          command: [`${BIN}/claude`],
          additionalArgs: []
        },
        {
          id: 'stub-codex',
          name: 'Stub Codex',
          family: 'codex',
          command: [`${BIN}/codex`],
          additionalArgs: []
        }
      ],
      globalDefaults: {},
      workspaceOverrides: {}
    })
  )
  writeFileSync(
    path.join(DIR, 'windows.json'),
    JSON.stringify({ version: 1, windows: [{ key: KEY, workspaceId: WS.id }] })
  )
  const chats = [
    { id: randomUUID(), codex: false, name: 'Claude grouped one', grouped: true },
    { id: randomUUID(), codex: true, name: 'Codex grouped one', grouped: true },
    { id: randomUUID(), codex: false, name: 'Claude grouped two', grouped: true },
    { id: randomUUID(), codex: true, name: 'Codex grouped two', grouped: true },
    { id: randomUUID(), codex: false, name: 'Claude top', grouped: false },
    { id: randomUUID(), codex: true, name: 'Codex top', grouped: false }
  ]
  const members = chats.filter((c) => c.grouped).map((c) => c.id)
  mkdirSync(path.join(DIR, 'sidebar-layouts', 'windows'), { recursive: true })
  writeFileSync(
    path.join(DIR, 'sidebar-layouts', 'windows', `${KEY}.json`),
    JSON.stringify({
      groups: [
        {
          id: groupId,
          name: 'Kept group',
          sessionIds: members,
          collapsed: false,
          cwd: ROOT,
          terminals: [],
          workspaceId: WS.id
        }
      ],
      displayOrder: [groupId, ...chats.filter((c) => !c.grouped).map((c) => c.id)]
    })
  )
  const recordsDir = path.join(separateServerDataDir(DIR), 'session-records')
  mkdirSync(recordsDir, { recursive: true })
  for (const c of chats)
    writeFileSync(
      path.join(recordsDir, `${c.id}.json`),
      JSON.stringify(chatRecord(c.id, c.codex, c.name))
    )
  return { groupId, chats, members }
}

const env = () => ({
  SHELL: `${BIN}/bash`,
  PATH: `${BIN}:${process.env.PATH}`,
  CLAVE_TRANSCRIPTS_ROOT: `${ROOT}/transcripts`,
  CLAVE_CODEX_ROOT: `${ROOT}/codex-sessions`
})

/** Every console line the window logs, across its reloads. */
function watchConsole(win, lines) {
  win.on('console', (message) => lines.push(message.text()))
}

const shownTiles = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('[data-terminal-tile]')]
      .filter((tile) => !tile.hasAttribute('inert'))
      .map((tile) => tile.getAttribute('data-terminal-tile'))
  )

export async function run(t) {
  const modulePath = fixturePath('live-chat-restore-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/live-chat-restore.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadLiveChatRestore } = await import(pathToFileURL(modulePath).href)
  const lines = []
  let app = null
  let seeded = null
  try {
    const report = await loadLiveChatRestore({
      seed: async (payload) => (seeded = seedChats(payload)),
      launch: async () => {
        const launched = await launchApp(DIR, {
          server: 'separate',
          env: env(),
          beforeBoot: async (win) => watchConsole(win, lines)
        })
        app = launched.app
        return launched
      },
      ready: async (values) => {
        const ids = values.chats.chats.map((c) => c.id)
        await until(
          async () => {
            const list = await callMcp(values.app.app, 'list', {})
            return ids.every((id) => list.sessions.some((s) => s.id === id)) ? true : null
          },
          { tries: 120, gapMs: 250 }
        )
      }
    })
    console.log(
      JSON.stringify({
        scenario: 'sessions/live-chat-restore',
        runId: report.runId,
        ids: report.ids,
        dir: DIR
      })
    )
    const { win } = report.values.app
    const { groupId, chats, members } = seeded
    const ids = chats.map((c) => c.id)
    const byName = (name) => chats.find((c) => c.name === name).id

    /** The window and the server, each tab once, the group as saved. */
    const checkWhole = async (when, expectedIds, expectedMembers) => {
      const list = await until(
        async () => {
          const l = await callMcp(app, 'list', {})
          return expectedIds.every((id) => l.sessions.some((s) => s.id === id)) ? l : null
        },
        { tries: 80, gapMs: 250 }
      )
      const listed = (list ?? (await callMcp(app, 'list', {}))).sessions.map((s) => s.id)
      t.check(
        `${when}: every tab is in the window once, none missing`,
        expectedIds.every((id) => listed.filter((x) => x === id).length === 1),
        { listed, expectedIds }
      )
      const group = (list?.groups ?? []).find((g) => g.id === groupId)
      t.check(
        `${when}: the group holds its members as they were`,
        !!group && [...group.sessionIds].sort().join() === [...expectedMembers].sort().join(),
        { group: group?.sessionIds, expectedMembers }
      )
      const names = (list?.sessions ?? []).filter((s) => ids.includes(s.id))
      t.check(
        `${when}: every chat keeps its name`,
        chats.every((c) => names.find((s) => s.id === c.id)?.name === c.name),
        names.map((s) => [s.id, s.name])
      )
      const kernel = await win.evaluate(() => window.electronAPI.sessionsList())
      t.check(
        `${when}: the server holds each chat once, on its own provider`,
        chats.every((c) => {
          const held = kernel.filter((k) => k.id === c.id)
          return held.length === 1 && held[0].adapterId === (c.codex ? 'codex-chat' : 'claude-chat')
        }),
        kernel.map((k) => [k.id, k.adapterId])
      )
      const failed = lines.filter((l) => l.includes(ADOPT_FAILED))
      t.check(`${when}: no adoption failed`, failed.length === 0, failed.slice(0, 3))
    }

    await checkWhole('launch', ids, members)

    // Open one chat of each provider: their agents start, once.
    const opened = [byName('Claude grouped one'), byName('Codex grouped one')]
    for (const id of opened) {
      await win.click(`[data-sidebar-item-id="${id}"] button`)
      await until(() => (startsOf(id) > 0 ? true : null), { tries: 40 })
    }
    t.check(
      'opening a chat of each provider starts its agent once',
      opened.every((id) => startsOf(id) === 1),
      starts()
    )

    // A real terminal in the group, through the server.
    const terminal = (await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', groupId }))
      .sessionId
    const alive = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === terminal && s.alive)
    )
    t.check('a terminal runs in the group', !!alive, terminal)
    const withTerminal = [...ids, terminal]
    const membersWithTerminal = [...members, terminal]

    // ── Two reloads of the window: the server keeps every session ──
    for (const round of [1, 2]) {
      const before = starts().length
      await win.reload()
      await waitForBoot(win)
      await checkWhole(`reload ${round}`, withTerminal, membersWithTerminal)
      const back = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === terminal)
      t.check(`reload ${round}: the terminal is the same live session`, back?.alive === true, back)
      await new Promise((r) => setTimeout(r, 1500))
      t.check(
        `reload ${round}: the opened agents were not started again`,
        opened.every((id) => startsOf(id) === 1),
        starts()
      )
      const shown = await shownTiles(win)
      const added = starts().slice(before)
      t.check(
        `reload ${round}: no agent started for a chat neither shown nor opened`,
        added.every((s) => shown.includes(s.session) && !opened.includes(s.session)),
        { added, shown }
      )
    }

    // ── A restart: the terminal is closed first (a plain one ends with the
    //    app); every chat comes back from its record, dormant ──
    await callMcp(app, 'closeSession', { sessionId: terminal })
    await app.close()
    app = null
    for (const s of allStarts()) {
      try {
        process.kill(s.pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
    const beforeRestart = starts().length
    const again = await launchApp(DIR, {
      server: 'separate',
      env: env(),
      beforeBoot: async (w) => watchConsole(w, lines)
    })
    app = again.app
    const restarted = again.win
    const list = await until(
      async () => {
        const l = await callMcp(app, 'list', {})
        return ids.every((id) => l.sessions.some((s) => s.id === id)) ? l : null
      },
      { tries: 120, gapMs: 250 }
    )
    const listed = (list ?? (await callMcp(app, 'list', {}))).sessions.map((s) => s.id)
    t.check(
      'restart: every chat is back once',
      ids.every((id) => listed.filter((x) => x === id).length === 1),
      listed
    )
    const group = (list?.groups ?? []).find((g) => g.id === groupId)
    t.check(
      'restart: the group holds its chats as saved',
      !!group && [...group.sessionIds].sort().join() === [...members].sort().join(),
      group?.sessionIds
    )
    await new Promise((r) => setTimeout(r, 1500))
    const shown = await shownTiles(restarted)
    const added = starts().slice(beforeRestart)
    t.check(
      'restart: no agent started for a chat not shown',
      added.every((s) => shown.includes(s.session)),
      { added, shown }
    )
    const failed = lines.filter((l) => l.includes(ADOPT_FAILED))
    t.check('restart: no adoption failed', failed.length === 0, failed.slice(0, 3))
  } finally {
    for (const s of allStarts()) {
      try {
        process.kill(s.pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
    if (app) await app.close()
  }
}
