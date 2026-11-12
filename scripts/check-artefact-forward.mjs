/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable runtime check */
// The real Slideless across the real hops (PRDCT-4474): the embedded server
// with a real artefact service over a temporary data folder, a fixture deck
// opened as the artefact of a known session, its preview held, and the Mac's
// hop (`LoopbackForwards`) opened on the lease the hold answered. The checks
// of the forward spike run through the Mac's port, the window header sent by
// hand from `secrets()` as the window gate would add it, plus one WebSocket
// echo through a second lease on a fixture target. One PASS/FAIL line per
// check; exits non-zero when one fails.
//
// Run with the repository's Bun:
//   node_modules/.bin/bun scripts/check-artefact-forward.mjs [path to the Slideless bin.js]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { startEmbedded } from '../packages/server/src/embedded.ts'
import { FakeSource } from '../packages/server/src/test-support.ts'
import { ForwardRegistry } from '../packages/server/src/forward/registry.ts'
import { startTestTarget } from '../packages/server/src/forward/test-target.ts'
import { createArtefactService } from '../src/main/artefacts/service.ts'
import { ArtefactLinks, fileLinksStorage } from '../src/main/artefacts/links.ts'
import { LoopbackForwards, WINDOW_HEADER } from '../src/main/forwards/loopback-forwards.ts'

const root = resolve(import.meta.dirname, '..')
const cli = resolve(process.argv[2] ?? join(root, 'node_modules/@antasphere/slideless/dist/bin.js'))
const work = mkdtempSync(join(tmpdir(), 'clave-artefact-forward-'))
const dataDir = join(work, 'data')
const deck = join(work, 'deck')
mkdirSync(dataDir, { recursive: true })
mkdirSync(deck, { recursive: true })
writeFileSync(
  join(deck, 'index.html'),
  '<!doctype html><link rel="stylesheet" href="style.css"><h1>MARKER-ONE</h1>'
)
writeFileSync(join(deck, 'style.css'), 'h1 { color: teal }')
const SESSION = 'check-session'

let failed = 0
let total = 0
const check = (name, ok, detail = '') => {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

/** One request, answered whole. */
const ask = (port, path, { method = 'GET', headers = {} } = {}) =>
  new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        done({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString()
        })
      )
    })
    req.on('error', reject)
    req.end()
  })

/** The connections established to a loopback port, counted by the OS. */
const established = (port) => {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED'], {
      encoding: 'utf8'
    })
    return out.split('\n').filter((line) => line.includes(`:${port}`)).length
  } catch {
    return 0 // lsof exits 1 when nothing matches
  }
}

const registry = new ForwardRegistry()
const service = createArtefactService({
  dataDir,
  execPath: process.env.CLAVE_DAEMON_NODE ?? 'node',
  env: { ...process.env, CLAVE_SLIDELESS_CLI: cli },
  links: new ArtefactLinks(fileLinksStorage(join(dataDir, 'artefacts.json')), () => {}),
  forwards: registry,
  sessions: { knows: (id) => id === SESSION, onState: () => () => {} },
  autoInstall: false,
  log: () => {}
})
service.start()
const server = await startEmbedded({
  ports: { sessions: new FakeSource(), forwards: registry, artefacts: service }
})
const api = async (route, body) => {
  const res = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status === 204) return undefined
  if (res.status !== 200) throw new Error(`${route} answered ${res.status}: ${await res.text()}`)
  return res.json()
}
const forwards = new LoopbackForwards()
const target = await startTestTarget()
const upstream = async () => ({ url: server.url, token: server.token })

try {
  await api('/artefacts/open', { sessionId: SESSION, path: deck })
  const held = await api('/artefacts/hold', { sessionId: SESSION })
  const slidelessPort = Number(new URL(held.url).port)
  const opened = await forwards.open({ key: `check:${held.lease}`, lease: held.lease, upstream })
  const macPort = opened.port
  const macHost = `127.0.0.1:${macPort}`
  const windowHeader = { [WINDOW_HEADER]: forwards.secrets().get(macPort) }
  console.log(
    `mac hop :${macPort} -> server :${new URL(server.url).port} -> slideless :${slidelessPort}\n`
  )

  const foreign = await ask(slidelessPort, '/', { headers: { host: macHost } })
  check(
    "control: slideless refuses the Mac hop's Host unrewritten",
    foreign.status === 403,
    `status ${foreign.status}`
  )

  const closed = await ask(Number(new URL(server.url).port), `/forward/${held.lease}/`)
  check(
    'the server hop is closed without the token',
    closed.status === 401,
    `status ${closed.status}`
  )

  const wrapper = await ask(macPort, '/', { headers: windowHeader })
  check(
    'the version bar page arrives through both hops',
    wrapper.status === 200 && wrapper.body.includes('/__slideless/reload'),
    `status ${wrapper.status}, ${wrapper.body.length} bytes`
  )

  const page = await ask(macPort, '/index.html', { headers: windowHeader })
  const css = await ask(macPort, '/style.css', { headers: windowHeader })
  check(
    'the page and its sibling asset arrive at the root of the Mac hop',
    page.status === 200 &&
      page.body.includes('MARKER-ONE') &&
      css.status === 200 &&
      css.body.includes('teal'),
    `page ${page.status}, css ${css.status}`
  )

  const rebind = await ask(macPort, '/', { headers: { ...windowHeader, host: 'evil.example:80' } })
  check(
    'the Mac hop refuses a Host that is not its own',
    rebind.status === 403,
    `status ${rebind.status}`
  )

  // The reload stream: an edit on the server's disk reaches the page at once.
  const baseline = established(slidelessPort)
  let duringStream = 0
  const reload = await new Promise((done) => {
    const req = http.request(
      { host: '127.0.0.1', port: macPort, path: '/__slideless/reload', headers: windowHeader },
      (res) => {
        let seen = ''
        let editedAt = 0
        const timer = setTimeout(() => {
          req.destroy()
          done({ ok: false, why: 'no reload event in 8 s' })
        }, 8000)
        res.on('data', (chunk) => {
          seen += chunk
          if (editedAt && seen.includes('event: reload')) {
            clearTimeout(timer)
            const ms = Date.now() - editedAt
            duringStream = established(slidelessPort)
            req.destroy()
            done({ ok: true, ms, type: res.headers['content-type'] })
          }
        })
        setTimeout(() => {
          editedAt = Date.now()
          seen = ''
          writeFileSync(
            join(deck, 'index.html'),
            '<!doctype html><link rel="stylesheet" href="style.css"><h1>MARKER-TWO</h1>'
          )
        }, 500)
      }
    )
    req.on('error', () => {})
    req.end()
  })
  check(
    'an edit on disk reaches the page as a reload event through both hops',
    reload.ok === true,
    reload.ok ? `${reload.ms} ms after the write, ${reload.type}` : reload.why
  )

  // The stream was dropped by the page: no hop may keep its upstream open.
  // Counted against the connections open before the stream (a pooled one of
  // the runtime's own may stand there), so only the stream's own is judged,
  // and waited for: each hop lets go once it hears its caller has gone.
  const droppedAt = Date.now()
  let afterDrop = established(slidelessPort)
  while (afterDrop > baseline && Date.now() - droppedAt < 10_000) {
    await new Promise((r) => setTimeout(r, 250))
    afterDrop = established(slidelessPort)
  }
  check(
    'a dropped stream leaves no connection to the preview open',
    duringStream > baseline && afterDrop <= baseline,
    `before ${baseline}, during the stream ${duringStream}, after the drop ${afterDrop} within ${Date.now() - droppedAt} ms`
  )

  const previewHost = `127.0.0.1:${slidelessPort}`
  const refused = await ask(slidelessPort, '/__slideless/snapshot', {
    method: 'POST',
    headers: { host: previewHost, 'x-slideless': 'snapshot', origin: `http://${macHost}` }
  })
  check(
    "control: slideless refuses a snapshot from the Mac hop's Origin unrewritten",
    refused.status === 403,
    `status ${refused.status}`
  )

  const saved = await ask(macPort, '/__slideless/snapshot', {
    method: 'POST',
    headers: { ...windowHeader, 'x-slideless': 'snapshot', origin: `http://${macHost}` }
  })
  let version = null
  try {
    version = JSON.parse(saved.body).version
  } catch {
    /* reported below */
  }
  check(
    '"Save version" in the page works through both hops',
    saved.status === 201 && version === 1,
    `status ${saved.status}, version ${version}`
  )

  const versions = await ask(macPort, '/__slideless/versions', { headers: windowHeader })
  const past = await ask(macPort, '/__slideless/v/1/', { headers: windowHeader })
  let count = -1
  try {
    count = JSON.parse(versions.body).versions.length
  } catch {
    /* reported below */
  }
  check(
    'the saved version is listed and served through both hops',
    count === 1 && past.status === 200 && past.body.includes('MARKER-TWO'),
    `versions ${count}, v1 ${past.status}`
  )

  const foreignOrigin = await ask(macPort, '/__slideless/snapshot', {
    method: 'POST',
    headers: { ...windowHeader, 'x-slideless': 'snapshot', origin: 'http://evil.example' }
  })
  check(
    'a snapshot asked from another site is still refused',
    foreignOrigin.status === 403,
    `status ${foreignOrigin.status}`
  )

  // A WebSocket through a second lease, on a fixture target.
  const second = registry.register(target.port)
  const socketForward = await forwards.open({
    key: `check:${second.lease}`,
    lease: second.lease,
    upstream
  })
  const echoed = await new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${socketForward.port}/ws`, {
      headers: {
        [WINDOW_HEADER]: forwards.secrets().get(socketForward.port),
        origin: `http://127.0.0.1:${socketForward.port}`
      }
    })
    const timer = setTimeout(() => {
      ws.terminate()
      done({ ok: false, why: 'no echo in 5 s' })
    }, 5000)
    ws.once('open', () => ws.send('across both hops'))
    ws.once('message', (data) => {
      clearTimeout(timer)
      ws.close()
      done({ ok: data.toString() === 'across both hops', why: data.toString() })
    })
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      done({ ok: false, why: `refused ${res.statusCode}` })
    })
    ws.once('error', (error) => {
      clearTimeout(timer)
      done({ ok: false, why: String(error) })
    })
  })
  check('a WebSocket echoes through both hops on a second lease', echoed.ok, echoed.why)
  socketForward.release()
  second.release()
  opened.release()
  await api('/artefacts/release', { sessionId: SESSION, holdId: held.holdId })
} catch (error) {
  failed++
  console.log(`FAIL  the check ran to its end  (${error instanceof Error ? error.message : error})`)
} finally {
  await forwards.closeAll()
  await service.stop()
  await server.stop()
  await target.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${total - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
