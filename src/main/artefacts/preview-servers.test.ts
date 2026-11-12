import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreviewServers, artefactTarget } from './preview-servers'
import { writePreviewHost } from './preview-host'

/**
 * A stand-in for the Slideless CLI, run as a real child process under the
 * real preview host (`preview-host.ts`): it answers `dev <target> --port <n>
 * … --json` by listening on the port, printing the address line the real CLI
 * prints, and counting snapshots on the real route (header required, as the
 * real one does). The host takes itself out of `argv`, so the stand-in reads
 * its arguments as the real CLI does.
 */
const FAKE_CLI = `
const http = require('http');
const args = process.argv.slice(2);
if (process.env.FAKE_MODE === 'crash') { console.error('Error: no entry page in the folder'); process.exit(1); }
const FOREIGN = process.env.FAKE_MODE === 'foreign';
const DIE = process.env.FAKE_MODE === 'die';
if (process.env.ELECTRON_RUN_AS_NODE !== '1') { console.error('not run as node'); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1]);
const store = args[args.indexOf('--store') + 1];
let version = 0;
http.createServer((req, res) => {
  if (req.url === '/__slideless/snapshot' && req.method === 'POST') {
    if (req.headers['x-slideless'] !== 'snapshot') { res.writeHead(403); return res.end('{}'); }
    version++;
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ version, created: true, store, target: args[1] }));
  }
  res.writeHead(200); res.end('ok');
}).listen(port, '127.0.0.1', () => {
  console.log('noise before the address');
  if (FOREIGN) console.log(JSON.stringify({ url: 'http://attacker.example/' }));
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port + '/', entry: 'index.html' }));
  if (DIE) setTimeout(() => process.exit(3), 300);
});
`

const dirs: string[] = []
const servers: PreviewServers[] = []
afterEach(() => {
  servers.splice(0).forEach((s) => s.stopAll())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

interface Setup {
  root: string
  deck: string
  servers: PreviewServers
  spawned: string[][]
  children: ChildProcess[]
  cliPath: string
  hostPath: string
}

function setup(env: NodeJS.ProcessEnv = {}, onExit?: (target: string) => void): Setup {
  const root = mkdtempSync(join(tmpdir(), 'clave-artefacts-'))
  dirs.push(root)
  const cliPath = join(root, 'fake-cli.cjs')
  writeFileSync(cliPath, FAKE_CLI)
  const hostPath = writePreviewHost(join(root, 'data'))
  const deck = join(root, 'deck')
  mkdirSync(deck)
  writeFileSync(join(deck, 'index.html'), '<h1>x</h1>')
  const spawned: string[][] = []
  const children: ChildProcess[] = []
  const servers_ = new PreviewServers({
    spawn: (command, args, options) => {
      spawned.push([command, ...args])
      const child = spawn(command, args, options)
      children.push(child)
      return child
    },
    fetch: globalThis.fetch,
    execPath: process.execPath,
    hostPath,
    store: join(root, 'store'),
    resolveCli: () => ({ cli: { cliPath, version: '0.14.0', override: false } }),
    env: { ...process.env, ...env },
    startTimeoutMs: 5000,
    onExit
  })
  servers.push(servers_)
  return { root, deck, servers: servers_, spawned, children, cliPath, hostPath }
}

const alive = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null

describe('artefact servers', () => {
  it('runs the CLI under the preview host with Electron Node on a free port, keeps versions in its store, and answers the address', async () => {
    const { deck, servers: s, spawned, cliPath, hostPath, root, children } = setup()
    const { url, holder } = await s.serve(deck)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(holder).toMatch(/^[0-9a-f-]{36}$/)
    const port = url.match(/:(\d+)\//)![1]
    // The child's input is a pipe this process holds open and never writes to.
    expect(children[0]!.stdin).not.toBeNull()
    expect(children[0]!.stdin!.writableLength).toBe(0)
    expect(spawned[0]).toEqual([
      process.execPath,
      hostPath,
      cliPath,
      'dev',
      deck,
      '--port',
      port,
      '--no-open',
      '--json',
      '--store',
      join(root, 'store')
    ])
    expect(await (await fetch(url)).text()).toBe('ok')
  })

  it('shares one server between holders and stops it with the last one', async () => {
    const { deck, servers: s, spawned } = setup()
    const a = await s.serve(deck)
    const b = await s.serve(`${deck}/`)
    expect(b.url).toBe(a.url)
    expect(b.holder).not.toBe(a.holder)
    expect(spawned).toHaveLength(1)
    s.release(deck, a.holder)
    // A holder counts once.
    s.release(deck, a.holder)
    expect(s.targets()).toEqual([deck])
    s.release(deck, b.holder)
    expect(s.targets()).toEqual([])
    await expect
      .poll(
        async () =>
          fetch(a.url).then(
            () => 'up',
            () => 'down'
          ),
        { timeout: 3000 }
      )
      .toBe('down')
  })

  it('saves a version through the dev server route, with its header', async () => {
    const { deck, servers: s } = setup()
    await s.serve(deck)
    expect(await s.snapshot(deck)).toEqual({ version: 1, created: true })
    expect(await s.snapshot(deck)).toEqual({ version: 2, created: true })
    await expect(s.snapshot(join(deck, 'other'))).rejects.toThrow(/not being served/)
  })

  it('says why the CLI could not start, forgets the target, and reports no crash', async () => {
    const exited: string[] = []
    const { deck, servers: s } = setup({ FAKE_MODE: 'crash' }, (t) => exited.push(t))
    await expect(s.serve(deck)).rejects.toThrow(/no entry page in the folder/)
    expect(s.targets()).toEqual([])
    // A CLI that cannot start must not be started again by its holders, forever.
    await new Promise((r) => setTimeout(r, 300))
    expect(exited).toEqual([])
  })

  it('refuses to start without a CLI, saying why', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clave-artefacts-'))
    dirs.push(root)
    const s = new PreviewServers({
      spawn,
      fetch: globalThis.fetch,
      execPath: process.execPath,
      hostPath: join(root, 'host.mjs'),
      store: join(root, 'store'),
      resolveCli: () => ({ cli: null, reason: 'Slideless is not installed yet' })
    })
    await expect(s.serve(root)).rejects.toThrow('Slideless is not installed yet')
  })

  it('takes a folder or an .html file, absolute and existing, and nothing else', () => {
    const { deck } = setup()
    expect(artefactTarget(deck)).toBe(deck)
    expect(artefactTarget(join(deck, 'index.html'))).toBe(join(deck, 'index.html'))
    expect(() => artefactTarget('deck')).toThrow(/absolute/)
    expect(() => artefactTarget(join(deck, 'nope'))).toThrow(/No such/)
    writeFileSync(join(deck, 'notes.txt'), 'x')
    expect(() => artefactTarget(join(deck, 'notes.txt'))).toThrow(/folder or an .html/)
  })

  it('starts ONE child for two callers in the same moment', async () => {
    const { deck, servers: s, spawned } = setup()
    const [a, b] = await Promise.all([s.serve(deck), s.serve(deck)])
    expect(a.url).toBe(b.url)
    expect(spawned).toHaveLength(1)
    s.release(deck, a.holder)
    expect(s.targets()).toEqual([deck])
    s.release(deck, b.holder)
    expect(s.targets()).toEqual([])
  })

  it('leaves no child behind when the last holder lets go while it starts', async () => {
    const { deck, servers: s, children } = setup()
    const pending = s.serve(deck)
    const raced = pending.then(
      (served) => served,
      () => null
    )
    // The holder is only known once serve answers; stopAll is the release that
    // can land during the start (a quit, a closed window).
    s.stopAll()
    await raced
    await new Promise((r) => setTimeout(r, 300))
    expect(children.filter(alive)).toEqual([])
    expect(s.targets()).toEqual([])
  })

  it('takes only a loopback address from the CLI', async () => {
    const { deck, servers: s } = setup({ FAKE_MODE: 'foreign' })
    expect((await s.serve(deck)).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  it('reports a child that dies under its holders, and not one it stopped', async () => {
    const exited: string[] = []
    const { deck, servers: s } = setup({ FAKE_MODE: 'die' }, (t) => exited.push(t))
    await s.serve(deck)
    await expect.poll(() => exited, { timeout: 3000 }).toEqual([deck])
    expect(s.targets()).toEqual([])
    const calm = setup({}, (t) => exited.push(t))
    const held = await calm.servers.serve(calm.deck)
    calm.servers.release(calm.deck, held.holder)
    await new Promise((r) => setTimeout(r, 500))
    expect(exited).toEqual([deck])
  })

  it('after a crash, the old holder does nothing to the new server another holder serves', async () => {
    const { deck, servers: s, children } = setup({ FAKE_MODE: 'die' }, () => {})
    const first = await s.serve(deck)
    await expect.poll(() => s.targets(), { timeout: 3000 }).toEqual([])
    // The fake dies again 300 ms after each start; serve the new one and hold it.
    const second = await s.serve(deck)
    s.release(deck, first.holder)
    expect(s.targets()).toEqual([deck])
    expect(alive(children.at(-1)!)).toBe(true)
    s.release(deck, second.holder)
  })
})
