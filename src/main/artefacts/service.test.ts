import { afterEach, describe, expect, it } from 'vitest'
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForwardRegistry } from '@clave/server/forward-registry'
import type { ArtefactEvent } from '@clave/contract/artefacts'
import type { AgentState } from '@clave/contract/sessions'
import { ArtefactLinks, type LinksStorage } from './links'
import {
  HOLD_TTL_MS,
  LINGER_MS,
  NO_ARTEFACT_OPEN,
  NO_PAGE,
  NO_SUCH_SESSION,
  NOT_ABSOLUTE,
  NOT_AN_ARTEFACT,
  SEVERAL_PAGES,
  createArtefactService,
  type ArtefactServiceHandle
} from './service'
import { CLI_OVERRIDE_ENV } from './slideless-cli'

/** Where every test's clock starts. */
const START = Date.UTC(2026, 10, 12, 10)

/**
 * The service that owns a session's artefact (PRDCT-4472), over real child
 * processes: a stand-in for the Slideless command line, named by
 * `CLAVE_SLIDELESS_CLI`, that behaves like `slideless dev` (listens on the
 * port it is given, prints the address line, answers the snapshot route
 * with its header) and like `slideless snapshot … --json`. Each call it
 * answers is written as one line to the file `FIXTURE_LOG` names, so a test
 * reads which road a version took.
 */
const FIXTURE_CLI = `
import { createServer } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const say = (line) => appendFileSync(process.env.FIXTURE_LOG, line + '\\n')
if (args[0] === 'snapshot') {
  const target = args[1]
  if (existsSync(join(target, 'fail-snapshot'))) {
    console.error('Error: the store is not writable')
    process.exit(1)
  }
  say('command ' + target)
  console.log(JSON.stringify({ version: 7, created: true, root: target, store: args[args.indexOf('--store') + 1] }))
  process.exit(0)
}
const port = Number(args[args.indexOf('--port') + 1])
let version = 0
createServer((req, res) => {
  if (req.url === '/__slideless/snapshot' && req.method === 'POST') {
    if (req.headers['x-slideless'] !== 'snapshot') { res.writeHead(403); return res.end('{}') }
    version++
    say('route ' + args[1])
    res.writeHead(201, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ version, created: true }))
  }
  res.end('ok')
}).listen(port, '127.0.0.1', () => {
  say('dev ' + args[1])
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port + '/' }))
})
`

const memory = (): LinksStorage & { text: string | null } => {
  const store = {
    text: null as string | null,
    read: () => store.text,
    write: (text: string) => {
      store.text = text
    }
  }
  return store
}

interface Setup {
  service: ArtefactServiceHandle
  root: string
  deck: string
  forwards: ForwardRegistry
  events: ArtefactEvent[]
  children: ChildProcess[]
  storage: ReturnType<typeof memory>
  known: Set<string>
  emitState: (sessionId: string, state: AgentState) => void
  calls: () => string[]
  logged: string[]
  setNow: (at: number) => void
}

const services: ArtefactServiceHandle[] = []
const dirs: string[] = []
const pids: number[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function setup(
  options: {
    cli?: boolean
    autoInstall?: boolean
    fetch?: typeof globalThis.fetch
  } = {}
): Setup {
  const root = mkdtempSync(join(tmpdir(), 'clave-artefact-service-'))
  dirs.push(root)
  const cliPath = join(root, 'fixture-cli.mjs')
  writeFileSync(cliPath, FIXTURE_CLI)
  const logFile = join(root, 'calls.log')
  const deck = join(root, 'work', 'deck')
  mkdirSync(deck, { recursive: true })
  writeFileSync(join(deck, 'index.html'), '<h1>deck</h1>')
  const forwards = new ForwardRegistry()
  const events: ArtefactEvent[] = []
  const children: ChildProcess[] = []
  const storage = memory()
  const known = new Set(['s1', 's2'])
  const stateListeners = new Set<(sessionId: string, state: AgentState) => void>()
  const logged: string[] = []
  let at = START
  const service = createArtefactService({
    dataDir: join(root, 'data'),
    execPath: process.execPath,
    env: {
      ...process.env,
      FIXTURE_LOG: logFile,
      ...(options.cli === false ? { [CLI_OVERRIDE_ENV]: '' } : { [CLI_OVERRIDE_ENV]: cliPath })
    },
    links: new ArtefactLinks(storage, () => {}),
    forwards,
    sessions: {
      knows: (id) => known.has(id),
      onState: (listener) => {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      }
    },
    autoInstall: options.autoInstall ?? false,
    spawn: (command, args, spawnOptions) => {
      const child = spawnChild(command, args, spawnOptions)
      children.push(child)
      if (child.pid) pids.push(child.pid)
      return child
    },
    ...(options.fetch && { fetch: options.fetch }),
    now: () => at,
    log: (line) => logged.push(line)
  })
  services.push(service)
  service.subscribe((event) => events.push(event))
  return {
    service,
    root,
    deck,
    forwards,
    events,
    children,
    storage,
    known,
    emitState: (id, state) => stateListeners.forEach((l) => l(id, state)),
    calls: () =>
      existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [],
    logged,
    setNow: (next) => {
      at = next
    }
  }
}

const refusal = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'no refusal',
    (error: Error) => `${error.name}: ${error.message}`
  )
const refused = (message: string): string => `ArtefactRefusal: ${message}`
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('opening an artefact', () => {
  it('refuses with its sentence an unknown session and each path that is no artefact', async () => {
    const { service, root, deck } = setup()
    expect(await refusal(service.open('nobody', deck))).toBe(refused(NO_SUCH_SESSION))
    expect(await refusal(service.open('s1', 'work/deck'))).toBe(refused(NOT_ABSOLUTE))
    expect(await refusal(service.open('s1', join(root, 'nowhere')))).toBe(
      refused(`No such file or folder: ${join(root, 'nowhere')}`)
    )
    writeFileSync(join(root, 'notes.txt'), 'x')
    expect(await refusal(service.open('s1', join(root, 'notes.txt')))).toBe(
      refused(NOT_AN_ARTEFACT)
    )
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(await refusal(service.open('s1', empty))).toBe(refused(NO_PAGE))
    const two = join(root, 'two')
    mkdirSync(two)
    writeFileSync(join(two, 'a.html'), 'a')
    writeFileSync(join(two, 'b.html'), 'b')
    expect(await refusal(service.open('s1', two))).toBe(refused(SEVERAL_PAGES))
  })

  it('links a folder and a file with their target, page and title, writes it and tells it', async () => {
    const { service, root, deck, storage, events } = setup()
    const folder = await service.open('s1', `${deck}/`)
    expect(folder).toMatchObject({
      sessionId: 's1',
      target: deck,
      page: join(deck, 'index.html'),
      title: 'deck'
    })
    expect(new Date(folder.openedAt).toISOString()).toBe(folder.openedAt)
    const one = join(root, 'report.HTML')
    writeFileSync(one, '<p>report</p>')
    const file = await service.open('s2', one)
    expect(file).toMatchObject({ target: one, page: one, title: 'report.HTML' })
    const single = join(root, 'single')
    mkdirSync(single)
    writeFileSync(join(single, 'page.htm'), 'x')
    expect((await service.open('s2', single)).page).toBe(join(single, 'page.htm'))
    const document = JSON.parse(storage.text!) as { v: number; artefacts: Record<string, unknown> }
    expect(document.v).toBe(1)
    expect(document.artefacts.s1).toEqual({
      target: deck,
      page: join(deck, 'index.html'),
      title: 'deck',
      openedAt: folder.openedAt
    })
    expect(events.filter((e) => e._tag === 'artefact.changed')).toEqual([
      { _tag: 'artefact.changed', sessionId: 's1', artefact: folder },
      { _tag: 'artefact.changed', sessionId: 's2', artefact: file },
      expect.objectContaining({ _tag: 'artefact.changed', sessionId: 's2' })
    ])
  })

  it('a second open replaces the first and drops its holds', async () => {
    const { service, root, deck, forwards, setNow } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    expect(forwards.resolve(held.lease)).toBeDefined()
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'index.html'), 'other')
    const second = await service.open('s1', other)
    expect((await service.list()).map((a) => a.target)).toEqual([other])
    expect(second.target).toBe(other)
    // The first preview is shown by no session any more: it stopped at
    // once, with no minute of waiting, and its lease went.
    expect(forwards.resolve(held.lease)).toBeUndefined()
    // The first hold went with the first link: its id is not renewed.
    const renewed = await service.hold('s1', held.holdId)
    expect(renewed.holdId).not.toBe(held.holdId)
    expect(renewed.lease).not.toBe(held.lease)
    // A close stops the second the same way, held or not.
    setNow(START + 1)
    await service.close('s1')
    expect(forwards.resolve(renewed.lease)).toBeUndefined()
  })
})

describe('holding a preview', () => {
  it('is refused without a link, and with each Slideless sentence while it is not ready', async () => {
    const withCli = setup()
    expect(await refusal(withCli.service.hold('s1'))).toBe(refused(NO_ARTEFACT_OPEN))

    let fail: (error: Error) => void = () => {}
    const fetch = ((): Promise<Response> =>
      new Promise((_resolve, reject) => {
        fail = reject
      })) as typeof globalThis.fetch
    const { service, deck } = setup({ cli: false, fetch })
    await service.open('s1', deck)
    expect(await refusal(service.hold('s1'))).toBe(
      refused('Slideless is not installed on this server.')
    )
    const install = service.installSlideless()
    expect((await service.slidelessState()).phase).toBe('installing')
    expect(await refusal(service.hold('s1'))).toBe(
      refused('Slideless is being installed on this server.')
    )
    expect(await refusal(service.saveVersion('s1'))).toBe(
      refused('Slideless is being installed on this server.')
    )
    fail(new Error('offline'))
    expect((await install).phase).toBe('error')
    expect(await refusal(service.hold('s1'))).toBe(
      refused('Slideless could not be installed on this server: offline')
    )
  })

  it('answers a lease that resolves to the port of its url, joins one preview, and renews a hold by its id', async () => {
    const { service, deck, forwards, children, setNow } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    const first = await service.hold('s1')
    expect(first.ttlMs).toBe(HOLD_TTL_MS)
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(forwards.resolve(first.lease)).toEqual({ port: Number(new URL(first.url).port) })
    expect(await (await fetch(first.url)).text()).toBe('ok')
    const second = await service.hold('s2')
    expect(second.url).toBe(first.url)
    expect(second.lease).toBe(first.lease)
    expect(children).toHaveLength(1)
    expect(forwards.size()).toBe(1)
    // Renewed at 80 s, the hold is still there at 160 s, after its first time ran out.
    setNow(Date.UTC(2026, 10, 12, 10) + 80_000)
    const renewed = await service.hold('s1', first.holdId)
    expect(renewed.holdId).toBe(first.holdId)
    await service.release('s2', second.holdId)
    setNow(Date.UTC(2026, 10, 12, 10) + 160_000)
    service.sweep()
    expect(forwards.resolve(first.lease)).toEqual({ port: Number(new URL(first.url).port) })
  })

  it('a renewal extends the hold: renewed at 60 s, it outlives its first 90 s', async () => {
    const { service, deck, forwards, setNow } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    setNow(START + 60_000)
    expect((await service.hold('s1', held.holdId)).holdId).toBe(held.holdId)
    // Past the first expiry: the renewed hold is still there.
    setNow(START + 100_000)
    service.sweep()
    // The renewed hold lapsed at 150 s, so the preview has waited 15 s only.
    // Had the renewal extended nothing, it would have lapsed at the sweep of
    // 100 s and the preview, idle since then, would be stopped by now.
    setNow(START + 165_000)
    service.sweep()
    expect(forwards.resolve(held.lease)).toEqual({ port: Number(new URL(held.url).port) })
  })

  it("a hold is its session's: another session naming it does not release it", async () => {
    const { service, deck, forwards, setNow } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    const mine = await service.hold('s1')
    const theirs = await service.hold('s2')
    // s2 names s1's hold: nothing changes, s1 still holds the preview after
    // s2 lets go of its own and the minute has passed.
    await service.release('s2', mine.holdId)
    await service.release('s2', theirs.holdId)
    setNow(START + LINGER_MS)
    service.sweep()
    expect(forwards.resolve(mine.lease)).toBeDefined()
  })

  it("a renewal naming another session's hold mints a new one and leaves the first alive", async () => {
    const { service, deck, forwards, setNow } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    const mine = await service.hold('s1')
    const other = await service.hold('s2', mine.holdId)
    expect(other.holdId).not.toBe(mine.holdId)
    // s2 lets go of the hold it was given: s1's own still holds the preview
    // a minute later.
    await service.release('s2', other.holdId)
    setNow(START + LINGER_MS)
    service.sweep()
    expect(forwards.resolve(mine.lease)).toBeDefined()
  })

  it('keeps a preview a minute after its last release, joins it when held again, then stops it; sweeps a hold past its time', async () => {
    const { service, deck, forwards, children, setNow } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    const a = await service.hold('s1')
    const b = await service.hold('s2')
    // A release by another session, or of an unknown hold, does nothing.
    await service.release('s2', a.holdId)
    await service.release('s1', 'unknown')
    await service.release('s1', a.holdId)
    expect(forwards.resolve(b.lease)).toBeDefined()
    await service.release('s2', b.holdId)
    // Nobody holds it: it is kept for a minute, and a sweep before that leaves it.
    setNow(START + LINGER_MS - 1)
    service.sweep()
    expect(forwards.resolve(b.lease)).toBeDefined()
    expect(alive(children[0]!.pid!)).toBe(true)
    // Held again within the minute: the same preview, the same lease, no second child.
    const back = await service.hold('s1')
    expect(back.lease).toBe(b.lease)
    expect(children).toHaveLength(1)
    setNow(START + 10 * LINGER_MS)
    service.sweep()
    // Its hold is past its time by now, so this sweep dropped it and noted the
    // preview idle; it is stopped a minute after THAT, not after the first release.
    expect(forwards.resolve(b.lease)).toBeDefined()
    setNow(START + 11 * LINGER_MS)
    service.sweep()
    expect(forwards.resolve(b.lease)).toBeUndefined()
    await expect.poll(() => alive(children[0]!.pid!), { timeout: 3_000 }).toBe(false)

    const c = await service.hold('s1')
    expect(children).toHaveLength(2)
    const held = START + 11 * LINGER_MS
    setNow(held + HOLD_TTL_MS - 1)
    service.sweep()
    expect(forwards.resolve(c.lease)).toBeDefined()
    setNow(held + HOLD_TTL_MS + LINGER_MS)
    service.sweep()
    // The hold lapsed in this sweep; the preview goes a minute after.
    expect(forwards.resolve(c.lease)).toBeDefined()
    setNow(held + HOLD_TTL_MS + 2 * LINGER_MS)
    service.sweep()
    expect(forwards.resolve(c.lease)).toBeUndefined()
    await expect.poll(() => alive(children[1]!.pid!), { timeout: 3_000 }).toBe(false)
  })

  it('keeps no preview waiting for a tab that ended: stopped at its last release, or at the end when nobody holds it', async () => {
    const { service, deck, forwards, emitState } = setup()
    await service.open('s1', deck)
    service.start()
    const a = await service.hold('s1')
    emitState('s1', 'ended')
    // Still held by a window that shows the ended tab: it stays.
    expect(forwards.resolve(a.lease)).toBeDefined()
    await service.release('s1', a.holdId)
    expect(forwards.resolve(a.lease)).toBeUndefined()
    // The other order: released first (kept a minute), then the tab ends.
    emitState('s1', 'idle')
    const b = await service.hold('s1')
    await service.release('s1', b.holdId)
    expect(forwards.resolve(b.lease)).toBeDefined()
    emitState('s1', 'ended')
    expect(forwards.resolve(b.lease)).toBeUndefined()
  })

  it('tells the holders of a preview killed from outside, gives its lease back, and starts a new one at the next hold', async () => {
    const { service, deck, forwards, children, events } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    const held = await service.hold('s1')
    await service.hold('s2')
    process.kill(children[0]!.pid!, 'SIGKILL')
    await expect
      .poll(() => events.filter((e) => e._tag === 'artefact.preview_exited'), { timeout: 3_000 })
      .toEqual([
        { _tag: 'artefact.preview_exited', sessionId: 's1' },
        { _tag: 'artefact.preview_exited', sessionId: 's2' }
      ])
    expect(forwards.resolve(held.lease)).toBeUndefined()
    const again = await service.hold('s1', held.holdId)
    expect(children).toHaveLength(2)
    expect(again.lease).not.toBe(held.lease)
    expect(forwards.resolve(again.lease)).toEqual({ port: Number(new URL(again.url).port) })
  })
})

describe('a version at each finished turn', () => {
  it('is saved through the running preview, else through the one-shot command', async () => {
    const { service, deck, emitState, calls } = setup()
    await service.open('s1', deck)
    service.start()
    emitState('s1', 'working')
    emitState('s1', 'done')
    await expect.poll(calls, { timeout: 5_000 }).toEqual([`command ${deck}`])
    await service.hold('s1')
    emitState('s1', 'blocked')
    emitState('s1', 'idle')
    await expect
      .poll(calls, { timeout: 5_000 })
      .toEqual([`command ${deck}`, `dev ${deck}`, `route ${deck}`])
    expect(await service.saveVersion('s1')).toEqual({ version: 2, created: true })
  })

  it('saves nothing for a rest after a rest, a first state, or a session with no link', async () => {
    const { service, deck, emitState, calls } = setup()
    await service.open('s1', deck)
    service.start()
    emitState('s1', 'done')
    emitState('s1', 'idle')
    emitState('s1', 'done')
    emitState('s2', 'working')
    emitState('s2', 'done')
    await settle(500)
    expect(calls()).toEqual([])
  })

  it('a failing save is one log line, never thrown', async () => {
    const { service, deck, emitState, logged, calls } = setup()
    writeFileSync(join(deck, 'fail-snapshot'), '')
    await service.open('s1', deck)
    service.start()
    emitState('s1', 'working')
    emitState('s1', 'done')
    await expect
      .poll(() => logged.filter((l) => l.includes('no version saved')), { timeout: 5_000 })
      .toEqual([expect.stringContaining('the store is not writable')])
    expect(calls()).toEqual([])
  })
})

describe('the links of sessions the server does not know yet', () => {
  it('are kept by start(), listed, and given to the session once it is known: a hold then works', async () => {
    const { service, deck, known, storage, forwards } = setup()
    await service.open('s1', deck)
    await service.open('s2', deck)
    // After a restart a terminal tab is known by its id only once a window
    // has taken it back: until then the server does not know it.
    known.delete('s1')
    known.delete('s2')
    service.start()
    expect(Object.keys(JSON.parse(storage.text!).artefacts).sort()).toEqual(['s1', 's2'])
    expect((await service.list()).map((a) => a.sessionId).sort()).toEqual(['s1', 's2'])
    expect(Object.keys(JSON.parse(storage.text!).artefacts).sort()).toEqual(['s1', 's2'])
    // The window takes the tab back: the session finds its own link.
    known.add('s1')
    const held = await service.hold('s1')
    expect(forwards.resolve(held.lease)).toEqual({ port: Number(new URL(held.url).port) })
    expect((await service.list()).find((a) => a.sessionId === 's1')?.target).toBe(deck)
  })
})

describe('stopping the service', () => {
  it('leaves no child behind and gives every lease back', async () => {
    const { service, deck, children, forwards } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    const pid = children[0]!.pid!
    expect(alive(pid)).toBe(true)
    await service.stop()
    expect(forwards.resolve(held.lease)).toBeUndefined()
    expect(forwards.size()).toBe(0)
    await expect.poll(() => alive(pid), { timeout: 3_000 }).toBe(false)
  })
})
