/**
 * The one-time sidebar-layout migration (PRDCT-1703): on the first boot of
 * the multi-window build (no windows.json yet) the legacy single
 * `sidebar-layout.json` — and the per-workspace files of the halted
 * one-workspace-per-window build, if any — become the FIRST WINDOW's own
 * layout file, every group landing exactly once and stamped with a
 * workspace, the sources kept as `.migrated-backup`.
 *
 * Seeded like a real pre-update profile: live tmux sessions with their
 * records (so the groups survive the renderer's restore, which drops a group
 * whose sessions are gone), a legacy layout mixing a stamped group, an
 * unstamped group placed by its cwd, an unstamped group with no usable cwd
 * (fallback: the last-active workspace), a bare session id in the display
 * order, and one per-workspace file holding a fourth group. The assertions
 * read the FILE the migration wrote and then the app's own scoped listing.
 *
 * Failure modes this must catch: a group dropped or duplicated, a group left
 * unstamped (it would show in every workspace), a source deleted instead of
 * kept, the migration running twice.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  identityOf,
  killLeakedE2eTmux,
  persistedWindows,
  windowLayout,
  fixturePath,
  fixtureTmuxName
} from './harness.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('multi-window-migration')
const ROOT_A = fixturePath('mw-mig-a')
const ROOT_B = fixturePath('mw-mig-b')
const WS_A = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  name: 'MigA',
  rootDir: ROOT_A,
  profileFile: null,
  createdAt: 1
}
const WS_B = {
  id: 'bbbbbbbb-0000-4000-8000-0000000000b2',
  name: 'MigB',
  rootDir: ROOT_B,
  profileFile: null,
  createdAt: 1
}

const SESS = {
  a: { id: '11111111-0000-4000-8000-000000000001', tmux: fixtureTmuxName('mig-a'), cwd: ROOT_A, workspaceId: WS_A.id },
  b: { id: '22222222-0000-4000-8000-000000000002', tmux: fixtureTmuxName('mig-b'), cwd: ROOT_B, workspaceId: WS_B.id },
  c: { id: '33333333-0000-4000-8000-000000000003', tmux: fixtureTmuxName('mig-c'), cwd: ROOT_A, workspaceId: undefined },
  x: { id: '44444444-0000-4000-8000-000000000004', tmux: fixtureTmuxName('mig-x'), cwd: ROOT_B, workspaceId: WS_B.id },
  p: { id: '55555555-0000-4000-8000-000000000005', tmux: fixtureTmuxName('mig-p'), cwd: ROOT_B, workspaceId: WS_B.id }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function seedLiveSession(s) {
  execFileSync('tmux', ['-L', 'clave', 'new-session', '-d', '-s', s.tmux, '-c', s.cwd])
  const dir = path.join(DIR, 'session-records')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `${s.tmux}.json`),
    JSON.stringify({
      tmuxName: s.tmux,
      id: s.id,
      cwd: s.cwd,
      folderName: path.basename(s.cwd),
      claudeMode: false,
      antigravityMode: false,
      codexMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      ...(s.workspaceId ? { workspaceId: s.workspaceId } : {})
    })
  )
}

const group = (id, name, sessionIds, extra = {}) => ({
  id,
  name,
  sessionIds,
  collapsed: false,
  cwd: null,
  terminals: [],
  ...extra
})

export async function run(t) {
  killLeakedE2eTmux()
  mkdirSync(ROOT_A, { recursive: true })
  mkdirSync(ROOT_B, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS_A, WS_B], activeWorkspaceId: WS_A.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT_A, ROOT_B])
  for (const s of Object.values(SESS)) seedLiveSession(s)

  const legacy = {
    groups: [
      group('g-stamped', 'Stamped A', [SESS.a.id], { workspaceId: WS_A.id }),
      group('g-bycwd', 'By cwd B', [SESS.b.id], { cwd: ROOT_B }),
      group('g-orphan', 'Orphan', [SESS.c.id], { cwd: '/nowhere/at/all' })
    ],
    displayOrder: [SESS.x.id, 'g-stamped', 'g-bycwd', 'g-orphan']
  }
  const legacyPath = path.join(DIR, 'sidebar-layout.json')
  const legacyText = JSON.stringify(legacy, null, 2)
  writeFileSync(legacyPath, legacyText)
  // A per-workspace file of the halted build, holding a fourth group.
  const perWsPath = path.join(DIR, 'sidebar-layouts', `${WS_B.id}.json`)
  mkdirSync(path.dirname(perWsPath), { recursive: true })
  const perWsText = JSON.stringify(
    { groups: [group('g-perws', 'Per-workspace B', [SESS.p.id], { workspaceId: WS_B.id })], displayOrder: ['g-perws'] },
    null,
    2
  )
  writeFileSync(perWsPath, perWsText)

  let app = null
  try {
    const launched = await launchApp(DIR, { settleMs: 7000 })
    app = launched.app
    const id = await identityOf(launched.win)
    const key = id?.windowKey
    t.check('the first boot minted a window key', typeof key === 'string', id)
    t.check('windows.json holds that one window', persistedWindows(DIR).length === 1 && persistedWindows(DIR)[0].key === key, persistedWindows(DIR))

    // ── the files ──
    t.check('the legacy file is gone from its old path', !existsSync(legacyPath))
    const backup = `${legacyPath}.migrated-backup`
    t.check('the legacy file is kept as .migrated-backup', existsSync(backup), backup)
    t.check('the backup is the legacy file byte for byte', existsSync(backup) && readFileSync(backup, 'utf-8') === legacyText)
    t.check('the per-workspace file is gone from its old path', !existsSync(perWsPath))
    t.check(
      'and kept as .migrated-backup, byte for byte',
      existsSync(`${perWsPath}.migrated-backup`) && readFileSync(`${perWsPath}.migrated-backup`, 'utf-8') === perWsText
    )

    const file = windowLayout(DIR, key)
    t.check("the first window got a layout file", file !== null)
    const byId = new Map((file?.groups ?? []).map((g) => [g.id, g]))
    t.check(
      'every legacy group landed in it exactly once',
      JSON.stringify([...byId.keys()].sort()) === JSON.stringify(['g-bycwd', 'g-orphan', 'g-perws', 'g-stamped']),
      [...byId.keys()]
    )
    t.equal('the stamped group kept its workspace', byId.get('g-stamped')?.workspaceId, WS_A.id)
    t.equal('the cwd-placed group was stamped by its cwd', byId.get('g-bycwd')?.workspaceId, WS_B.id)
    t.equal('the orphan was stamped with the fallback (last-active A)', byId.get('g-orphan')?.workspaceId, WS_A.id)
    t.equal('the per-workspace group kept its stamp', byId.get('g-perws')?.workspaceId, WS_B.id)
    t.check(
      'the bare session id of the legacy order is in the window order',
      (file?.displayOrder ?? []).includes(SESS.x.id),
      file?.displayOrder
    )

    // ── the app: each workspace lists exactly its own migrated groups ──
    const inA = await callMcp(app, 'list', { workspace: WS_A.id })
    const inB = await callMcp(app, 'list', { workspace: WS_B.id })
    const namesA = inA.groups.map((g) => g.name).sort()
    const namesB = inB.groups.map((g) => g.name).sort()
    t.check('workspace A shows the stamped group and the orphan', JSON.stringify(namesA) === JSON.stringify(['Orphan', 'Stamped A']), namesA)
    t.check('workspace B shows the cwd-placed and the per-workspace groups', JSON.stringify(namesB) === JSON.stringify(['By cwd B', 'Per-workspace B']), namesB)
    const all = await callMcp(app, 'list', {})
    t.equal('no group was duplicated', all.groups.length, 4)
    t.check(
      'every seeded session came back alive (orphan records adopted by the primary)',
      Object.values(SESS).every((s) => all.sessions.some((l) => l.id === s.id && l.alive)),
      all.sessions.map((s) => s.id)
    )

    // A second boot must not re-run anything: the backups stay, nothing changes.
    await app.close()
    app = null
    await sleep(1000)
    const again = await launchApp(DIR, { settleMs: 6000 })
    app = again.app
    t.check('a second boot leaves the backups in place (idempotent)', existsSync(backup) && !existsSync(legacyPath) && !existsSync(perWsPath))
    t.equal('and the same window comes back', (await identityOf(again.win))?.windowKey, key)
    const listed = await callMcp(app, 'list', {})
    t.equal('and the groups are still four', listed.groups.length, 4)

    for (const s of Object.values(SESS)) {
      await callMcp(app, 'closeSession', { sessionId: s.id }).catch(() => {})
    }
  } finally {
    if (app) await app.close()
    killLeakedE2eTmux()
  }
}
