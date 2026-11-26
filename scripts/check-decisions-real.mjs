/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable runtime check */
// The decisions against the REAL TypeSafe (PRDCT-5179), behind the real hops:
// the built app launched as `tests/e2e/decisions-tab-project.spec.mjs`
// launches it (hidden, the harness, the decisions' world of three invented
// projects and a stand-in agent), but with NO base URL override, so the key
// check and every decision reach TypeSafe itself. The key is read from the
// environment, taken out of it before anything is launched, and typed into
// the Jev card by the script; it is never printed. Then roads 1, 3, 4 and 6
// of the spec, asserted on what the window shows (the group's name; nothing
// for a tab no project fits) and on the reading each tab's record carries
// (an agent's clave_list). Each answer's shares and time are read in the
// server's process through the harness's fixture route, which wraps `fetch`
// to time each call and keep its answer, with the model it asked for and the
// service's words when it refused: never a header, never the rest of the request.
// One PASS/FAIL line per check, every answer's shares and times printed;
// exits non-zero when a check fails. At the end the key is removed on the
// card and the fixture folder deleted, red or green.
//
// A manual check that spends five decisions of some thousand input tokens:
// never from the test suite. Run it with a key of your own in the environment:
//   npx electron-vite build && TYPESAFE_API_KEY=… node scripts/check-decisions-real.mjs
import { rmSync } from 'node:fs'
import path from 'node:path'

process.env.CLAVE_E2E_NS = 'clave-e2e-jev-real'
const KEY = process.env.TYPESAFE_API_KEY?.trim() ?? ''
// Out of this process's environment before any child exists: the app, its
// server and its tabs inherit what this process holds.
delete process.env.TYPESAFE_API_KEY
delete process.env.CLAVE_JEV_BASE_URL
if (!KEY) {
  console.error('No key: set TYPESAFE_API_KEY in the environment (it is never printed).')
  process.exit(2)
}

const {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  finishRun,
  until,
  killLeakedE2eTmux,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  serverDataDirOf
} = await import('../tests/e2e/harness.mjs')
const {
  jevWorld,
  openJevCard,
  backToSessions,
  pasteJev,
  cardLine,
  checkedLine,
  groupByKeymap,
  shownName,
  waitName,
  isGroupN,
  chipsOf,
  sessionOf
} = await import('../tests/e2e/fixtures/jev-world.mjs')
const { readFileSync, existsSync } = await import('node:fs')

const WRONG = 'ts-invented-wrong-key-0000'
let failed = 0
let total = 0
const check = (name, ok, detail = '') => {
  total++
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`
  )
}
const pct = (p) => `${(p * 100).toFixed(1)}%`

const world = jevWorld('jev-real')
world.seed()
seedWorkspaces(world.DIR, { workspaces: [world.WS], activeWorkspaceId: world.WS.id, fresh: true })
seedTrustedRoots(world.DIR, [world.ROOT])
killLeakedE2eTmux()

let app = null
let win = null
let card = null
try {
  const launched = await launchApp(world.DIR, { env: world.env(), server: 'in-process' })
  app = launched.app
  win = launched.win
  const fixture = launched.fixture

  // Every call to TypeSafe timed in the server's process, its answer kept;
  // the headers and the request are never read.
  await fixture.evaluate(() => {
    if (globalThis.__jevCalls) return true
    const calls = (globalThis.__jevCalls = [])
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)))
      if (!/^\/v1\/(models|systemone)$/.test(url.pathname)) return original(input, init)
      const started = Date.now()
      const res = await original(input, init)
      const call = {
        host: url.host,
        path: url.pathname,
        status: res.status,
        ms: Date.now() - started
      }
      if (url.pathname === '/v1/systemone') {
        try {
          call.asked = JSON.parse(typeof init?.body === 'string' ? init.body : '{}').model ?? null
        } catch {
          call.asked = null
        }
        try {
          const body = await res.clone().json()
          if (res.ok) {
            call.model = body.model
            call.answers = body.answers
            call.inputTokens = body.usage?.input_tokens ?? null
          } else call.refusal = body?.detail?.message ?? JSON.stringify(body?.detail ?? body)
        } catch {
          call.unreadable = true
        }
      }
      calls.push(call)
      return res
    }
    return true
  })
  const calls = () => fixture.evaluate(() => globalThis.__jevCalls ?? [])
  const decisions = async () => (await calls()).filter((c) => c.path === '/v1/systemone')

  // ── 1. The key ──
  card = await openJevCard(win)
  await pasteJev(card, WRONG)
  const refusal = await until(() => cardLine(card, 'jev-check-error'))
  check(
    '1. an invented key: the card says TypeSafe refused it',
    /^(TypeSafe refused the key|The key was refused by TypeSafe)/.test(refusal ?? ''),
    refusal
  )
  console.log(`      the card said: ${refusal}`)
  await card.locator('[data-testid="jev-replace"]').click()
  try {
    await pasteJev(card, KEY)
  } catch {
    throw new Error('the key could not be typed into the card') // never the error, which may hold it
  }
  const checked = await until(() => checkedLine(card), { tries: 80, gapMs: 250 })
  check(
    '1. the real key: set and checked',
    !!checked,
    (await cardLine(card, 'jev-check-error')) ?? 'not checked'
  )
  const models = (await calls()).filter((c) => c.path === '/v1/models')
  check(
    '1. the key check reached TypeSafe itself',
    models.length >= 2 && models.every((c) => c.host === 'api.typesafe.ai'),
    models.map((c) => `${c.host} ${c.status}`)
  )
  check('1. and asked no decision', (await decisions()).length === 0)
  await backToSessions(win)

  // An agent's listing: the reading each tab's record carries.
  const tokenOf = (sessionId) => {
    const file = path.join(serverDataDirOf(world.DIR), 'mcp-configs', `${sessionId}.json`)
    if (!existsSync(file)) return null
    return (
      JSON.parse(readFileSync(file, 'utf-8')).mcpServers?.clave?.headers?.Authorization?.replace(
        /^Bearer /,
        ''
      ) ?? null
    )
  }
  let agent = null
  const recordOf = async (tab) => {
    if (!agent) {
      const token = await until(() => tokenOf(tab.id))
      agent = mcpHttpClient(mcpEndpoint(world.DIR), token)
      await agent.init()
    }
    const rpc = await agent.call('clave_list', {})
    if (toolErrored(rpc)) throw new Error(`clave_list failed: ${JSON.stringify(rpc)}`)
    return (toolPayload(rpc)?.sessions ?? []).find((s) => s.id === tab.id)?.projects ?? null
  }
  const said = (reading) =>
    reading
      ? `${reading.status}${reading.names.length ? ` ${reading.names.map((n) => `${n.name} ${pct(n.share)}`).join(' | ')}` : ''}`
      : 'none read'
  const readWithin = (tab) =>
    until(async () => ((await sessionOf(win, tab.id))?.projects ? true : null), {
      tries: 120,
      gapMs: 250
    })

  // ── 3. One project ──
  const q1 = await world.openTab(app, win, 'Quill one', world.P('quill'), world.SAY.quill(1))
  const q2 = await world.openTab(app, win, 'Quill two', world.P('quill'), world.SAY.quill(2))
  const g3 = await groupByKeymap(win, [q1.id, q2.id])
  // « Group N » at once is the spec's, which holds the stub's answer: a real one
  // can come back before a read of the row.
  await readWithin(q1)
  await readWithin(q2)
  check(
    '3. then « Quill »',
    (await waitName(win, g3.id, 'Quill', 120)) === 'Quill',
    await shownName(win, g3.id)
  )
  for (const tab of [q1, q2]) {
    const reading = await recordOf(tab)
    check(
      `3. ${tab.name}: its record carries « decided Quill »`,
      reading?.status === 'decided' && reading.names.map((n) => n.name).join() === 'Quill',
      said(reading)
    )
  }

  // ── 4. Two projects ──
  const q3 = await world.openTab(app, win, 'Quill three', world.P('quill'), world.SAY.quill(3))
  const a1 = await world.openTab(app, win, 'Atlas one', world.P('atlas'), world.SAY.atlas(1))
  const g4 = await groupByKeymap(win, [q3.id, a1.id])
  await readWithin(q3)
  await readWithin(a1)
  const both = await until(
    async () => {
      const name = await shownName(win, g4.id)
      return name === 'Quill | Atlas' || name === 'Atlas | Quill' ? name : null
    },
    { tries: 120, gapMs: 250 }
  )
  check(
    '4. a Quill tab and an Atlas tab: « Quill | Atlas » or the reverse',
    !!both,
    await shownName(win, g4.id)
  )
  const rq3 = await recordOf(q3)
  const ra1 = await recordOf(a1)
  check(
    '4. the Quill tab’s record carries « decided Quill »',
    rq3?.status === 'decided' && rq3.names[0]?.name === 'Quill',
    said(rq3)
  )
  check(
    '4. the Atlas tab’s record carries « decided Atlas »',
    ra1?.status === 'decided' && ra1.names[0]?.name === 'Atlas',
    said(ra1)
  )
  if (both && rq3 && ra1) {
    const first = rq3.names[0].share >= ra1.names[0].share ? 'Quill' : 'Atlas'
    check('4. the larger mean share first', both.startsWith(first), {
      name: both,
      quill: rq3.names[0].share,
      atlas: ra1.names[0].share
    })
  }

  // ── 6. No project ──
  const n1 = await world.openTab(app, win, 'Train', world.ROOT, world.SAY.train)
  const g6 = await groupByKeymap(win, [n1.id])
  await readWithin(n1)
  await win.waitForTimeout(1000)
  const rn1 = await recordOf(n1)
  check('6. the train tab’s record carries « none »', rn1?.status === 'none', said(rn1))
  check('6. nothing named', isGroupN(await shownName(win, g6.id)), await shownName(win, g6.id))
  check('6. nothing suggested', (await chipsOf(win, g6.id)).length === 0, await chipsOf(win, g6.id))

  // ── Every answer, as TypeSafe gave it ──
  const asked = await decisions()
  const answered = asked.filter((c) => c.status === 200)
  const refused = asked.filter((c) => c.status !== 200)
  check(
    'five tabs were read, each answered by TypeSafe itself',
    answered.length === 5 && asked.every((c) => c.host === 'api.typesafe.ai'),
    asked.map((c) => `${c.host} ${c.status} ${c.asked}`)
  )
  check(
    'and no request was refused on the way',
    refused.length === 0,
    refused.map((c) => `${c.status} on ${c.asked}: ${c.refusal}`)
  )
  console.log('\nrequests (in the order asked):')
  for (const c of refused)
    console.log(`  refused  ${c.status} on ${c.asked} in ${c.ms} ms: ${c.refusal}`)
  console.log('answers (in the order asked):')
  for (const c of answered) {
    const probabilities = c.answers?.project?.probabilities ?? {}
    const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
    console.log(
      `  ${c.model ?? '?'}  ${c.ms} ms  ${c.inputTokens ?? '?'} input tokens  ${ranked.map(([n, p]) => `${n} ${pct(p)}`).join(', ')}  fits ${c.answers?.fits?.noul !== undefined ? c.answers.fits.noul.toFixed(3) : '?'}`
    )
  }
} catch (error) {
  failed = Math.max(failed, 1)
  console.error(String(error?.message ?? error))
} finally {
  // The key off this machine's test instance, red or green.
  if (card) {
    try {
      card = await openJevCard(win)
      if (await card.locator('[data-testid="jev-remove"]').count()) {
        await card.locator('[data-testid="jev-remove"]').click()
        await until(async () =>
          (await card.locator('[data-testid="jev-key-input"]').count()) ? true : null
        )
      }
    } catch {
      console.error('could not remove the key on the card; the fixture folder is deleted anyway')
    }
  }
  if (app) await app.close().catch(() => {})
  finishRun({ failed: 0 })
  rmSync(world.DIR, { recursive: true, force: true })
}
console.log(`\n${total - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
