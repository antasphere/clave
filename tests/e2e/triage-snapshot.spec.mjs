// Runs both server modes itself: in-process, then separate (issue #227).
/**
 * "Debug Clave…" prepares a support conversation about the RUNNING app, and
 * looking must not touch anything: through the preload boundary
 * (`window.electronAPI.triagePrepare` / `triageSnapshot`), on an install with
 * two windows on two workspaces (the second hidden from the first window), a
 * terminal in a group, a live chat and a dormant chat record, built by the
 * named fixture scenario `diagnostics/triage-snapshot-<mode>`.
 *
 * What it holds, in each mode:
 *  - the snapshot names this instance (the shell pid, the asking window), the
 *    server's mode and who owns it, both windows and both workspaces, the
 *    terminal and both chats with their transport and window;
 *  - the bundle is written private (folders 0700, files 0600), its context
 *    and prompt agree with the answer, and the external commands point at it;
 *  - no server token, MCP token or per-session token, no title Clave
 *    generated and no provider conversation id appears in any file or answer;
 *    a label the user gave a tab does;
 *  - the sessions, the terminal's tmux session and the record files are the
 *    same after as before, including two record files planted AFTER boot that
 *    the recovery listing (`sessions.listAdoptable`) would have deleted, and
 *    no agent was started by looking;
 *  - a snapshot writes nothing;
 *  - separate mode: with the server process killed, a prepare still answers
 *    within seconds, says the server is gone, and writes its bundle.
 *
 * What makes it able to fail: on the base (dev 5e9fe284) the preload has no
 * `triagePrepare` and the first check goes red; route the records through
 * `sessions.listAdoptable`, drop the token stripping, read the server's
 * `title`, or let the bundle inherit the umask, and the matching check goes
 * red. The agents are stubs that only log their start: nothing reaches a
 * provider.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  REPO,
  callMcpIn,
  fixturePath,
  identityOf,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  separateServerDataDir,
  tmuxSessionAlive,
  until,
  userDataDir,
  windows
} from './harness.mjs'

export const deadlineMs = 9 * 60 * 1000

const MODES = ['in-process', 'separate']
const USER_LABEL = 'Triage user label'
const GENERATED_TITLE = 'Planted generated title from a first prompt'
const PLANTED_CONVERSATION = `conv-${randomUUID()}`

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const modeOf = (file) => statSync(file).mode & 0o777

function layout(mode) {
  const DIR = userDataDir(`triage-snapshot-${mode}`)
  const ROOT = fixturePath(`triage-snapshot-${mode}-root`)
  return {
    DIR,
    ROOT,
    BIN: `${ROOT}/bin`,
    STARTS: `${ROOT}/agent-starts.jsonl`,
    WS_A: {
      id: `triage-${mode}-a`,
      name: 'Triage A',
      rootDir: `${ROOT}/clave-e2e-triage-a`,
      profileFile: null,
      createdAt: 1
    },
    WS_B: {
      id: `triage-${mode}-b`,
      name: 'Triage B hidden',
      rootDir: `${ROOT}/clave-e2e-triage-b`,
      profileFile: null,
      createdAt: 2
    },
    KEY_A: `triage-${mode}-window-a`,
    KEY_B: `triage-${mode}-window-b`,
    records:
      mode === 'separate'
        ? path.join(separateServerDataDir(DIR), 'session-records')
        : path.join(DIR, 'session-records')
  }
}

const startsIn = (L) =>
  existsSync(L.STARTS)
    ? readFileSync(L.STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

/** The scenario's SeedInstall: an isolated data folder with two windows on
 *  two workspaces and a dormant chat record whose title Clave generated. */
function seedInstall(L) {
  rmSync(L.ROOT, { recursive: true, force: true })
  rmSync(L.DIR, { recursive: true, force: true })
  for (const d of [L.BIN, L.WS_A.rootDir, L.WS_B.rootDir, L.records])
    mkdirSync(d, { recursive: true })
  seedWorkspaces(L.DIR, { workspaces: [L.WS_A, L.WS_B], activeWorkspaceId: L.WS_A.id })
  seedTrustedRoots(L.DIR, [L.ROOT])
  writeFileSync(
    `${L.BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${L.BIN}/claude`,
    `#!/bin/sh\necho '{"pid":'$$',"session":"'"$CLAVE_SESSION_ID"'"}' >> ${JSON.stringify(L.STARTS)}\nexec sleep 600\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(L.DIR, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'stub-claude',
          name: 'Stub Claude',
          family: 'claude',
          command: [`${L.BIN}/claude`],
          additionalArgs: []
        }
      ],
      globalDefaults: {},
      workspaceOverrides: {}
    })
  )
  writeFileSync(
    path.join(L.DIR, 'windows.json'),
    JSON.stringify({
      version: 1,
      windows: [
        { key: L.KEY_A, workspaceId: L.WS_A.id },
        { key: L.KEY_B, workspaceId: L.WS_B.id }
      ]
    })
  )
  // Two dormant chat records in window B. The window mounts the one it shows
  // at boot, which starts its agent; the other stays registered and unstarted,
  // and that one is the chat a triage must not wake (picked after boot).
  const dormants = [randomUUID(), randomUUID()]
  for (const id of dormants)
    writeFileSync(
      path.join(L.records, `${id}.json`),
      JSON.stringify({
        id,
        adapterId: 'claude-chat',
        transport: 'events',
        claudeSessionId: `${PLANTED_CONVERSATION}-${id.slice(0, 4)}`,
        launchProfileId: 'chat:claude:stub-claude',
        cwd: L.WS_B.rootDir,
        folderName: 'clave-e2e-triage-b',
        displayName: GENERATED_TITLE,
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false,
        workspaceId: L.WS_B.id,
        windowKey: L.KEY_B
      })
    )
  return { dormants }
}

/** Every token the instance holds on disk: the discovery files', the MCP
 *  server's, each session's MCP config bearer. None may reach a triage. */
function tokensOf(L) {
  const tokens = new Set()
  const fromJson = (file) => {
    try {
      const t = JSON.parse(readFileSync(file, 'utf8')).token
      if (typeof t === 'string' && t.length >= 8) tokens.add(t)
    } catch {
      // absent
    }
  }
  const dataDirs = [L.DIR, separateServerDataDir(L.DIR)]
  for (const d of dataDirs) {
    fromJson(path.join(d, 'clave-server.json'))
    fromJson(path.join(d, 'mcp-server.json'))
    const configs = path.join(d, 'mcp-configs')
    if (!existsSync(configs)) continue
    for (const f of readdirSync(configs)) {
      const m = readFileSync(path.join(configs, f), 'utf8').match(/Bearer ([^"\s]+)/)
      if (m) tokens.add(m[1])
    }
  }
  return [...tokens]
}

function recordState(L, planted) {
  const names = existsSync(L.records) ? readdirSync(L.records).sort() : []
  const hashes = Object.fromEntries(
    planted
      .filter((f) => existsSync(path.join(L.records, f)))
      .map((f) => [f, sha(path.join(L.records, f))])
  )
  return { names, hashes }
}

function tmuxNameOf(L, id) {
  for (const f of readdirSync(L.records)) {
    try {
      const r = JSON.parse(readFileSync(path.join(L.records, f), 'utf8'))
      if (r.id === id && r.tmuxName) return r.tmuxName
    } catch {
      // not a record
    }
  }
  return null
}

/** Every session the server holds for these windows: `sessionsList` is
 *  scoped to the window that asks, so both are asked. */
async function heldBy(pages) {
  const all = []
  for (const page of pages)
    all.push(...(await page.evaluate(() => window.electronAPI.sessionsList())))
  return all
}

async function runMode(t, mode, loadTriageSnapshot) {
  const L = layout(mode)
  const env = { SHELL: `${L.BIN}/bash`, PATH: `${L.BIN}:${process.env.PATH}` }
  let app = null
  let seeded = null
  let opened = null
  try {
    const report = await loadTriageSnapshot({
      mode,
      seed: async () => (seeded = seedInstall(L)),
      launch: async () => {
        const launched = await launchApp(L.DIR, { server: mode, env })
        app = launched.app
        return { mode }
      },
      open: async ({ groupName }) => {
        const all = await until(async () => {
          const w = await windows(app)
          return w.length === 2 ? w : null
        })
        if (!all) throw new Error('the two seeded windows did not open')
        const byKey = {}
        for (const w of all) byKey[(await identityOf(w.page)).windowKey] = w
        const a = byKey[L.KEY_A]
        const b = byKey[L.KEY_B]
        if (!a || !b) throw new Error(`windows ${Object.keys(byKey)} are not the seeded keys`)
        const { groupId } = await callMcpIn(app, a.id, 'createGroup', { name: groupName })
        const terminal = (
          await callMcpIn(app, a.id, 'openSession', {
            cwd: L.WS_A.rootDir,
            mode: 'terminal',
            groupId
          })
        ).sessionId
        await callMcpIn(app, a.id, 'rename', { target: 'session', id: terminal, name: USER_LABEL })
        const chat = (
          await callMcpIn(app, b.id, 'openSession', {
            cwd: L.WS_B.rootDir,
            mode: 'claude',
            profile: 'chat:claude:stub-claude',
            workspace: L.WS_B.id
          })
        ).sessionId
        opened = { a, b, groupId, terminal, chat }
        return { terminal, chat, groupId }
      },
      ready: async () => {
        const want = [opened.terminal, opened.chat, ...seeded.dormants]
        const ok = await until(
          async () => {
            const held = await heldBy([opened.a.page, opened.b.page])
            const alive = (await callMcpIn(app, opened.a.id, 'list', {})).sessions.some(
              (s) => s.id === opened.terminal && s.alive
            )
            return alive && want.every((id) => held.some((s) => s.id === id)) ? true : null
          },
          { tries: 120, gapMs: 250 }
        )
        if (!ok) {
          const held = await heldBy([opened.a.page, opened.b.page])
          const listed = [
            ...(await callMcpIn(app, opened.a.id, 'list', {})).sessions,
            ...(await callMcpIn(app, opened.b.id, 'list', {})).sessions
          ]
          throw new Error(
            `the sessions did not all come up: want ${JSON.stringify(want)}, server ${JSON.stringify(held.map((s) => [s.id, s.state]))}, windows ${JSON.stringify(listed.map((s) => [s.id, s.mode, s.alive]))}`
          )
        }
        // The record carries the user's label once the rename is persisted.
        await until(() => tmuxNameOf(L, opened.terminal), { tries: 40 })
      }
    })
    const { a, b, terminal, chat, groupId } = opened
    // The dormant chat under test: a seeded one whose agent never started.
    await new Promise((r) => setTimeout(r, 1500))
    const dormant = seeded.dormants.find((id) => !startsIn(L).some((x) => x.session === id))
    const label = `[${mode}]`
    console.log(
      JSON.stringify({
        scenario: `diagnostics/triage-snapshot-${mode}`,
        runId: report.runId,
        dir: L.DIR
      })
    )

    // ── Before: the sessions, tmux, the records (with two planted after boot) ──
    const tmuxName = tmuxNameOf(L, terminal)
    const gone = randomUUID()
    writeFileSync(path.join(L.records, 'zz-triage-malformed.json'), 'not json {')
    writeFileSync(
      path.join(L.records, 'zz-triage-gone.json'),
      JSON.stringify({
        id: gone,
        cwd: path.join(L.ROOT, 'no-such-folder'),
        folderName: 'no-such-folder',
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      })
    )
    const planted = [
      'zz-triage-malformed.json',
      'zz-triage-gone.json',
      ...seeded.dormants.map((id) => `${id}.json`)
    ]
    const beforeRecords = recordState(L, planted)
    const beforeIds = (await heldBy([a.page, b.page])).map((s) => s.id).sort()
    const beforeStarts = startsIn(L).length
    // The dormant chat is registered (the server holds it, a window shows
    // it) but its agent was never started: readiness asked for presence only.
    t.check(
      `${label} the dormant chat is held but its agent never started`,
      !!dormant && !startsIn(L).some((x) => x.session === dormant),
      { dormants: seeded.dormants, starts: startsIn(L) }
    )
    const tokens = tokensOf(L)
    const discovery = JSON.parse(readFileSync(path.join(L.DIR, 'clave-server.json'), 'utf8'))
    const shellPid = discovery.pid

    // ── Prepare, through the preload, from window A ──
    const result = await a.page.evaluate(() => window.electronAPI.triagePrepare())
    const s = result.snapshot

    t.check(`${label} triagePrepare answers a bundle`, !!result.bundle, result.warnings)
    t.check(
      `${label} the origin is this shell and window A`,
      s.origin.shellPid === shellPid &&
        s.origin.windowId === a.id &&
        s.origin.windowKey === L.KEY_A &&
        typeof s.origin.instanceId === 'string',
      s.origin
    )
    t.check(
      `${label} the server mode and ownership are this run's`,
      s.server.mode === mode &&
        s.server.ownership === (mode === 'separate' ? 'shell-child' : 'shell-process'),
      s.server
    )
    if (mode === 'separate') {
      t.check(
        `${label} the separate server and its terminal process are named and alive`,
        s.server.serverPid === discovery.serverPid &&
          s.server.serverAlive === true &&
          s.server.terminalProcess?.alive === true,
        s.server
      )
    } else {
      t.check(
        `${label} the in-process server is the shell itself`,
        s.server.serverPid === shellPid && s.server.terminalProcess === null,
        s.server
      )
    }
    t.check(
      `${label} the health routes answered`,
      s.server.health.live === 200 && s.server.health.ready !== null,
      s.server.health
    )
    t.check(
      `${label} both windows, each on its own workspace`,
      s.windows.length === 2 &&
        s.windows.some((w) => w.key === L.KEY_A && w.workspaceId === L.WS_A.id) &&
        s.windows.some((w) => w.key === L.KEY_B && w.workspaceId === L.WS_B.id),
      s.windows
    )
    t.check(
      `${label} both workspaces, the hidden one included`,
      s.workspaces.status === 'ok' &&
        [L.WS_A.id, L.WS_B.id].every((id) => s.workspaces.value.some((w) => w.id === id)),
      s.workspaces
    )
    const served = s.sessions.status === 'ok' ? s.sessions.value : []
    const find = (id) => served.find((x) => x.id === id)
    t.check(
      `${label} the terminal and both chats, with transport and window`,
      find(terminal)?.transport === 'pty' &&
        find(terminal)?.windowKey === L.KEY_A &&
        find(chat)?.transport === 'events' &&
        find(chat)?.windowKey === L.KEY_B &&
        find(dormant)?.transport === 'events',
      served
    )
    const listing = (id) => s.windowListings.find((l) => l.windowId === id)
    t.check(
      `${label} each window lists its own tabs`,
      listing(a.id)?.status === 'ok' &&
        listing(a.id).value.sessions.some((x) => x.id === terminal) &&
        listing(a.id).value.groups.some((g) => g.id === groupId) &&
        listing(b.id)?.status === 'ok' &&
        listing(b.id).value.sessions.some((x) => x.id === chat),
      s.windowListings
    )
    t.check(
      `${label} the user's label is kept, a generated title is not`,
      find(terminal)?.userLabel === USER_LABEL && find(dormant)?.userLabel === null,
      [find(terminal), find(dormant)]
    )
    t.check(
      `${label} records are read from disk, the planted dead one included`,
      s.records.status === 'ok' &&
        s.records.value.items.some((r) => r.id === gone) &&
        s.reconciliation.recordsWithoutSession.includes(gone),
      s.records.status === 'ok' ? s.records.value.items.map((r) => r.id) : s.records
    )
    t.check(
      `${label} the planted malformed record is reported, not dropped, and the comparison is partial`,
      s.records.status === 'ok' &&
        (s.records.value.unreadable ?? []).some((u) => u.key === 'zz-triage-malformed') &&
        s.reconciliation.complete === false,
      s.records.status === 'ok' ? s.records.value.unreadable : s.records
    )
    t.check(
      `${label} the opened sessions agree between the server and the windows`,
      ![terminal, chat].some(
        (id) =>
          s.reconciliation.uiOnly.includes(id) ||
          s.reconciliation.serverOnly.includes(id) ||
          s.reconciliation.windowMismatch.includes(id)
      ),
      s.reconciliation
    )
    t.check(
      `${label} support can start in the app`,
      result.agentLaunch === 'in-app',
      result.agentLaunch
    )

    // ── The bundle on disk ──
    const bundle = result.bundle
    const files = bundle ? [bundle.snapshotPath, bundle.contextPath, bundle.promptPath] : []
    t.check(
      `${label} the bundle is private: folders 0700, files 0600`,
      !!bundle &&
        modeOf(path.join(L.DIR, 'triage')) === 0o700 &&
        modeOf(bundle.dir) === 0o700 &&
        files.every((f) => modeOf(f) === 0o600),
      bundle && [modeOf(bundle.dir), ...files.map(modeOf)]
    )
    t.check(
      `${label} the files agree with the answer`,
      !!bundle &&
        readFileSync(bundle.contextPath, 'utf8') === result.contextMarkdown &&
        JSON.parse(readFileSync(bundle.snapshotPath, 'utf8')).origin.instanceId ===
          s.origin.instanceId &&
        readFileSync(bundle.promptPath, 'utf8').includes(bundle.contextPath) &&
        result.launchPrompt.includes(bundle.promptPath) &&
        result.externalCommands.claude.includes(bundle.dir),
      bundle
    )
    const everything = [JSON.stringify(result), ...files.map((f) => readFileSync(f, 'utf8'))].join(
      '\n'
    )
    const leaks = [...tokens, GENERATED_TITLE, PLANTED_CONVERSATION].filter((x) =>
      everything.includes(x)
    )
    t.check(
      `${label} no token, generated title or conversation id is collected (${tokens.length} tokens checked)`,
      tokens.length >= 2 && leaks.length === 0,
      { leaks: leaks.map((x) => x.slice(0, 6) + '…'), tokens: tokens.length }
    )

    // ── A discovery file another shell wrote is set aside whole (in-process:
    // the separate child's own lifecycle reads that file, so it is not touched there) ──
    if (mode === 'in-process') {
      const file = path.join(L.DIR, 'clave-server.json')
      const original = readFileSync(file, 'utf8')
      try {
        writeFileSync(
          file,
          JSON.stringify({
            ...JSON.parse(original),
            url: 'http://127.0.0.1:9',
            pid: 999999,
            clientId: 'another-instance'
          })
        )
        const staleSnap = await a.page.evaluate(() => window.electronAPI.triageSnapshot())
        t.check(
          `${label} a stale discovery file is not used: the live server is asked`,
          staleSnap.server.origin === new URL(discovery.url).origin &&
            staleSnap.server.health.live === 200 &&
            staleSnap.server.clientId === null &&
            staleSnap.warnings.some((w) => w.includes('pid 999999')),
          staleSnap.server
        )
      } finally {
        writeFileSync(file, original)
      }
      // VA-6: this shell's own discovery file, its address carrying its token
      // in the host name: the warning that names that address is scrubbed.
      const own = JSON.parse(original)
      try {
        writeFileSync(file, JSON.stringify({ ...own, url: `http://${own.token}.invalid:9` }))
        const tokenSnap = await a.page.evaluate(() => window.electronAPI.triageSnapshot())
        t.check(
          `${label} a discovery address carrying the token is scrubbed from the answer and its warning`,
          tokenSnap.warnings.some((w) => w.includes('discovery file names')) &&
            !JSON.stringify(tokenSnap).toLowerCase().includes(String(own.token).toLowerCase()),
          tokenSnap.warnings
        )
      } finally {
        writeFileSync(file, original)
      }
      // Round 3: a known token equal to a window key is scrubbed wherever the
      // key appears (it is not only the asking window's origin that carries it).
      try {
        writeFileSync(file, JSON.stringify({ ...own, token: L.KEY_B }))
        const keySnap = await a.page.evaluate(() => window.electronAPI.triageSnapshot())
        t.check(
          `${label} a known token equal to a window key reaches no field`,
          !JSON.stringify(keySnap).includes(L.KEY_B) &&
            keySnap.windows.some((w) => w.key === '<redacted>'),
          keySnap.windows
        )
      } finally {
        writeFileSync(file, original)
      }
      // Round 3: a valid discovery document with a 200000-character token: the
      // prepare answers with its bundle and the token is nowhere.
      const huge = `triage-huge-${'h'.repeat(200_000)}`
      try {
        writeFileSync(file, JSON.stringify({ ...own, token: huge }))
        const big = await a.page.evaluate(() =>
          window.electronAPI.triagePrepare().then(
            (r) => ({ ok: true, r }),
            (e) => ({ ok: false, message: String(e?.message ?? e) })
          )
        )
        const texts = big.ok
          ? [
              JSON.stringify(big.r),
              ...[big.r.bundle?.snapshotPath, big.r.bundle?.contextPath, big.r.bundle?.promptPath]
                .filter(Boolean)
                .map((f) => readFileSync(f, 'utf8'))
            ]
          : [big.message]
        t.check(
          `${label} a 200000-character discovery token is scrubbed and the prepare still answers`,
          big.ok && !!big.r.bundle && texts.every((x) => !x.includes(huge.slice(0, 40))),
          big.ok ? big.r.warnings : big.message.slice(0, 200)
        )
      } finally {
        writeFileSync(file, original)
      }
    }

    // ── A snapshot from window B writes nothing ──
    const bundlesBefore = readdirSync(path.join(L.DIR, 'triage')).length
    const snap = await b.page.evaluate(() => window.electronAPI.triageSnapshot())
    t.check(
      `${label} triageSnapshot answers from window B and writes nothing`,
      snap.origin.windowId === b.id &&
        snap.origin.windowKey === L.KEY_B &&
        readdirSync(path.join(L.DIR, 'triage')).length === bundlesBefore,
      snap.origin
    )

    // ── After: nothing was touched ──
    const afterIds = (await heldBy([a.page, b.page])).map((s) => s.id).sort()
    t.check(
      `${label} the same sessions after`,
      JSON.stringify(afterIds) === JSON.stringify(beforeIds),
      { beforeIds, afterIds }
    )
    t.check(
      `${label} the terminal's tmux session is alive after`,
      !!tmuxName && tmuxSessionAlive(tmuxName),
      tmuxName
    )
    const afterRecords = recordState(L, planted)
    t.check(
      `${label} the record files are unchanged, the planted ones included`,
      JSON.stringify(afterRecords) === JSON.stringify(beforeRecords) &&
        Object.keys(afterRecords.hashes).length === planted.length,
      { beforeRecords, afterRecords }
    )
    t.check(`${label} looking started no agent`, startsIn(L).length === beforeStarts, startsIn(L))
    t.check(
      `${label} the dormant chat is still dormant after`,
      !startsIn(L).some((x) => x.session === dormant) &&
        (await heldBy([a.page, b.page])).some((x) => x.id === dormant),
      startsIn(L)
    )

    // ── Separate mode: the server process is killed; a prepare still answers ──
    if (mode === 'separate') {
      const serverPid = discovery.serverPid
      const parent = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(serverPid)], { encoding: 'utf8' }).trim()
      )
      t.check(`${label} the server pid is this app's own child`, parent === shellPid, {
        serverPid,
        parent,
        shellPid
      })
      if (parent === shellPid) {
        process.kill(serverPid, 'SIGKILL')
        await until(() => {
          try {
            process.kill(serverPid, 0)
            return null
          } catch {
            return true
          }
        })
        const started = Date.now()
        const down = await a.page.evaluate(() => window.electronAPI.triagePrepare())
        const elapsed = Date.now() - started
        t.check(
          `${label} with the server dead, a prepare still answers within 15 s (${elapsed} ms)`,
          elapsed < 15_000 && !!down.bundle,
          down.warnings
        )
        t.check(
          `${label} it says the server is gone and the server's sources failed`,
          down.summary.serverOk === false &&
            down.snapshot.server.serverAlive === false &&
            down.snapshot.sessions.status !== 'ok' &&
            down.snapshot.windows.length === 2 &&
            down.warnings.some((w) => w.includes('not running')),
          { summary: down.summary, server: down.snapshot.server, sessions: down.snapshot.sessions }
        )
      }
    }
  } finally {
    for (const s of startsIn(L)) {
      try {
        process.kill(s.pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
    if (app) await app.close()
    disposeOwnTmux(L.ROOT)
  }
}

/** The tmux sessions this fixture's terminals left: tmux outlives the app,
 *  so after the checks (which need the session alive) every session whose
 *  start path is under THIS fixture's root is ended, by exact name. Nothing
 *  else on the shared socket is touched. */
function disposeOwnTmux(root) {
  let rows = ''
  try {
    rows = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-sessions', '-F', '#{session_name}\t#{session_path}'],
      { encoding: 'utf8', timeout: 5000 }
    )
  } catch {
    return // no tmux server: nothing left
  }
  const under = (p) => p === root || p.startsWith(`${root}/`) || p.startsWith(`/private${root}/`)
  for (const line of rows.split('\n')) {
    const [name, start] = line.split('\t')
    if (!name || !start || !under(start)) continue
    try {
      execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${name}`], {
        stdio: 'ignore',
        timeout: 5000
      })
    } catch {
      // ended meanwhile
    }
  }
}

export async function run(t) {
  const modulePath = fixturePath('triage-snapshot-fixture.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/triage-snapshot.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadTriageSnapshot } = await import(pathToFileURL(modulePath).href)
  for (const mode of MODES) await runMode(t, mode, loadTriageSnapshot)
}
