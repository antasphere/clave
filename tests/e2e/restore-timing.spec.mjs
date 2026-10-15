// Pinned to the separate server, the mode the installed app runs (PRDCT-3527).
/**
 * A launch brings a large profile's sessions back at once: the person's tabs
 * are in their groups about a second after the window appears, the agents
 * reattach after, and none of the restored chats starts its agent until it is
 * opened.
 *
 * The bug: Valentin's install (about 120 records, mostly chats) took ten
 * seconds to show its sessions on 3.0.0-beta.1. Measured on a copy of it: the
 * records were adopted one after the other, each a round trip to the server;
 * every restored chat mounted its view, which started its agent and replayed
 * its conversation; two synchronous reads of the login shell froze main and
 * the server for two seconds each; and the chats, never "live", waited behind
 * the restore prompt.
 *
 * The check seeds 100 chat records (60 Codex, 40 Claude) in five saved groups,
 * starts the app on its separate server, and times the rows from the page's
 * own start (`performance.timeOrigin`, the window's navigation), polled inside
 * the page so the driver's latency is not in the figure. Then: no prompt was
 * shown, every tab is in its group once, no agent started for a chat nobody
 * opened, and opening one starts exactly that one.
 *
 * What makes it able to fail: on dev fb0f09b the chats wait behind the prompt
 * and come back one at a time; adopt one at a time again, mount the hidden
 * chat views again, or put the prompt back in front of the chats, and it goes
 * red. The agents are stubs that only log their start: nothing reaches a
 * provider.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  seedSessionRecord,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'

const DIR = userDataDir('restore-timing')
const ROOT = fixturePath('restore-timing-root')
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = { id: 'restore-timing-ws', name: 'Timing', rootDir: ROOT }
const KEY = 'restore-timing-window'
const GROUPS = 5
const PER_GROUP = 20
const CODEX_SHARE = 0.6
/** About one second after the window appears; the margin is the machine's. */
const ROWS_WITHIN_MS = 1500

/** Every agent start the stubs logged, oldest first. */
const starts = () =>
  existsSync(STARTS)
    ? readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

function writeFixtures(records, groups) {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(`${ROOT}/transcripts`, { recursive: true })
  mkdirSync(`${ROOT}/codex-sessions`, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id })
  seedTrustedRoots(DIR, [ROOT])
  // A login shell that answers at once, the stub-first PATH kept.
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The agents: log the start, then stay up and say nothing.
  for (const name of ['claude', 'codex'])
    writeFileSync(
      `${BIN}/${name}`,
      `#!/bin/sh\necho '{"agent":"${name}","pid":'$$'}' >> ${JSON.stringify(STARTS)}\nexec sleep 600\n`,
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
  mkdirSync(path.join(DIR, 'sidebar-layouts', 'windows'), { recursive: true })
  writeFileSync(
    path.join(DIR, 'sidebar-layouts', 'windows', `${KEY}.json`),
    JSON.stringify({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        sessionIds: g.ids,
        collapsed: false,
        cwd: ROOT,
        terminals: [],
        workspaceId: WS.id
      })),
      displayOrder: groups.map((g) => g.id)
    })
  )
  for (const r of records) seedSessionRecord(DIR, r)
}

function chatRecord(id, codex) {
  return {
    id,
    adapterId: codex ? 'codex-chat' : 'claude-chat',
    transport: 'events',
    ...(codex ? { codexThreadId: randomUUID() } : { claudeSessionId: randomUUID() }),
    cwd: ROOT,
    folderName: 'restore-timing-root',
    displayName: `${codex ? 'Codex' : 'Claude'} ${id.slice(0, 8)}`,
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

/** Installed in the page as soon as it exists: polls the sidebar every 10 ms
 *  and records, against the page's own start, when every seeded row is in
 *  its group, and whether the restore prompt ever showed. */
function installWatch(expected) {
  const w = window
  w.__restoreTiming = { inGroupsAt: null, promptSeen: false }
  const tick = () => {
    const state = w.__restoreTiming
    if ([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Restore'))
      state.promptSeen = true
    if (state.inGroupsAt !== null) return
    const all = expected.every(({ group, ids }) => {
      const foot = document.querySelector(
        `[data-sidebar-drop-zone="group-end"][data-group-id="${group}"]:not(.sidebar-empty-row)`
      )
      const rail = foot?.parentElement
      if (!rail) return false
      const rows = new Set(
        [...rail.querySelectorAll('[data-sidebar-item-type="session"]')].map((r) =>
          r.getAttribute('data-sidebar-item-id')
        )
      )
      return ids.every((id) => rows.has(id))
    })
    if (all) state.inGroupsAt = performance.now()
  }
  tick()
  w.__restoreTimer = setInterval(tick, 10)
}

export async function run(t) {
  const groups = Array.from({ length: GROUPS }, (_, g) => ({
    id: `restore-timing-group-${g}`,
    name: `Group ${g + 1}`,
    ids: Array.from({ length: PER_GROUP }, () => randomUUID())
  }))
  const all = groups.flatMap((g) => g.ids)
  const records = all.map((id, i) => chatRecord(id, i < all.length * CODEX_SHARE))
  writeFixtures(records, groups)
  const env = {
    SHELL: `${BIN}/bash`,
    PATH: `${BIN}:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: `${ROOT}/transcripts`,
    CLAVE_CODEX_ROOT: `${ROOT}/codex-sessions`
  }
  const expected = groups.map((g) => ({ group: g.id, ids: g.ids }))

  let app = null
  try {
    // The watch is installed by an init script, before the page's own code
    // runs, so the figure starts at the window's navigation.
    const launched = await launchApp(DIR, {
      server: 'separate',
      env,
      beforeBoot: async (win) => win.evaluate(installWatch, expected)
    })
    app = launched.app
    const { win } = launched
    const timing = await until(
      () =>
        win.evaluate(() =>
          window.__restoreTiming?.inGroupsAt != null ? window.__restoreTiming : null
        ),
      { tries: 120, gapMs: 250 }
    )
    const seen = timing ?? (await win.evaluate(() => window.__restoreTiming))
    const ms = seen?.inGroupsAt == null ? null : Math.round(seen.inGroupsAt)
    t.check(
      `the ${all.length} tabs are in their ${GROUPS} groups within ${ROWS_WITHIN_MS} ms of the window (took ${ms ?? 'never'} ms)`,
      ms !== null && ms <= ROWS_WITHIN_MS,
      { ms, promptSeen: seen?.promptSeen }
    )
    t.check('no restore prompt stood before the chats', seen?.promptSeen === false, seen)

    // Every tab is a session once, nothing brought back twice.
    const listed = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const ours = list.sessions.filter((s) => all.includes(s.id))
      return ours.length === all.length ? list : null
    })
    const ids = (listed ?? (await callMcp(app, 'list', {}))).sessions.map((s) => s.id)
    t.check(
      'every restored tab is one session, none twice, none missing',
      all.every((id) => ids.filter((x) => x === id).length === 1),
      { listed: ids.length, expected: all.length }
    )
    const layoutGroups = (listed?.groups ?? []).filter((g) => groups.some((x) => x.id === g.id))
    t.check(
      'the groups hold their members as saved',
      groups.every((g) => {
        const back = layoutGroups.find((x) => x.id === g.id)
        return back && [...back.sessionIds].sort().join() === [...g.ids].sort().join()
      }),
      layoutGroups.map((g) => ({ id: g.id, n: g.sessionIds.length }))
    )

    // No agent started for a chat nobody opened.
    await new Promise((r) => setTimeout(r, 2000))
    t.check('no agent started for the 100 unopened chats', starts().length === 0, starts())

    // Opening one starts that one, and only that one.
    const opened = groups[0].ids[0]
    await win.click(`[data-sidebar-item-id="${opened}"] button`)
    const one = await until(() => (starts().length >= 1 ? starts() : null), { tries: 40 })
    await new Promise((r) => setTimeout(r, 1000))
    t.check(
      'opening a restored chat starts exactly its agent',
      !!one && starts().length === 1,
      starts()
    )
  } finally {
    for (const s of starts()) {
      try {
        process.kill(s.pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
    if (app) await app.close()
  }
}
