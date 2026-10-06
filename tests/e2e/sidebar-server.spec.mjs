/**
 * The sidebar lives on the server (PRDCT-3241). What this proves, on the real
 * app, that no other spec does: a caller that is NOT a window changes a
 * window's sidebar through the server's API and the window draws it (the
 * push channel end to end, the first routed subscription of the split); a
 * stale whole-layout write is refused with the current snapshot and changes
 * nothing, on screen or on disk; the window's own save still lands on the
 * server, revision advanced, file written; and when the app is attached to a
 * server that cannot host windows, the shell keeps the sidebar and that
 * server holds no layout.
 *
 * Fails if: the push never reaches the window (the group created over the
 * API is not drawn), the revision guard is dropped (the stale write answers
 * 200 and empties the sidebar), the renderer's save stops going through the
 * server (the revision does not advance after the MCP group), or the layout
 * file leaves its place (`sidebar-layouts/windows/<key>.json`).
 */
import { mkdirSync } from 'node:fs'
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
    } finally {
      await app.close().catch(() => {})
    }
  }
}
