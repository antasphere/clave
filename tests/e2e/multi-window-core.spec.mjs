/**
 * Multi-window core (PRDCT-1703): a window is the whole app once more, on
 * whatever workspace it shows — the SAME workspace as another window
 * included. Sessions and groups live in the window they were opened in;
 * each window writes its own layout file; a restart brings every window
 * back with its own content; closing a window hands its content to the
 * primary.
 *
 * What this pins, on the REAL app with real PTYs:
 *   - a second window on the SAME workspace opens with its own identity and
 *     its own (empty) sidebar; what one window opens the other never lists;
 *   - a spawn is stamped with the asking window's key AND its workspace,
 *     even when the state file's last-active says otherwise;
 *   - one layout file per window, none carrying another's groups;
 *   - switching a window's workspace touches no other window and is
 *     persisted; a third window on an already-shown workspace opens (no
 *     guard);
 *   - a restart brings BOTH windows back — same keys, same workspaces, each
 *     with its own groups around its re-adopted sessions;
 *   - closing window 2 leaves window 1's terminal ALIVE AND STREAMING (the
 *     buffer still advancing, not process liveness) and hands window 2's
 *     tmux-backed sessions AND groups to window 1 — the persisted window
 *     list and window 2's layout file forget it;
 *   - a restart after that brings one window back with everything.
 *
 * Failure modes this must catch: the old whole-app teardown on any close
 * (the streaming assertion goes red), a shared layout file (a window's
 * group shows up in the other), a spawn stamped from the state file, a
 * close that loses the window's tabs or groups, a restart that forgets a
 * window or its workspace.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  callMcpIn,
  windows,
  identityOf,
  openWindow,
  closeWindow,
  killLeakedE2eTmux,
  tmuxSessionAlive,
  until,
  persistedWindows,
  windowLayout,
  fixturePath
} from './harness.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('multi-window-core')
const ROOT_A = fixturePath('mw-core-a')
const ROOT_B = fixturePath('mw-core-b')
const ws = (letter, root) => ({
  id: `${letter}${letter}${letter}${letter}${letter}${letter}${letter}${letter}-0000-4000-8000-0000000000${letter}1`,
  name: `Core${letter.toUpperCase()}`,
  rootDir: root,
  profileFile: null,
  createdAt: 1
})
const WS_A = ws('a', ROOT_A)
const WS_B = ws('b', ROOT_B)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const groupNames = (layout) => (layout?.groups ?? []).map((g) => g.name).sort()
const listNames = (list) => (list?.groups ?? []).map((g) => g.name).sort()
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

function sessionRecords() {
  const dir = path.join(DIR, 'session-records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')))
}
/** The highest tick number visible in a session's terminal buffer. */
async function lastTick(app, sessionId, windowId) {
  const read = await callMcpIn(app, windowId, 'readSession', {
    sessionId,
    lines: 40,
    callerSessionId: sessionId
  })
  const text = typeof read === 'string' ? read : JSON.stringify(read)
  const ticks = [...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]))
  return ticks.length ? Math.max(...ticks) : -1
}
/** Wait until a window's layout file lists exactly these group names. */
async function untilGroups(key, names) {
  return until(() => (same(groupNames(windowLayout(DIR, key)), names) ? true : null))
}
async function untilListed(app, windowId, names, scope = 'all') {
  return until(async () => {
    const l = await callMcpIn(app, windowId, 'list', { workspace: scope })
    return same(listNames(l), names) ? l : null
  })
}

export async function run(t) {
  killLeakedE2eTmux()
  for (const r of [ROOT_A, ROOT_B]) mkdirSync(r, { recursive: true })
  // The OLD key only: the new build reads it as the last-active workspace.
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT_A, ROOT_B])

  let app = null
  const opened = []
  try {
    // ── window 1: the primary, on the last-active workspace ──
    const launched = await launchApp(DIR)
    app = launched.app
    const win1 = launched.win
    const id1 = await identityOf(win1)
    t.equal('the first window shows the last-active workspace', id1?.workspaceId, WS_A.id)
    t.equal('the first window is the primary', id1?.isPrimary, true)
    t.check('the first window has a persisted key', typeof id1?.windowKey === 'string', id1)
    const key1 = id1.windowKey
    t.check(
      'windows.json lists the first window on its workspace',
      persistedWindows(DIR).some((w) => w.key === key1 && w.workspaceId === WS_A.id),
      persistedWindows(DIR)
    )

    // A group with a ticking terminal in window 1. The loop is the streaming probe.
    const groupA = await callMcp(app, 'createGroup', { name: 'W1 lane' })
    const tick = await callMcp(app, 'openSession', {
      cwd: ROOT_A,
      mode: 'terminal',
      groupId: groupA.groupId,
      command: 'i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.2; done',
      autoRun: true
    })
    opened.push(tick.sessionId)
    await sleep(3000)
    const t0 = await lastTick(app, tick.sessionId, id1.windowId)
    t.check('the terminal in window 1 is streaming (positive control)', t0 > 0, t0)
    t.check(
      "window 1's own layout file carries its group",
      !!(await untilGroups(key1, ['W1 lane'])),
      groupNames(windowLayout(DIR, key1))
    )
    const recTick = sessionRecords().find((r) => r.id === tick.sessionId)
    t.equal("the session record carries window 1's key", recTick?.windowKey, key1)

    // ── window 2 on the SAME workspace ──
    const w2 = await openWindow(app, win1, WS_A.id, { settleMs: 2500 })
    const id2 = await identityOf(w2.page)
    t.equal('window 2 shows the same workspace A', id2?.workspaceId, WS_A.id)
    t.equal('window 2 is not the primary', id2?.isPrimary, false)
    t.check('window 2 has its own key', typeof id2?.windowKey === 'string' && id2.windowKey !== key1, id2)
    const key2 = id2.windowKey
    t.equal('two windows are open', (await windows(app)).length, 2)
    t.check(
      'windows.json lists both windows',
      persistedWindows(DIR).length === 2 && persistedWindows(DIR).some((w) => w.key === key2),
      persistedWindows(DIR)
    )
    const list2 = await callMcpIn(app, id2.windowId, 'list', {})
    t.check(
      "window 2 starts with an empty sidebar — window 1's group is not there",
      list2.groups.length === 0 && list2.sessions.length === 0,
      { groups: listNames(list2), sessions: list2.sessions.length }
    )

    // A group with a session in window 2, from window 2's own renderer.
    const group2 = await callMcpIn(app, id2.windowId, 'createGroup', { name: 'W2 lane' })
    const opened2 = await callMcpIn(app, id2.windowId, 'openSession', {
      cwd: ROOT_A,
      mode: 'terminal',
      groupId: group2.groupId
    })
    opened.push(opened2.sessionId)
    await sleep(2000)
    const rec2 = sessionRecords().find((r) => r.id === opened2.sessionId)
    t.equal("a spawn from window 2 carries window 2's key", rec2?.windowKey, key2)
    t.equal('and its workspace', rec2?.workspaceId, WS_A.id)
    t.check(
      "window 1 never lists window 2's tab",
      !(await callMcpIn(app, id1.windowId, 'list', {})).sessions.some((s) => s.id === opened2.sessionId)
    )
    t.check(
      "window 2's file carries its group and not window 1's",
      !!(await untilGroups(key2, ['W2 lane'])),
      groupNames(windowLayout(DIR, key2))
    )
    t.check(
      "window 1's file is untouched",
      same(groupNames(windowLayout(DIR, key1)), ['W1 lane']),
      groupNames(windowLayout(DIR, key1))
    )
    t.check(
      'the legacy single layout file never appears',
      !existsSync(path.join(DIR, 'sidebar-layout.json'))
    )

    // ── window 2 switches to B: window 1 untouched, the switch persisted ──
    await callMcpIn(app, id2.windowId, 'switchWorkspace', { workspace: WS_B.id })
    await until(() => identityOf(w2.page).then((id) => (id?.workspaceId === WS_B.id ? id : null)))
    t.equal('window 2 now shows workspace B', (await identityOf(w2.page))?.workspaceId, WS_B.id)
    t.equal('window 1 still shows A', (await identityOf(win1))?.workspaceId, WS_A.id)
    t.check(
      'windows.json follows the switch',
      persistedWindows(DIR).find((w) => w.key === key2)?.workspaceId === WS_B.id,
      persistedWindows(DIR)
    )
    // The state file's last-active is now B — yet a RAW pty:spawn from window
    // 1's renderer with no workspace at all is stamped by main from window 1.
    const rawId = await win1.evaluate(
      (cwd) =>
        window.electronAPI
          .spawnSession(cwd, { claudeMode: false, tmuxMode: false })
          .then((info) => info.id),
      ROOT_A
    )
    await sleep(800)
    const rawRec = sessionRecords().find((r) => r.id === rawId)
    t.equal('a raw spawn from window 1 is stamped with A, not the last-active B', rawRec?.workspaceId, WS_A.id)
    t.equal("and with window 1's key", rawRec?.windowKey, key1)
    await win1.evaluate((id) => window.electronAPI.killSession(id), rawId)

    const groupB = await callMcpIn(app, id2.windowId, 'createGroup', { name: 'B from W2' })
    const openedB = await callMcpIn(app, id2.windowId, 'openSession', {
      cwd: ROOT_B,
      mode: 'terminal',
      groupId: groupB.groupId
    })
    opened.push(openedB.sessionId)
    t.check(
      "window 2's file carries both of its groups (A's hidden, B's shown)",
      !!(await untilGroups(key2, ['W2 lane', 'B from W2'])),
      groupNames(windowLayout(DIR, key2))
    )

    // ── a third window on a workspace already shown: no guard, it opens ──
    const w3 = await openWindow(app, win1, WS_A.id, { settleMs: 1500 })
    t.equal('a third window on A opened (no guard)', (await windows(app)).length, 3)
    t.equal('and shows A', (await identityOf(w3.page))?.workspaceId, WS_A.id)
    await closeWindow(app, w3.page)
    t.equal('closing the empty third window leaves two', (await windows(app)).length, 2)
    t.equal('and windows.json forgot it', persistedWindows(DIR).length, 2)

    // ── restart with two windows open: both come back with their own content ──
    await app.close()
    app = null
    await sleep(1500)
    const relaunched = await launchApp(DIR, { settleMs: 7000 })
    app = relaunched.app
    const back = await windows(app)
    t.equal('after a restart both windows come back', back.length, 2)
    const ids = await Promise.all(back.map((w) => identityOf(w.page)))
    const back1 = ids.find((i) => i?.windowKey === key1)
    const back2 = ids.find((i) => i?.windowKey === key2)
    t.check('window 1 came back with its key, on A', back1?.workspaceId === WS_A.id, ids)
    t.check('window 2 came back with its key, on B', back2?.workspaceId === WS_B.id, ids)
    const r1 = await untilListed(app, back1.windowId, ['W1 lane'])
    t.check("window 1 restored ITS group around its session", !!r1, listNames(await callMcpIn(app, back1.windowId, 'list', {})))
    t.check(
      'and the ticking session is back in it, alive',
      r1?.groups.find((g) => g.name === 'W1 lane')?.sessionIds.includes(tick.sessionId) &&
        r1?.sessions.find((s) => s.id === tick.sessionId)?.alive === true,
      r1?.groups
    )
    const r2 = await untilListed(app, back2.windowId, ['W2 lane', 'B from W2'])
    t.check('window 2 restored ITS two groups (the hidden A one included)', !!r2, listNames(await callMcpIn(app, back2.windowId, 'list', {})))
    t.check(
      'with their sessions in place',
      r2?.groups.find((g) => g.name === 'W2 lane')?.sessionIds.includes(opened2.sessionId) &&
        r2?.groups.find((g) => g.name === 'B from W2')?.sessionIds.includes(openedB.sessionId),
      r2?.groups
    )
    const win1b = back.find((w) => w.id === back1.windowId).page
    const win2b = back.find((w) => w.id === back2.windowId).page

    // ── close window 2: window 1 keeps streaming and takes window 2's content ──
    await callMcpIn(app, back2.windowId, 'focus', { sessionId: openedB.sessionId })
    const tmuxB = await until(() => {
      const name = sessionRecords().find((r) => r.id === openedB.sessionId)?.tmuxName
      return name && tmuxSessionAlive(name) ? name : null
    })
    t.check("window 2's session is tmux-backed and running (the hand-over case)", tmuxB !== null, tmuxB)
    await sleep(2000)
    const before = await lastTick(app, tick.sessionId, back1.windowId)
    await closeWindow(app, win2b)
    t.equal('window 2 is gone', (await windows(app)).length, 1)
    await sleep(1500)
    const after = await lastTick(app, tick.sessionId, back1.windowId)
    t.check("window 1's terminal kept streaming across the close", after > before, { before, after })
    const handed = await untilListed(app, back1.windowId, ['W1 lane', 'W2 lane', 'B from W2'])
    t.check("window 1 took in window 2's groups", !!handed, listNames(await callMcpIn(app, back1.windowId, 'list', {})))
    t.check(
      "and window 2's sessions, alive, in their groups",
      handed?.sessions.find((s) => s.id === opened2.sessionId)?.alive === true &&
        handed?.sessions.find((s) => s.id === openedB.sessionId)?.alive === true &&
        handed?.groups.find((g) => g.name === 'W2 lane')?.sessionIds.includes(opened2.sessionId) &&
        handed?.groups.find((g) => g.name === 'B from W2')?.sessionIds.includes(openedB.sessionId),
      handed?.sessions.map((s) => [s.id, s.alive])
    )
    t.check("window 2's tmux session survived (detached, not killed)", tmuxSessionAlive(tmuxB), tmuxB)
    t.equal('windows.json forgot window 2', persistedWindows(DIR).length, 1)
    t.check("window 2's layout file is gone", windowLayout(DIR, key2) === null)
    t.check(
      "window 1's file now carries everything",
      !!(await untilGroups(key1, ['W1 lane', 'W2 lane', 'B from W2'])),
      groupNames(windowLayout(DIR, key1))
    )
    const recHanded = sessionRecords().find((r) => r.id === opened2.sessionId)
    t.equal("a handed-over session's record now carries window 1's key", recHanded?.windowKey, key1)

    // ── restart once more: one window, everything still there ──
    await app.close()
    app = null
    await sleep(1500)
    const again = await launchApp(DIR, { settleMs: 7000 })
    app = again.app
    t.equal('one window comes back', (await windows(app)).length, 1)
    const idF = await identityOf(again.win)
    t.equal('with its key', idF?.windowKey, key1)
    const fin = await untilListed(app, idF.windowId, ['W1 lane', 'W2 lane', 'B from W2'])
    t.check('and every group', !!fin, listNames(await callMcpIn(app, idF.windowId, 'list', {})))
    t.check(
      "including the hidden workspace-B one, scoped to B",
      fin?.groups.find((g) => g.name === 'B from W2')?.workspaceId === WS_B.id,
      fin?.groups
    )
    const state2 = JSON.parse(readFileSync(path.join(DIR, 'workspace-state.json'), 'utf-8'))
    t.check(
      'the new build writes both last-active keys (one-release downgrade safety)',
      state2.lastActiveWorkspaceId === state2.activeWorkspaceId && typeof state2.activeWorkspaceId === 'string',
      state2
    )
    t.check('and window 1 came back on A', idF?.workspaceId === WS_A.id, idF)

    for (const sid of opened) {
      await callMcp(app, 'closeSession', { sessionId: sid }).catch(() => {})
    }
    void win1b
  } finally {
    if (app) await app.close()
    killLeakedE2eTmux()
  }
}
