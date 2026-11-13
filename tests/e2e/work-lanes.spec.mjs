/**
 * Wave and lane entries keep their place across handoffs (PRDCT-4123), on
 * the built app, through the tools real agents call.
 *
 * The two large-wave shapes of tests/e2e/work-waves.json (37 sessions, then
 * 22) are built the way agents build them: every tab opened with
 * `clave_open_session` from a tab's own token, every assignment and every
 * handover made with `clave_set_work` and `clave_hand_over` from the token of
 * the tab that makes it, on the server road. The titles are written to
 * mislead (a PRIMARY on a superseded lead, a handed over on the current
 * coordinator). Then the sidebar is read as the person reads it:
 *
 * - each wave's group draws one entry per unit and its ordinary sessions,
 *   nothing else, each entry named by its unit's label, never a title;
 * - each entry goes to the session that holds it, or says it is unresolved;
 * - members outside any group fold into one row that goes to the lead, and a
 *   lane with no lead among the window's sessions says so;
 * - an entry's menu lists the lead, the verifier, the workers, the spawned
 *   agents (one spawned by a superseded lead included, current) and the
 *   history; a pane shows where its session sits as a breadcrumb;
 * - a verifier waiting on the person shows on its lane's entry, and its menu
 *   reaches that exact tab;
 * - one more handoff leaves every entry in place; a handover nobody accepted
 *   whose holder closes is shown unresolved, and the person completes it
 *   from the entry's menu;
 * - the search still lists every session as its own row;
 * - a quit with the tmux sessions alive, then one without them (the records
 *   offered and restored), bring back the same entries and the same holders.
 *
 * Fails if: an assignment does not reach the record (the restarts lose it),
 * the wire or the restore drops the field, the sidebar reads a title, an
 * entry follows its newest member, a spawned agent of a superseded lead goes
 * to history, or the person's action does not reach the server.
 *
 * The agents are a stand-in `claude` on PATH (a process that waits); no
 * provider is called, no account is read.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  mcpHttpClient,
  mcpEndpoint,
  mcpRoads,
  toolPayload,
  toolErrored,
  callMcp,
  until,
  userDataDir,
  fixturePath,
  serverDataDirOf,
  recordsRootOf,
  killLeakedE2eTmux
} from './harness.mjs'

export const deadlineMs = 15 * 60 * 1000

const SHAPES = JSON.parse(
  readFileSync(new URL('./work-waves.json', import.meta.url), 'utf-8')
).waves
const DIR = userDataDir('work-lanes')
const ROOT = fixturePath('work-lanes-root')
const WS = {
  id: 'abababab-0000-4000-8000-000000004123',
  name: 'Work lanes',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** A `claude` that only waits, and a login shell that puts it first on PATH. */
const seedStandIns = () => {
  mkdirSync(path.join(ROOT, 'bin'), { recursive: true })
  writeFileSync(
    path.join(ROOT, 'bin', 'claude'),
    `#!/bin/sh
echo "stand-in claude $CLAVE_SESSION_ID"
exec tail -f /dev/null
`,
    { mode: 0o755 }
  )
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
const ENV = { SHELL: path.join(ROOT, 'bin', 'sh'), PATH: `${ROOT}/bin:${process.env.PATH}` }

/** A tab's own token, as the agent inside it reads it. */
const tokenOf = (sessionId) => {
  const file = path.join(serverDataDirOf(DIR), 'mcp-configs', `${sessionId}.json`)
  if (!existsSync(file)) return null
  return (
    JSON.parse(readFileSync(file, 'utf-8')).mcpServers?.clave?.headers?.Authorization?.replace(
      /^Bearer /,
      ''
    ) ?? null
  )
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  seedStandIns()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  killLeakedE2eTmux()

  let app = null
  const clients = new Map()
  const clientOf = async (sessionId) => {
    if (clients.has(sessionId)) return clients.get(sessionId)
    const token = await until(() => tokenOf(sessionId))
    if (!token) throw new Error(`no MCP token for ${sessionId}`)
    const client = mcpHttpClient(mcpEndpoint(DIR), token)
    await client.init()
    clients.set(sessionId, client)
    return client
  }
  /** One tool call that must succeed, as an agent makes it. */
  const call = async (client, tool, args) => {
    const rpc = await client.call(tool, args)
    if (toolErrored(rpc)) throw new Error(`${tool} ${JSON.stringify(args)}: ${JSON.stringify(rpc)}`)
    return toolPayload(rpc)
  }

  try {
    const first = await launchApp(DIR, { env: ENV })
    app = first.app
    let win = first.win
    const seed = await spawnAgentTabIn(app, win, serverDataDirOf(DIR))
    t.check('a first agent tab holds an MCP token', !!seed?.token, seed)
    const seedClient = mcpHttpClient(mcpEndpoint(DIR), seed.token)
    await seedClient.init()
    clients.set(seed.sessionId, seedClient)

    const all = {} // shape name → { ids, groupId }
    const entry = (w, unit) => w.locator(`.work-entry[data-work-unit="${unit}"]`)
    const groupCard = (w, groupId) =>
      w.locator('.group-scope').filter({ has: w.locator(`[data-sidebar-item-id="${groupId}"]`) })
    const rowsIn = (w, groupId) =>
      groupCard(w, groupId).locator('[data-sidebar-item-type="session"]').count()
    const focusedId = async () => (await callMcp(app, 'list', {}))?.focusedSessionId ?? null

    // ── 1. Both waves, built through the agent tools ──
    for (const shape of SHAPES) {
      const group = await call(seedClient, 'clave_create_group', { name: shape.group })
      const ids = {}
      for (const s of shape.sessions) {
        const opener = s.spawnedBy ? await clientOf(ids[s.spawnedBy]) : seedClient
        const opened = await call(opener, 'clave_open_session', {
          cwd: ROOT,
          name: s.title,
          mode: 'claude',
          profile: 'builtin-claude',
          groupId: group.groupId,
          ...(s.spawnedBy ? { attachToParent: true } : {})
        })
        ids[s.key] = opened.sessionId
      }
      for (const step of shape.steps) await applyStep(step, ids)
      all[shape.name] = { ids, groupId: group.groupId }
      const road = (await mcpRoads(app)).filter((r) => r.command === 'setWork').at(-1)?.road
      t.equal(
        `${shape.name}: the assignments take the server road, as real agents do`,
        road,
        'server'
      )
    }

    /** One step of a shape, made by the tab that makes it. */
    async function applyStep(step, ids) {
      const c = step.change
      const client = await clientOf(ids[step.as])
      if (c.type === 'assign')
        return call(client, 'clave_set_work', {
          sessionId: step.target ? ids[step.target] : 'mine',
          ...c.work,
          ...(c.replace || step.replace ? { replace: true } : {})
        })
      if (c.type === 'complete' || c.type === 'leave')
        return call(client, 'clave_set_work', { action: c.type })
      if (c.type === 'offer') return call(client, 'clave_hand_over', { to: ids[c.to] })
      if (c.type === 'accept') return call(client, 'clave_hand_over', { accept: true })
      throw new Error(`unknown step ${JSON.stringify(step)}`)
    }

    /** Every entry of a shape as the sidebar draws it. */
    const readEntries = async (w, shape) => {
      const out = {}
      for (const u of shape.expect.units) {
        const e = entry(w, u.unit)
        await e.waitFor({ timeout: 20_000 })
        out[u.unit] = {
          owner: await e.getAttribute('data-work-owner'),
          target: await e.getAttribute('data-work-target'),
          anchor: await e
            .locator('[data-sidebar-item-id]')
            .first()
            .getAttribute('data-sidebar-item-id'),
          label: await e.locator('[data-testid="session-tab-name"]').innerText()
        }
      }
      return out
    }

    // ── 2. The sidebar draws one entry per unit, from the records alone ──
    for (const shape of SHAPES) {
      const { ids, groupId } = all[shape.name]
      const entries = await readEntries(win, shape)
      for (const u of shape.expect.units) {
        const got = entries[u.unit]
        t.equal(`${shape.name}: ${u.unit} is named by its label, not a title`, got.label, u.label)
        t.equal(`${shape.name}: ${u.unit} owner state`, got.owner, u.owner.state)
        if (u.owner.id)
          t.equal(`${shape.name}: ${u.unit} goes to its holder`, got.target, ids[u.owner.id])
      }
      const drawn = await until(async () => {
        const n = await rowsIn(win, groupId)
        return n === shape.expect.units.length + shape.expect.ordinary.length ? n : null
      })
      t.equal(
        `${shape.name}: the group draws one row per unit and per ordinary session`,
        drawn,
        shape.expect.units.length + shape.expect.ordinary.length
      )
      for (const key of shape.expect.ordinary)
        t.equal(
          `${shape.name}: ordinary ${key} keeps its own row`,
          await win.locator(`[data-sidebar-item-id="${ids[key]}"]`).count(),
          1
        )
    }

    // ── 2b. Members outside any group fold too; a lane with no lead says so ──
    // Three tabs at the top level, opened by the seed tab as its children
    // (any tab may assign any tab since PRDCT-4236): the two members of one lane draw
    // one row that goes to the lead; a lane whose only member here is its
    // verifier reads vacant and says it has no lead.
    const loose = {}
    for (const [key, name] of [
      ['lead', 'Loose · lead'],
      ['verifier', 'Loose · verifier'],
      ['lone', 'Lone · verifier']
    ]) {
      const opened = await call(seedClient, 'clave_open_session', {
        cwd: ROOT,
        name,
        mode: 'claude',
        profile: 'builtin-claude',
        attachToParent: true
      })
      loose[key] = opened.sessionId
    }
    const looseLane = { unit: 'fixture-loose', kind: 'lane', label: 'Loose lane' }
    await call(seedClient, 'clave_set_work', { sessionId: loose.lead, ...looseLane, role: 'lead' })
    await call(seedClient, 'clave_set_work', {
      sessionId: loose.verifier,
      ...looseLane,
      role: 'verifier'
    })
    await call(seedClient, 'clave_set_work', {
      sessionId: loose.lone,
      unit: 'fixture-lone',
      kind: 'lane',
      label: 'Lone lane',
      role: 'verifier'
    })
    // The window holds all three assignments before its rows are counted.
    const assigned = await until(async () => {
      const listed = (await callMcp(app, 'list', {}))?.sessions ?? []
      const unitOf = (id) => listed.find((x) => x.id === id)?.work?.unit
      return unitOf(loose.lead) === 'fixture-loose' &&
        unitOf(loose.verifier) === 'fixture-loose' &&
        unitOf(loose.lone) === 'fixture-lone'
        ? true
        : null
    })
    t.check('the three top-level tabs carry their assignments in the window', assigned === true)
    t.equal(
      'the loose lane is drawn as one entry',
      await until(async () => ((await entry(win, 'fixture-loose').count()) === 1 ? 1 : null)),
      1
    )
    const looseRows = async () =>
      (await win.locator(`[data-sidebar-item-id="${loose.lead}"]`).count()) +
      (await win.locator(`[data-sidebar-item-id="${loose.verifier}"]`).count())
    t.equal(
      'two members outside any group draw one row',
      await until(async () => ((await looseRows()) === 1 ? 1 : null)),
      1
    )
    await entry(win, 'fixture-loose').locator('.sidebar-item').click()
    t.check(
      'clicking the loose lane goes to its lead',
      (await until(async () => ((await focusedId()) === loose.lead ? true : null))) === true
    )
    const lone = entry(win, 'fixture-lone')
    t.equal(
      'a lane with no lead in the window reads vacant',
      await until(async () =>
        (await lone.count()) === 1 && (await lone.getAttribute('data-work-owner')) === 'vacant'
          ? 'vacant'
          : null
      ),
      'vacant'
    )
    t.equal(
      'and its entry says it has no lead',
      await until(async () => {
        const chip = lone.locator('[data-chip="no-owner"]')
        return (await chip.count()) === 1 ? (await chip.innerText()).trim() : null
      }),
      'No lead'
    )

    const mb = all['mobile-beta']
    const MB = SHAPES.find((s) => s.name === 'mobile-beta')

    // ── 3. A click goes to the holder; the unresolved one opens its summary ──
    await entry(win, 'fixture-mobile-a').locator('.sidebar-item').click()
    t.check(
      'clicking lane A goes to its current lead',
      (await until(async () => ((await focusedId()) === mb.ids.s05 ? true : null))) === true
    )
    await entry(win, 'fixture-mobile-e').locator('.sidebar-item').click()
    const summary = win.getByRole('menu', { name: /Sessions of Machine discovery/ })
    await summary.waitFor({ timeout: 10_000 })
    t.equal(
      'the unresolved lane offers the person its superseded lead as a choice',
      await summary.locator(`[data-work-action="make-lead-${mb.ids.s19}"]`).count(),
      1
    )
    await win.keyboard.press('Escape')
    await summary.waitFor({ state: 'hidden' })

    // ── 4. The menu lists every role, the agents and the history ──
    await entry(win, 'fixture-mobile-b').locator('.work-trigger').click()
    const menuB = win.getByRole('menu', { name: /Sessions of Ordered chat history/ })
    await menuB.waitFor()
    const member = (id, role, standing) =>
      menuB.locator(
        `[data-work-member="${id}"][data-work-role="${role}"][data-work-standing="${standing}"]`
      )
    t.equal('lane B: its lead, current', await member(mb.ids.s09, 'lead', 'current').count(), 1)
    t.equal(
      'lane B: its verifier, current',
      await member(mb.ids.s11, 'verifier', 'current').count(),
      1
    )
    t.equal('lane B: its worker', await member(mb.ids.s12, 'worker', 'current').count(), 1)
    t.equal(
      'lane B: the codex worker its lead spawned',
      await member(mb.ids.s26, 'agent', 'current').count(),
      1
    )
    for (const [key, role] of [
      ['s08', 'lead'],
      ['s37', 'lead'],
      ['s10', 'verifier']
    ])
      t.equal(
        `lane B: ${key} in its history`,
        await member(mb.ids[key], role, 'superseded').count(),
        1
      )
    await win.keyboard.press('Escape')
    await entry(win, 'fixture-mobile-a').locator('.work-trigger').click()
    const menuA = win.getByRole('menu', { name: /Sessions of Pair the phone/ })
    await menuA.waitFor()
    t.equal(
      'lane A: the explorer its first, superseded lead spawned stays current and reachable',
      await menuA.locator(`[data-work-member="${mb.ids.s24}"][data-work-role="agent"]`).count(),
      1
    )
    await win.keyboard.press('Escape')

    // ── 5. A pane says where its session sits ──
    await callMcp(app, 'focus', { sessionId: mb.ids.s11 })
    const crumb = await until(async () => {
      const texts = await win.locator('[data-work-breadcrumb]').allInnerTexts()
      return texts.find((x) => x.includes('Ordered chat history')) ?? null
    })
    t.equal(
      "the verifier's pane names its wave, lane and role",
      crumb,
      'Mobile beta › Ordered chat history · Verifier'
    )

    // ── 6. A verifier waiting on the person shows on its lane, and is reached ──
    // The hook's word, written into both folders a state is read from: the
    // process that runs the session (the server's under the separate server)
    // and the app's own, the one whose watch reaches a window live there (a
    // probe of 6 November 2026; the server's folder alone did not).
    const stateDirs = [
      ...new Set([path.join(recordsRootOf(DIR), 'agent-state'), path.join(DIR, 'agent-state')])
    ]
    const writeState = (id, word) => {
      for (const d of stateDirs) {
        mkdirSync(d, { recursive: true })
        writeFileSync(path.join(d, `${id}.state`), word)
      }
    }
    writeState(mb.ids.s06, 'blocked')
    const asks = await until(async () =>
      (await entry(win, 'fixture-mobile-a')
        .locator('.work-trigger')
        .getAttribute('data-status')) === 'needs-you'
        ? true
        : null
    )
    t.check('lane A shows that a session of it waits on the person', asks === true)
    await entry(win, 'fixture-mobile-a').locator('.work-trigger').click()
    await menuA.waitFor()
    const waiting = menuA.locator(`[data-work-member="${mb.ids.s06}"]`).first()
    t.check(
      'the menu names the verifier waiting on the person',
      /Waiting on you/.test(await waiting.innerText())
    )
    await waiting.click()
    t.check(
      'the menu reaches the exact tab that waits',
      (await until(async () => ((await focusedId()) === mb.ids.s06 ? true : null))) === true
    )
    writeState(mb.ids.s06, 'idle')

    // ── 7. The later phases: one more handoff, a failed transfer, the person ──
    const anchorsBefore = await readEntries(win, MB)
    // The names before the later phases, by the shape's keys.
    const namesBefore = {}
    for (const x of (await callMcp(app, 'list', {}))?.sessions ?? []) {
      const key = Object.entries(mb.ids).find(([, id]) => id === x.id)?.[0]
      if (key) namesBefore[key] = x.name
    }
    // Sessions a phase closed: an entry anchored on one takes the next
    // earliest member's place, so its place is not compared after that.
    const closed = new Set()
    for (const phase of MB.then) {
      for (const s of phase.open ?? []) {
        const opened = await call(seedClient, 'clave_open_session', {
          cwd: ROOT,
          name: s.title,
          mode: 'claude',
          profile: 'builtin-claude',
          groupId: mb.groupId
        })
        mb.ids[s.key] = opened.sessionId
      }
      for (const step of phase.steps ?? []) {
        if (step.as === 'human') {
          await entry(win, 'fixture-mobile-d').locator('.sidebar-item').click()
          const menuD = win.getByRole('menu', { name: /Sessions of Relay transport/ })
          await menuD.waitFor()
          await menuD.locator(`[data-work-action="accept-${mb.ids[step.target]}"]`).click()
          await until(async () =>
            (await entry(win, 'fixture-mobile-d').getAttribute('data-work-owner')) === 'held'
              ? true
              : null
          )
          await win.keyboard.press('Escape')
        } else await applyStep(step, mb.ids)
      }
      for (const key of phase.close ?? []) {
        await callMcp(app, 'closeSession', { sessionId: mb.ids[key] })
        closed.add(mb.ids[key])
      }
      for (const [unit, want] of Object.entries(phase.expect)) {
        const settled = await until(async () => {
          const owner = await entry(win, unit).getAttribute('data-work-owner')
          const target = await entry(win, unit).getAttribute('data-work-target')
          return owner === want.owner.state && (!want.owner.id || target === mb.ids[want.owner.id])
            ? { owner, target }
            : null
        })
        t.check(`${phase.name}: ${unit} reads ${want.owner.state}`, !!settled, {
          owner: await entry(win, unit).getAttribute('data-work-owner'),
          target: await entry(win, unit).getAttribute('data-work-target')
        })
      }
      // An accepted handover renames (Valentin, 6 November 2026): the
      // successor takes its predecessor's exact name, the predecessor
      // becomes `<name> · gen <n>`, so no two open tabs share one name.
      for (const step of phase.steps ?? []) {
        if (step.change.type !== 'accept' || step.as === 'human') continue
        const listed = (await callMcp(app, 'list', {}))?.sessions ?? []
        const nameOf = (key) => listed.find((x) => x.id === mb.ids[key])?.name
        const predecessor = MB.then
          .flatMap((p) => p.steps ?? [])
          .find((x) => x.change.type === 'offer' && x.change.to === step.as)?.as
        t.equal(
          `${phase.name}: the successor takes its predecessor's name`,
          nameOf(step.as),
          namesBefore[predecessor]
        )
        t.equal(
          `${phase.name}: the predecessor's name says its generation`,
          nameOf(predecessor),
          `${namesBefore[predecessor]} · gen 1`
        )
      }
      const after = await readEntries(win, MB)
      for (const u of MB.expect.units) {
        const before = anchorsBefore[u.unit].anchor
        if (closed.has(before)) continue
        t.equal(`${phase.name}: ${u.unit} keeps its place`, after[u.unit].anchor, before)
      }
      t.equal(
        `${phase.name}: the group still draws one row per unit and per ordinary session`,
        await rowsIn(win, mb.groupId),
        MB.expect.units.length + MB.expect.ordinary.length
      )
    }

    // ── 8. The search still lists every session as its own row ──
    // Every session whose title names lane B, the three leads among them.
    await win.fill('.group-switcher-search input', 'Lane B')
    for (const key of ['s08', 's09', 's37'])
      t.check(
        `the search shows ${key} as its own row`,
        (await until(async () =>
          (await win.locator(`[data-sidebar-item-id="${mb.ids[key]}"]`).count()) === 1 ? true : null
        )) === true
      )
    await win.fill('.group-switcher-search input', '')

    // ── 9. Two restarts bring back the same entries and holders ──
    const snapshot = {}
    for (const shape of SHAPES) snapshot[shape.name] = await readEntries(win, shape)
    const sameAfter = async (label, w) => {
      for (const shape of SHAPES) {
        const got = await readEntries(w, shape)
        for (const u of shape.expect.units) {
          t.equal(
            `${label}: ${shape.name} ${u.unit} owner`,
            got[u.unit].owner,
            snapshot[shape.name][u.unit].owner
          )
          t.equal(
            `${label}: ${shape.name} ${u.unit} holder`,
            got[u.unit].target,
            snapshot[shape.name][u.unit].target
          )
          t.equal(
            `${label}: ${shape.name} ${u.unit} label`,
            got[u.unit].label,
            snapshot[shape.name][u.unit].label
          )
        }
        t.equal(
          `${label}: ${shape.name} draws the same rows`,
          await until(async () => {
            const n = await rowsIn(w, all[shape.name].groupId)
            return n === shape.expect.units.length + shape.expect.ordinary.length ? n : null
          }),
          shape.expect.units.length + shape.expect.ordinary.length
        )
      }
    }
    await app.close()
    app = null
    clients.clear()
    const second = await launchApp(DIR, { env: ENV, settleMs: 1500 })
    app = second.app
    win = second.win
    await sameAfter('after a restart (reattached)', win)

    await app.close()
    app = null
    killLeakedE2eTmux()
    const third = await launchApp(DIR, { env: ENV, settleMs: 1500 })
    app = third.app
    win = third.win
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    const prompted = await until(() => restore.isVisible().catch(() => false), { tries: 80 })
    t.check('the dead records are offered for relaunch', !!prompted)
    if (prompted) await restore.click()
    await sameAfter('after a restart (respawned from the records)', win)
  } finally {
    if (app) await app.close().catch(() => {})
    killLeakedE2eTmux()
  }
}
