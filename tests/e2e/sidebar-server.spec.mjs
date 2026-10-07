/**
 * The sidebar lives on the server (PRDCT-3241). What this proves, on the real
 * app, that no other spec does: a caller that is NOT a window changes a
 * window's sidebar through the server's API and the window draws it (the
 * push channel end to end, the first routed subscription of the split); a
 * stale whole-layout write is refused with the current snapshot and changes
 * nothing, on screen or on disk; the window's own save still lands on the
 * server, revision advanced, file written; and when the app is attached to a
 * server that cannot host windows, the shell keeps the sidebar and that
 * server holds no layout. Since verifier round 1: a write omitting a live
 * tab, the two-writer race, the stale window save on the IPC road, the
 * notice left alone (provoked first), a plain pty refused between windows,
 * a window that booted before the server hearing it once it answers, a
 * pending rename surviving a group's move to another window with nobody
 * told of a loss, an edit under fire kept or told, no sidebar save over IPC
 * once the server is up, and a group born during the restore kept.
 *
 * Fails if: the push never reaches the window (the group created over the
 * API is not drawn), the revision guard is dropped (the stale write answers
 * 200 and empties the sidebar), the renderer's save stops going through the
 * server (the revision does not advance after the MCP group), or the layout
 * file leaves its place (`sidebar-layouts/windows/<key>.json`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  serverEndpoint,
  identityOf,
  callMcp,
  windowLayout,
  openWindow,
  until
} from './harness.mjs'

const ROOT = fixturePath('sidebar-server-root')
const WS = {
  id: 'cdcdcdcd-0000-4000-8000-00000000000c',
  name: 'Served',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The rendered groups, by name, with their member counts. */
function drawnGroups(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('.group-scope')].map((card) => {
      const header = card.querySelector('[data-sidebar-item-type="group"]')
      return {
        id: header?.dataset.sidebarItemId ?? null,
        name: header?.querySelector('span.truncate')?.textContent ?? null,
        rows: card.querySelectorAll('.group-rail [data-sidebar-item-id]').length
      }
    })
  )
}

/** Whether the sidebar draws a row for this id. */
const rowDrawn = (win, id) =>
  win.evaluate((sid) => !!document.querySelector(`[data-sidebar-item-id="${sid}"]`), id)
const noticeCount = (win) => win.locator('[data-testid="server-notice"]').count()

/** The main process's notifications, recorded at the IPC handler (the same
 *  tap `spyPtySpawn` uses; `_invokeHandlers` is Electron-private and fails
 *  loudly if it ever goes). */
async function spyNotifications(app) {
  return app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get('notification:show')
    if (!original) return false
    globalThis.__e2eNotifications = []
    handlers.set('notification:show', async (event, options) => {
      globalThis.__e2eNotifications.push(options)
      return original(event, options)
    })
    return true
  })
}
const notifications = (app) => app.evaluate(() => globalThis.__e2eNotifications ?? [])
const toldOfALoss = async (app) =>
  (await notifications(app)).some((n) => /could not be kept/i.test(String(n?.title ?? '')))
/** How many sidebar calls came over IPC (main's seam under --test-no-activate). */
const ipcCounts = (app) =>
  app.evaluate(() => globalThis.__claveE2E?.sidebarIpc ?? { load: 0, save: 0 })

const api = (url, token) => {
  const base = String(url).replace(/\/+$/, '')
  const request = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { raw: text }
    }
    return { status: res.status, body: parsed }
  }
  return {
    layout: (windowKey) => request('GET', `/sidebar/layout?windowKey=${windowKey}`),
    layouts: () => request('GET', '/sidebar/layouts'),
    save: (body) => request('POST', '/sidebar/layout', body),
    createGroup: (body) => request('POST', '/sidebar/groups', body),
    renameGroup: (body) => request('POST', '/sidebar/groups/rename', body)
  }
}

function seed(dir) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ROOT])
}

/** The discovery file once the boot has decided. */
const decided = (dir) => until(() => serverEndpoint(dir), { tries: 80, gapMs: 250 })

export async function run(t) {
  // ── 1. The server runs in the app: the API drives the window's sidebar ──
  {
    const DIR = userDataDir('sidebar-server')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'in-process' })
    try {
      const disc = await decided(DIR)
      t.equal('the app is on its in-process server', disc?.mode, 'in-process')
      const client = api(disc.url, disc.token)
      const identity = await identityOf(win)
      const key = identity?.windowKey
      t.check('the window has a persisted key', typeof key === 'string' && key.length > 0, identity)
      t.check('the notification tap is in', (await spyNotifications(app)) === true)
      const ipcAtStart = await ipcCounts(app)

      // The window's boot read happened through the server: its layout is
      // known there, and the sidebar is empty to begin with.
      const first = await until(async () => {
        const r = await client.layout(key)
        return r.status === 200 ? r.body : null
      })
      t.check('GET /sidebar/layout answers this window', !!first, first)
      const revisionAtBoot = first?.revision ?? -1

      // A caller that is not a window creates a group: the window draws it.
      const created = await client.createGroup({
        windowKey: key,
        group: { name: 'From the server', sessionIds: [] }
      })
      t.equal('POST /sidebar/groups creates a group', created.status, 200)
      const groupId = created.body?.group?.id
      t.check('and answers its id', typeof groupId === 'string', created.body)
      const drawn = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === groupId && g.name === 'From the server')
          ? true
          : null
      )
      t.check('the window draws the group the server created', drawn === true, {
        groups: await drawnGroups(win)
      })

      // A rename over the API: the same road.
      const renamed = await client.renameGroup({
        windowKey: key,
        groupId,
        name: 'Renamed by the server'
      })
      t.equal('POST /sidebar/groups/rename answers', renamed.status, 200)
      const seenRename = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === groupId && g.name === 'Renamed by the server')
          ? true
          : null
      )
      t.check('the window shows the new name', seenRename === true, {
        groups: await drawnGroups(win)
      })

      // A stale whole-layout write: refused with the current snapshot, and
      // NOTHING changes, on screen or on disk.
      const stale = await client.save({
        windowKey: key,
        baseRevision: revisionAtBoot,
        groups: [],
        displayOrder: []
      })
      t.equal('a save on a stale revision is refused', stale.status, 422)
      t.equal('as a LayoutConflict', stale.body?._tag, 'LayoutConflict')
      t.check(
        'carrying the current snapshot, which holds the group',
        stale.body?.current?.groups?.some((g) => g.id === groupId) === true,
        stale.body
      )
      await win.waitForTimeout(600)
      t.check(
        'the sidebar still shows the group after the refused write',
        (await drawnGroups(win)).some((g) => g.id === groupId),
        await drawnGroups(win)
      )
      const file = windowLayout(DIR, key)
      t.check(
        "the window's layout file holds the group (same path as before the split)",
        file?.groups?.some((g) => g.id === groupId) === true,
        file
      )

      // The window's own save goes through the server too: a group made in
      // the renderer (through MCP, which asks the renderer) advances the
      // server's revision and lands in the file.
      const before = (await client.layout(key)).body
      const mine = await callMcp(app, 'createGroup', { name: 'From the window' })
      const landed = await until(async () => {
        const r = await client.layout(key)
        return r.body?.groups?.some((g) => g.id === mine.groupId) ? r.body : null
      })
      t.check('the server holds the group the window made', !!landed, { mine, landed })
      t.check(
        'and its revision advanced past the one before',
        (landed?.revision ?? 0) > (before?.revision ?? 0),
        { before: before?.revision, after: landed?.revision }
      )
      const bothDrawn = await drawnGroups(win)
      t.check(
        'both groups are on screen',
        bothDrawn.some((g) => g.id === groupId) && bothDrawn.some((g) => g.id === mine.groupId),
        bothDrawn
      )
      const fileAfter = await until(() => {
        const f = windowLayout(DIR, key)
        return f?.groups?.some((g) => g.id === mine.groupId) ? f : null
      })
      t.check('and the file holds both', fileAfter?.groups?.length === 2, fileAfter)

      // The guard is a guard, not a lock: a write naming the current
      // revision lands, and the window applies it.
      const current = (await client.layout(key)).body
      const accepted = await client.save({
        windowKey: key,
        baseRevision: current.revision,
        groups: current.groups.filter((g) => g.id === groupId),
        displayOrder: current.displayOrder.filter((id) => id !== mine.groupId)
      })
      t.equal('a save on the current revision is accepted', accepted.status, 200)
      t.equal('and bumps the revision by one', accepted.body?.revision, current.revision + 1)
      const trimmed = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === mine.groupId) ? null : true
      )
      t.check('the window dropped the group the accepted write removed', trimmed === true, {
        groups: await drawnGroups(win)
      })

      // A server write that omits a LIVE tab: the tab stays drawn, and the
      // window tells the server about it again (verifier round 1, gap 9).
      const tab = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'live' })
      const placed = await until(async () =>
        (await client.layout(key)).body?.displayOrder?.includes(tab.sessionId) ? true : null
      )
      t.check('the new tab reached the server', placed === true, tab)
      const withTab = (await client.layout(key)).body
      const omitting = await client.save({
        windowKey: key,
        baseRevision: withTab.revision,
        groups: withTab.groups,
        displayOrder: withTab.displayOrder.filter((id) => id !== tab.sessionId)
      })
      t.equal('an outside write omitting the live tab is accepted', omitting.status, 200)
      await win.waitForTimeout(800)
      t.check('the live tab is still drawn', await rowDrawn(win, tab.sessionId), {
        groups: await drawnGroups(win)
      })
      const toldAgain = await until(async () => {
        const r = (await client.layout(key)).body
        return r?.displayOrder?.includes(tab.sessionId) && r.revision > omitting.body.revision
          ? r
          : null
      })
      t.check('and the window told the server about it again', !!toldAgain, {
        after: toldAgain?.revision,
        omitting: omitting.body?.revision
      })

      // The race: an outside write and the window's own edit on the same
      // revision, three rounds. Whichever lands first, the window's group
      // survives: a refused save re-applies its change over the server's
      // snapshot and saves again (verifier round 1, Major 2).
      for (let round = 0; round < 3; round++) {
        const cur = (await client.layout(key)).body
        const outsideId = `outside-${round}`
        const [outside, mine] = await Promise.all([
          client.save({
            windowKey: key,
            baseRevision: cur.revision,
            groups: [
              ...cur.groups,
              {
                id: outsideId,
                name: `Outside ${round}`,
                sessionIds: [],
                collapsed: false,
                cwd: null,
                terminals: []
              }
            ],
            displayOrder: [...cur.displayOrder, outsideId]
          }),
          callMcp(app, 'createGroup', { name: `Mine ${round}` })
        ])
        const settled = await until(async () => {
          const r = (await client.layout(key)).body
          const ids = r?.groups?.map((g) => g.id) ?? []
          const outsideOk = outside.status === 200 ? ids.includes(outsideId) : true
          return outsideOk && ids.includes(mine.groupId) ? r : null
        })
        t.check(
          `race ${round}: the window's group is on the server (outside write ${outside.status})`,
          !!settled,
          { outside: outside.status, mine: mine.groupId, server: (await client.layout(key)).body }
        )
        const drawnNow = await drawnGroups(win)
        t.check(
          `race ${round}: the window's group is drawn`,
          drawnNow.some((g) => g.id === mine.groupId),
          drawnNow
        )
      }

      // Everything above went the server's road: no sidebar save crossed
      // IPC since the server came up (verifier round 2, gap 5).
      const ipcAtEnd = await ipcCounts(app)
      t.equal(
        'no sidebar save went over IPC once the server was up',
        ipcAtEnd.save - ipcAtStart.save,
        0,
        { ipcAtStart, ipcAtEnd }
      )

      // An edit that cannot be kept is TOLD, never silent (verifier round 2,
      // gap 7): the window renames a group while an outside write removes
      // it. Whichever lands first, either the rename is on the server, or
      // the rename found no group to rename, or the person was notified.
      const doomed = await callMcp(app, 'createGroup', { name: 'Doomed' })
      await until(async () =>
        (await client.layout(key)).body?.groups?.some((g) => g.id === doomed.groupId) ? true : null
      )
      const beforeDoom = (await client.layout(key)).body
      let renameFailed = false
      const [removal] = await Promise.all([
        client.save({
          windowKey: key,
          baseRevision: beforeDoom.revision,
          groups: beforeDoom.groups.filter((g) => g.id !== doomed.groupId),
          displayOrder: beforeDoom.displayOrder.filter((id) => id !== doomed.groupId)
        }),
        callMcp(app, 'rename', {
          target: 'group',
          id: doomed.groupId,
          name: 'Renamed under fire'
        }).catch(() => {
          renameFailed = true
        })
      ])
      const settledDoom = await until(async () => {
        const r = (await client.layout(key)).body
        const kept = r?.groups?.some(
          (g) => g.id === doomed.groupId && g.name === 'Renamed under fire'
        )
        if (kept) return { kept: true }
        if (renameFailed) return { renameFailed: true }
        if (await toldOfALoss(app)) return { told: true }
        return null
      })
      t.check(
        `the rename under fire was kept, refused to the caller, or told (removal ${removal.status})`,
        !!settledDoom,
        { removal: removal.status, notifications: await notifications(app) }
      )
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ── 2. Attached to a server elsewhere: the shell keeps the sidebar ──
  {
    const DIR = userDataDir('sidebar-server-attached')
    seed(DIR)
    const { app, win, server } = await launchApp(DIR, { server: 'attached' })
    try {
      const disc = await decided(DIR)
      t.equal('the app is attached', disc?.mode, 'attached')
      const client = api(server.url, server.token)
      const identity = await identityOf(win)
      const key = identity?.windowKey
      const mine = await callMcp(app, 'createGroup', { name: 'Kept by the shell' })
      const seen = await until(async () =>
        (await drawnGroups(win)).some((g) => g.id === mine.groupId) ? true : null
      )
      t.check('a group made in the window is drawn', seen === true, await drawnGroups(win))
      const file = await until(() => {
        const f = windowLayout(DIR, key)
        return f?.groups?.some((g) => g.id === mine.groupId) ? f : null
      })
      t.check("and written to the app's own layout file", !!file, { key, file })
      const remote = await client.layouts()
      t.equal('the attached server answers its layouts', remote.status, 200)
      t.check(
        'and holds none: it has no windows to host, the shell kept the sidebar',
        Array.isArray(remote.body) && remote.body.length === 0,
        remote.body
      )
      // The IPC road keeps the revision guard (verifier round 1, gap 7).
      const stale = await win.evaluate(() =>
        window.electronAPI.sidebarLayoutSave({ groups: [], displayOrder: [] }, 0)
      )
      t.equal('a stale window save on the IPC road is refused', stale?.reason, 'conflict')
      await win.waitForTimeout(500)
      t.check(
        'and the group is still drawn',
        (await drawnGroups(win)).some((g) => g.id === mine.groupId),
        await drawnGroups(win)
      )
      // A sidebar edit on the IPC road leaves the sessions' server notice
      // alone (Minor 3 of round 1, gap 4 of round 2): the notice is
      // PROVOKED first (a sessions call the standalone server refuses), then
      // the edit, and the notice must still be up.
      await win.evaluate(() => window.electronAPI.sessionsList().catch(() => null))
      const provoked = await until(async () => ((await noticeCount(win)) === 1 ? true : null))
      t.check('the server notice is up after a refused sessions call', provoked === true)
      await callMcp(app, 'createGroup', { name: 'Another edit' })
      await win.waitForTimeout(800)
      t.equal(
        'and still up after a sidebar edit that never reached the server',
        await noticeCount(win),
        1
      )
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ── 3. A plain pty cannot move between windows: refused, and it stays ──
  {
    const DIR = userDataDir('sidebar-server-plain')
    seed(DIR)
    // The spawn's default comes from the shell's own preferences file
    // (clave-file-handlers.ts), not the settings domain's preferences.json.
    writeFileSync(path.join(DIR, 'clave-preferences.json'), JSON.stringify({ tmuxMode: false }))
    const { app, win } = await launchApp(DIR, { server: 'in-process' })
    try {
      await decided(DIR)
      const tab = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'plain' })
      const second = await openWindow(app, win)
      const result = await win.evaluate(
        ({ id, target }) => window.electronAPI.windowMoveSessions([id], target),
        { id: tab.sessionId, target: second.windowId }
      )
      t.equal(
        'a plain pty is refused as not-tmux',
        result?.refused?.[0]?.reason,
        'not-tmux',
        result
      )
      t.equal('and nothing moved', result?.moved?.length, 0, result)
      const listed = await callMcp(app, 'list', {})
      t.check(
        'the tab is still in its window',
        listed.sessions.some((s) => s.id === tab.sessionId),
        listed.sessions.map((s) => s.id)
      )
      t.check('and still drawn there', await rowDrawn(win, tab.sessionId))
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ── 4. A window that boots before the server hears it once it answers ──
  {
    const DIR = userDataDir('sidebar-server-late')
    seed(DIR)
    const { app, win } = await launchApp(DIR, {
      server: 'in-process',
      env: { CLAVE_E2E_SERVER_BOOT_DELAY_MS: '6000' }
    })
    try {
      const disc = await decided(DIR)
      t.equal('the server came up late, in-process', disc?.mode, 'in-process')
      const client = api(disc.url, disc.token)
      const key = (await identityOf(win))?.windowKey
      const created = await client.createGroup({
        windowKey: key,
        group: { name: 'After a late boot', sessionIds: [] }
      })
      t.equal('the API creates a group once the server is up', created.status, 200)
      const drawn = await until(
        async () =>
          (await drawnGroups(win)).some((g) => g.id === created.body?.group?.id) ? true : null,
        { tries: 48, gapMs: 250 }
      )
      t.check('the window that booted before the server draws it', drawn === true, {
        groups: await drawnGroups(win)
      })
      const mine = await callMcp(app, 'createGroup', { name: 'From the late window' })
      const landed = await until(async () =>
        (await client.layout(key)).body?.groups?.some((g) => g.id === mine.groupId) ? true : null
      )
      t.check("and the window's own group reaches the server", landed === true, mine)
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ── 5. A group moved to another window while a rename is pending: the
  //       rename survives, nobody is told of a loss (verifier round 2,
  //       Major 2 and gap 8) ──
  {
    const DIR = userDataDir('sidebar-server-move')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'in-process' })
    try {
      const disc = await decided(DIR)
      const client = api(disc.url, disc.token)
      const key = (await identityOf(win))?.windowKey
      t.check('the notification tap is in', (await spyNotifications(app)) === true)
      const tab = await callMcp(app, 'openSession', { cwd: ROOT, mode: 'terminal', name: 'rider' })
      const moving = await callMcp(app, 'createGroup', { name: 'Moving' })
      await callMcp(app, 'moveSession', { sessionId: tab.sessionId, groupId: moving.groupId })
      const staying = await callMcp(app, 'createGroup', { name: 'Staying' })
      await until(async () => {
        const r = (await client.layout(key)).body
        return r?.groups?.some(
          (g) => g.id === moving.groupId && g.sessionIds.includes(tab.sessionId)
        ) && r.groups.some((g) => g.id === staying.groupId)
          ? true
          : null
      })
      const second = await openWindow(app, win)
      const key2 = (await identityOf(second.page))?.windowKey
      const [moved] = await Promise.all([
        win.evaluate(({ id, target }) => window.electronAPI.windowMoveGroup({ id }, target), {
          id: moving.groupId,
          target: second.windowId
        }),
        callMcp(app, 'rename', { target: 'group', id: staying.groupId, name: 'Renamed meanwhile' })
      ])
      t.check('the group moved', moved?.ok === true && moved.moved.includes(tab.sessionId), moved)
      const landed = await until(async () => {
        const w1 = (await client.layout(key)).body
        const w2 = (await client.layout(key2)).body
        const renamed = w1?.groups?.some(
          (g) => g.id === staying.groupId && g.name === 'Renamed meanwhile'
        )
        const gone = !w1?.groups?.some((g) => g.id === moving.groupId)
        const arrived = w2?.groups?.some(
          (g) => g.id === moving.groupId && g.sessionIds.includes(tab.sessionId)
        )
        return renamed && gone && arrived ? { w1, w2 } : null
      })
      t.check('the pending rename survived the move, on the server', !!landed, landed)
      await win.waitForTimeout(800)
      t.check('and nobody was told of a loss', !(await toldOfALoss(app)), await notifications(app))
    } finally {
      await app.close().catch(() => {})
    }
  }

  // ── 6. A group created on the server during the window's boot restore is
  //       kept by the window's first save (verifier round 2, Major 1) ──
  {
    const DIR = userDataDir('sidebar-server-bootwipe')
    seed(DIR)
    const { app, win } = await launchApp(DIR, { server: 'in-process', settleMs: 0 })
    try {
      const disc = await decided(DIR)
      const client = api(disc.url, disc.token)
      const key = (await identityOf(win))?.windowKey
      const born = await client.createGroup({
        windowKey: key,
        group: { name: 'Born during the restore', sessionIds: [] }
      })
      t.equal('a group is created while the window restores', born.status, 200)
      await win.waitForTimeout(6000)
      const after = (await client.layout(key)).body
      t.check(
        "the window's first save kept it",
        after?.groups?.some((g) => g.id === born.body?.group?.id) === true,
        after
      )
      t.check(
        'and the window draws it',
        (await drawnGroups(win)).some((g) => g.id === born.body?.group?.id),
        await drawnGroups(win)
      )
    } finally {
      await app.close().catch(() => {})
    }
  }
}
