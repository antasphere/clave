import { afterEach, describe, expect, it } from 'vitest'
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ForwardRegistry } from '@clave/server/forward-registry'
import type { ArtefactEvent } from '@clave/contract/artefacts'
import type { AgentState } from '@clave/contract/sessions'
import { recordUnreadable } from './artefact-decks'
import { ArtefactLinks, MAX_LINKS, MAX_PER_SESSION, type LinksStorage } from './links'
import {
  HOLD_TTL_MS,
  LINGER_MS,
  NO_ARTEFACT_OPEN,
  NO_PAGE,
  NO_SUCH_SESSION,
  NOT_ABSOLUTE,
  NOT_AN_ARTEFACT,
  REGISTRY_ENV,
  SEVERAL_PAGES,
  createArtefactService,
  type ArtefactServiceHandle
} from './service'
import { CLI_OVERRIDE_ENV } from './slideless-cli'
import {
  answer,
  DECKS,
  EXEC_PATH,
  fakeSlideless,
  flush,
  isListing,
  listedProfile,
  listingJson
} from './slideless.test-support'

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
  if (req.url === '/__slideless/versions' && req.method === 'GET') {
    say('list ' + args[1])
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ versions: Array.from({ length: version }, (_, i) => ({ version: i + 1, createdAt: '2026-11-13T10:00:00.000Z', fileCount: 1 })) }))
  }
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
    const document = JSON.parse(storage.text!) as {
      v: number
      artefacts: Record<string, unknown>
      lists: Record<string, unknown>
    }
    const written = {
      target: deck,
      page: join(deck, 'index.html'),
      title: 'deck',
      openedAt: folder.openedAt
    }
    expect(document.v).toBe(1)
    expect(document.artefacts.s1).toEqual(written)
    expect(document.lists.s1).toEqual([written])
    expect(events.filter((e) => e._tag === 'artefact.changed')).toEqual([
      { _tag: 'artefact.changed', sessionId: 's1', artefact: folder, artefacts: [folder] },
      { _tag: 'artefact.changed', sessionId: 's2', artefact: file, artefacts: [file] },
      expect.objectContaining({
        _tag: 'artefact.changed',
        sessionId: 's2',
        artefacts: [file, expect.objectContaining({ target: single })]
      })
    ])
  })

  it('asked to present, tells the windows so right after the change, and only then (PRDCT-4980)', async () => {
    const { service, deck, events } = setup()
    const shown = await service.open('s1', deck, true)
    await service.open('s2', deck)
    await service.open('s2', deck, false)
    expect(events.filter((e) => e._tag !== 'slideless.state_changed')).toEqual([
      { _tag: 'artefact.changed', sessionId: 's1', artefact: shown, artefacts: [shown] },
      { _tag: 'artefact.present_requested', sessionId: 's1' },
      expect.objectContaining({ _tag: 'artefact.changed', sessionId: 's2' }),
      expect.objectContaining({ _tag: 'artefact.changed', sessionId: 's2' })
    ])
  })

  it('a second open joins the first in front, each keeps its holds, a reopen drops its own (PRDCT-5022)', async () => {
    const { service, root, deck, forwards, events, setNow } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    expect(forwards.resolve(held.lease)).toBeDefined()
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'index.html'), 'other')
    const second = await service.open('s1', other)
    expect(second.target).toBe(other)
    expect((await service.list()).map((a) => a.target)).toEqual([deck, other])
    // The first is still the session's: its preview runs and its hold renews.
    expect(forwards.resolve(held.lease)).toBeDefined()
    expect((await service.hold('s1', held.holdId, deck)).holdId).toBe(held.holdId)
    // A hold naming no artefact holds the front one, on a preview of its own.
    const front = await service.hold('s1')
    expect(front.lease).not.toBe(held.lease)
    // The first opened again comes to the front, starting afresh: its hold went.
    await service.open('s1', deck)
    expect((await service.list()).map((a) => a.target)).toEqual([other, deck])
    const fresh = await service.hold('s1', held.holdId)
    expect(fresh.holdId).not.toBe(held.holdId)
    expect((await service.hold('s1', front.holdId, other)).holdId).toBe(front.holdId)
    // Closing one stops its preview at once and keeps the other, holds and all.
    setNow(START + 1)
    await service.close('s1', other)
    expect((await service.list()).map((a) => a.target)).toEqual([deck])
    expect(forwards.resolve(front.lease)).toBeUndefined()
    expect((await service.hold('s1', fresh.holdId, deck)).holdId).toBe(fresh.holdId)
    expect(events.at(-1)).toEqual({
      _tag: 'artefact.changed',
      sessionId: 's1',
      artefact: expect.objectContaining({ target: deck }),
      artefacts: [expect.objectContaining({ target: deck })]
    })
    // Closing them all stops the rest, and says none is left.
    await service.close('s1')
    expect(await service.list()).toEqual([])
    expect(forwards.resolve(fresh.lease)).toBeUndefined()
    expect(events.at(-1)).toEqual({
      _tag: 'artefact.changed',
      sessionId: 's1',
      artefact: null,
      artefacts: []
    })
  })

  it("keeps a preview of an artefact behind the front waiting, like the front's (PRDCT-5022)", async () => {
    const { service, root, deck, forwards } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'index.html'), 'other')
    await service.open('s1', other)
    // The first, behind the front now, lets go of its last hold: the session
    // still shows it, so its preview waits its minute rather than stopping.
    await service.release('s1', held.holdId)
    expect(forwards.resolve(held.lease)).toBeDefined()
  })

  it("lets go of the holds of a link the session's bound dropped (PRDCT-5022)", async () => {
    const { service, root, deck, forwards } = setup()
    await service.open('s1', deck)
    const held = await service.hold('s1')
    for (let n = 1; n <= MAX_PER_SESSION; n++) {
      const folder = join(root, `more-${n}`)
      mkdirSync(folder)
      writeFileSync(join(folder, 'index.html'), `${n}`)
      await service.open('s1', folder)
    }
    expect((await service.list()).map((a) => a.target)).not.toContain(deck)
    // Its hold went with it, and its preview, shown by nobody, stopped.
    expect(forwards.resolve(held.lease)).toBeUndefined()
    expect((await service.hold('s1', held.holdId)).holdId).not.toBe(held.holdId)
  })

  it("a version, the versions and a save name one of the session's artefacts, else the front one", async () => {
    const { service, root, deck } = setup()
    await service.open('s1', deck)
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'index.html'), 'other')
    await service.open('s1', other)
    await service.hold('s1', undefined, deck)
    await expect.poll(async () => (await service.versions('s1', deck)).error).toBeUndefined()
    expect(await service.versions('s1')).toEqual({
      versions: [],
      error: 'The preview of this artefact is not running.'
    })
    expect(await service.saveVersion('s1', deck)).toEqual({ version: 1, created: true })
    await expect(service.saveVersion('s1', join(root, 'nowhere'))).rejects.toThrow(NO_ARTEFACT_OPEN)
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

  it('lists the versions from the running preview, says when none runs, and is refused without a link', async () => {
    const { service, deck, calls } = setup()
    await expect(service.versions('s1')).rejects.toThrow()
    await service.open('s1', deck)
    expect(await service.versions('s1')).toEqual({
      versions: [],
      error: 'The preview of this artefact is not running.'
    })
    expect(calls()).toEqual([])
    await service.hold('s1')
    await expect.poll(calls, { timeout: 5_000 }).toEqual([`dev ${deck}`])
    await service.saveVersion('s1')
    expect(await service.versions('s1')).toEqual({
      versions: [{ version: 1, createdAt: '2026-11-13T10:00:00.000Z', fileCount: 1 }]
    })
    expect(calls()).toEqual([`dev ${deck}`, `route ${deck}`, `list ${deck}`])
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

  it('saves a version of each artefact of the session (PRDCT-5022)', async () => {
    const { service, root, deck, emitState, calls } = setup()
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'index.html'), 'other')
    await service.open('s1', deck)
    await service.open('s1', other)
    service.start()
    emitState('s1', 'working')
    emitState('s1', 'done')
    await expect
      .poll(() => [...calls()].sort(), { timeout: 5_000 })
      .toEqual([`command ${deck}`, `command ${other}`].sort())
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

  it('make room before the link of a tab that still runs: closed tabs never push it out', async () => {
    const { service, deck, known, setNow } = setup()
    let at = START
    const tick = (): void => setNow((at += 1000))
    await service.open('s1', deck)
    // Five hundred other tabs each open a page and are then closed for good.
    for (let n = 1; n <= MAX_LINKS; n++) {
      tick()
      known.add(`gone-${n}`)
      await service.open(`gone-${n}`, deck)
      known.delete(`gone-${n}`)
    }
    tick()
    await service.open('s2', deck)
    const listed = (await service.list()).map((a) => a.sessionId)
    expect(listed).toHaveLength(MAX_LINKS)
    expect(listed).toContain('s1')
    expect(listed).toContain('s2')
    expect(listed).not.toContain('gone-1')
  })
})

/** A ustar archive of the files given, the way npm packs a package. */
function tarOf(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.fill(' ', 148, 156)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const REGISTRY = 'https://registry.example.test'

/** A registry offering one release of the package, its `latest` held until `open()`. */
function fixtureRegistry(version: string): {
  fetch: typeof globalThis.fetch
  open: () => void
  asked: () => { latest: number; tarball: number }
} {
  const tgz = gzipSync(
    tarOf({
      'package/package.json': JSON.stringify({ name: '@antasphere/slideless', version }),
      'package/dist/bin.js': ''
    })
  )
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const asked = { latest: 0, tarball: 0 }
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    if (url === `${REGISTRY}/@antasphere%2fslideless/latest`) {
      asked.latest++
      await opened
      return new Response(
        JSON.stringify({ version, dist: { tarball: `${REGISTRY}/slideless.tgz`, integrity } }),
        { status: 200 }
      )
    }
    if (url === `${REGISTRY}/slideless.tgz`) {
      asked.tarball++
      return new Response(new Uint8Array(tgz), { status: 200 })
    }
    return new Response('nope', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, open: () => open(), asked: () => ({ ...asked }) }
}

/**
 * Clave's own copy below the release the accounts and the links need
 * (PRDCT-4266, the coordinator's ruling): the server installs the registry's
 * latest by itself at start, once a run, and never in place of the override.
 */
describe('Clave’s own copy older than the accounts need', () => {
  type Registry = ReturnType<typeof fixtureRegistry>
  /** A folder of the test's own: an artefact to open, data folders holding a copy
   *  of Slideless at a version, and services over them that install on their own. */
  const world = (): {
    root: string
    deck: string
    dataWith: (name: string, version: string) => string
    built: (
      dataDir: string,
      env: NodeJS.ProcessEnv,
      offered: Registry
    ) => { service: ArtefactServiceHandle; states: Array<[string, string | null]> }
  } => {
    const root = mkdtempSync(join(tmpdir(), 'clave-artefact-floor-'))
    dirs.push(root)
    const deck = join(root, 'work', 'deck')
    mkdirSync(deck, { recursive: true })
    writeFileSync(join(deck, 'index.html'), '<h1>deck</h1>')
    /** A data folder whose own copy of Slideless is `version`. */
    const dataWith = (name: string, version: string): string => {
      const cli = join(root, name, 'slideless', 'cli')
      mkdirSync(join(cli, version), { recursive: true })
      writeFileSync(join(cli, version, 'bin.js'), '')
      writeFileSync(join(cli, version, 'package.json'), JSON.stringify({ version }))
      writeFileSync(join(cli, 'current.json'), JSON.stringify({ version }))
      return join(root, name)
    }
    const built = (
      dataDir: string,
      env: NodeJS.ProcessEnv,
      offered: Registry
    ): { service: ArtefactServiceHandle; states: Array<[string, string | null]> } => {
      const service = createArtefactService({
        dataDir,
        execPath: process.execPath,
        env: { PATH: '/usr/bin:/bin', [REGISTRY_ENV]: REGISTRY, ...env },
        links: new ArtefactLinks(memory(), () => {}),
        forwards: new ForwardRegistry(),
        sessions: { knows: (id) => id === 's1', onState: () => () => {} },
        autoInstall: true,
        fetch: offered.fetch,
        log: () => {}
      })
      services.push(service)
      const states: Array<[string, string | null]> = []
      service.subscribe((event) => {
        if (event._tag === 'slideless.state_changed')
          states.push([event.state.phase, event.state.version])
      })
      return { service, states }
    }
    return { root, deck, dataWith, built }
  }

  it('installs nothing at start for a copy already at the release the accounts need', async () => {
    const { dataWith, built } = world()
    const registry = fixtureRegistry('0.15.0')
    registry.open()
    const { service, states } = built(dataWith('data', '0.15.0'), {}, registry)
    service.start()
    await settle(100)
    expect(registry.asked()).toEqual({ latest: 0, tarball: 0 })
    expect(await service.slidelessState()).toEqual({
      phase: 'ready',
      version: '0.15.0',
      error: null,
      override: false
    })
    expect(states).toEqual([])
  })

  it('is updated from the registry at start, once a run, and never on the override', async () => {
    const { root, deck, dataWith, built } = world()
    const registry = fixtureRegistry('0.15.0')
    const dataDir = dataWith('data', '0.14.1')
    const { service, states } = built(dataDir, {}, registry)
    service.start()
    expect(await service.slidelessState()).toMatchObject({ phase: 'installing' })
    registry.open()
    await expect
      .poll(async () => (await service.slidelessState()).phase, { timeout: 5_000 })
      .toBe('ready')
    expect(await service.slidelessState()).toEqual({
      phase: 'ready',
      version: '0.15.0',
      error: null,
      override: false
    })
    expect(states).toEqual([
      ['installing', null],
      ['ready', '0.15.0']
    ])
    expect(registry.asked()).toEqual({ latest: 1, tarball: 1 })

    // Once a run: the copy old again (a registry still behind), an open that
    // would install a missing copy tries nothing more.
    writeFileSync(
      join(dataDir, 'slideless', 'cli', 'current.json'),
      JSON.stringify({ version: '0.14.1' })
    )
    await service.open('s1', deck)
    await settle(100)
    expect(registry.asked()).toEqual({ latest: 1, tarball: 1 })
    expect(await service.slidelessState()).toMatchObject({ phase: 'ready', version: '0.14.1' })

    // A copy missing at start, installed from a registry still behind: that
    // install was the run's one, and an open tries nothing more.
    const behind = fixtureRegistry('0.14.1')
    behind.open()
    const fresh = built(join(root, 'data-missing'), {}, behind)
    fresh.service.start()
    await expect
      .poll(async () => (await fresh.service.slidelessState()).phase, { timeout: 5_000 })
      .toBe('ready')
    await fresh.service.open('s1', deck)
    await settle(100)
    expect(behind.asked()).toEqual({ latest: 1, tarball: 1 })
    expect(fresh.states).toEqual([
      ['installing', null],
      ['ready', '0.14.1']
    ])

    // Never on the override: the command it names is not Clave's to replace.
    const override = join(root, 'override-bin.js')
    writeFileSync(override, '')
    const named = built(
      dataWith('data-override', '0.14.1'),
      { [CLI_OVERRIDE_ENV]: override },
      registry
    )
    named.service.start()
    await named.service.open('s1', deck)
    await settle(100)
    expect(registry.asked()).toEqual({ latest: 1, tarball: 1 })
    expect(await named.service.slidelessState()).toMatchObject({ phase: 'ready', override: true })
    expect(named.states).toEqual([])
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

/**
 * The Slideless accounts and an artefact's links, through the service
 * (PRDCT-4266): its own copy run under its own Node and environment (a fake
 * spawn here, never a process), « New links go to » and the decks kept as
 * two owner-only documents of its data folder, the links of an artefact only
 * for the session that shows it, and a sign-in killed when it stops.
 */
describe('the Slideless accounts and the links, through the service', () => {
  const hubLogin = { kind: 'hub_login', argv: ['slideless', '--profile', 'decks', 'login'] }
  const settings = {
    annotator: false,
    forms: true,
    download: true,
    bar: true,
    pdf: true,
    pinVersion: false
  }

  function wired(): {
    service: ArtefactServiceHandle
    slideless: ReturnType<typeof fakeSlideless>
    dataDir: string
    deck: string
    cli: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'clave-artefact-accounts-'))
    dirs.push(root)
    const cli = join(root, 'override-bin.js')
    writeFileSync(cli, '')
    const deck = join(root, 'work', 'deck')
    mkdirSync(deck, { recursive: true })
    writeFileSync(join(deck, 'index.html'), '<h1>deck</h1>')
    const slideless = fakeSlideless((args, child) => {
      if (isListing(args)) return answer(listingJson([listedProfile(DECKS, hubLogin)]))(child)
      if (args.includes('open')) return answer('', 1, 'Error: no link file\n')(child)
      if (args.includes('push'))
        return answer(JSON.stringify({ presentation: { id: 'd1' }, version: { version: 1 } }))(
          child
        )
      if (args.includes('share'))
        return answer(
          JSON.stringify({ url: `${DECKS}/s/secret`, shareToken: { id: 't1', name: 'Clave' } })
        )(child)
      if (args.includes('unshare')) return answer(JSON.stringify({ id: 't1' }))(child)
      // A sign-in's command waits on its question.
    })
    const dataDir = join(root, 'data')
    const service = createArtefactService({
      dataDir,
      execPath: EXEC_PATH,
      env: { PATH: '/usr/bin:/bin', [CLI_OVERRIDE_ENV]: cli },
      links: new ArtefactLinks(memory(), () => {}),
      forwards: new ForwardRegistry(),
      sessions: { knows: (id) => id === 's1', onState: () => () => {} },
      autoInstall: false,
      spawn: slideless.deps.spawn!,
      log: () => {}
    })
    services.push(service)
    return { service, slideless, dataDir, deck, cli }
  }

  it('lists the accounts with its own copy, under its own Node and environment', async () => {
    const { service, slideless, cli } = wired()
    const accounts = await service.slidelessAccounts()
    expect(accounts.error).toBeNull()
    expect(accounts.profiles.map((p) => p.site.origin)).toEqual([DECKS])
    expect((await service.checkSlidelessAccounts()).checked).toBe(true)
    const [call] = slideless.calls
    expect(call!.command).toBe(EXEC_PATH)
    expect(call!.script).toBe(cli)
    expect(call!.args).toEqual(['--json', 'profiles'])
    expect(call!.options.env).toEqual({
      PATH: '/usr/bin:/bin',
      [CLI_OVERRIDE_ENV]: cli,
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('keeps « New links go to » and the decks as owner-only documents of its data folder', async () => {
    const { service, dataDir, deck } = wired()
    expect((await service.setNewLinksSite(`${DECKS}/`)).newLinksSite).toBe(DECKS)
    await service.open('s1', deck)
    const shared = await service.shareArtefact('s1', deck, { site: DECKS, link: settings })
    expect(shared).toMatchObject({ _tag: 'shared', link: { tokenId: 't1' } })
    for (const [file, content] of [
      ['slideless-settings.json', { v: 1, newLinksSite: DECKS }],
      [
        'artefact-decks.json',
        { v: 1, decks: { [deck]: expect.objectContaining({ deckId: 'd1' }) } }
      ]
    ] as const) {
      expect(statSync(join(dataDir, file)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(join(dataDir, file), 'utf8'))).toEqual(content)
    }
    expect(await service.artefactDeck('s1', deck)).toMatchObject({ deckId: 'd1', links: [{}] })
    expect(await service.revokeArtefactLink('s1', deck, 't1')).toMatchObject({ links: [] })
  })

  it('refuses the deck view of its own record of the shared pages while that file cannot be read', async () => {
    const { service, dataDir, deck } = wired()
    await service.open('s1', deck)
    await service.shareArtefact('s1', deck, { site: DECKS, link: settings })
    const file = join(dataDir, 'artefact-decks.json')
    chmodSync(file, 0o000)
    try {
      expect(await refusal(service.artefactDeck('s1', deck))).toBe(
        refused(recordUnreadable(file, 'EACCES: permission denied'))
      )
    } finally {
      chmodSync(file, 0o600)
    }
    expect(await service.artefactDeck('s1', deck)).toMatchObject({ deckId: 'd1', links: [{}] })
  })

  it('refuses the links of an artefact the session does not show', async () => {
    const { service, deck, slideless } = wired()
    await expect(service.artefactDeck('s1', deck)).rejects.toThrow(NO_ARTEFACT_OPEN)
    await expect(
      service.shareArtefact('s1', deck, { site: DECKS, link: settings })
    ).rejects.toThrow(NO_ARTEFACT_OPEN)
    await expect(service.revokeArtefactLink('s1', deck, 't1')).rejects.toThrow(NO_ARTEFACT_OPEN)
    expect(slideless.calls).toEqual([])
  })

  it('kills a sign-in waiting on its code when it stops', async () => {
    const { service, slideless } = wired()
    const starting = service.startSlidelessSignIn(DECKS, { email: 'someone@example.test' })
    await flush()
    const signIn = slideless.calls.at(-1)!
    expect(signIn.args).toContain('login')
    signIn.child.say('Code: ')
    expect(await starting).toMatchObject({ phase: 'code_asked' })
    await service.stop()
    expect(signIn.child.killedWith).toBe('SIGKILL')
    await service.cancelSlidelessSignIn('nobody')
  })
})
