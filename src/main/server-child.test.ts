/**
 * The separate server's command (PRDCT-3434): what the shell tells its child
 * and what it keeps from it. The real child from the built bundle is the
 * e2e `server-boot` spec in separate mode and `scripts/server-process.test.mjs`.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SEPARATE_SERVER_KILL_AFTER_MS,
  flagsForServerChild,
  serverChildCommand,
  startSeparateServer
} from './server-child'
import { QUIT_CEILING_MS } from './quit-cleanup'

describe('the separate server command', () => {
  it('runs the server bundle beside main under the app binary as Node, with the terminal process bundle, its data and its parent', () => {
    const { cmd, args, env } = serverChildCommand({
      execPath: '/Applications/Clave.app/Contents/MacOS/Clave',
      bundleDir: '/Applications/Clave.app/Contents/Resources/app.asar/out/main',
      dataDir: '/Users/x/Library/Application Support/Clave/server',
      parent: 4242,
      flags: ['--test-no-activate'],
      env: { PATH: '/usr/bin', CLAVE_SERVER_URL: 'http://outer', CLAVE_SERVER_TOKEN: 'outer' }
    })
    expect(cmd).toBe('/Applications/Clave.app/Contents/MacOS/Clave')
    expect(args).toEqual([
      '/Applications/Clave.app/Contents/Resources/app.asar/out/main/server-entry.js',
      '--data-dir',
      '/Users/x/Library/Application Support/Clave/server',
      '--port',
      '0',
      '--terminal-process',
      '/Applications/Clave.app/Contents/Resources/app.asar/out/main/terminal-process.js',
      '--parent',
      '4242',
      '--test-no-activate'
    ])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PATH).toBe('/usr/bin')
    // An outer server's pair never reaches the child.
    expect('CLAVE_SERVER_URL' in env).toBe(false)
    expect('CLAVE_SERVER_TOKEN' in env).toBe(false)
  })

  it('tells the child where the shipped plugins are and the app version, before the test flags', () => {
    const { args } = serverChildCommand({
      execPath: '/A/Clave.app/Contents/MacOS/Clave',
      bundleDir: '/A/Clave.app/Contents/Resources/app.asar/out/main',
      dataDir: '/d/server',
      parent: 1,
      pluginsBundled: '/A/Clave.app/Contents/Resources/plugins',
      appVersion: '2.4.0',
      flags: ['--test-no-activate']
    })
    expect(args.slice(-5)).toEqual([
      '--plugins-bundled',
      '/A/Clave.app/Contents/Resources/plugins',
      '--app-version',
      '2.4.0',
      '--test-no-activate'
    ])
  })

  it('passes on the shell’s test and development flags and nothing else of its argv', () => {
    expect(
      flagsForServerChild([
        '/bin/electron',
        '.',
        '--user-data-dir=/tmp/x',
        '--test-no-activate',
        '--dev-echo-adapter',
        '--server=separate',
        '--test-version=2.0.0-beta.1'
      ])
    ).toEqual(['--test-no-activate', '--dev-echo-adapter', '--test-version=2.0.0-beta.1'])
  })

  it('the kill after the SIGTERM fits inside the quit’s ceiling', () => {
    expect(SEPARATE_SERVER_KILL_AFTER_MS).toBeLessThan(QUIT_CEILING_MS)
  })
})

describe('starting the separate server', () => {
  it('a child that exits before announcing itself rejects with its stderr, and is gone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-server-child-'))
    try {
      // A "server entry" that complains and exits: Node runs the script the
      // command names, so the fake bundle takes the entry's place.
      writeFileSync(
        path.join(dir, 'server-entry.js'),
        "process.stderr.write('clave-server: --data-dir is wrong\\n'); process.exit(2)\n"
      )
      writeFileSync(path.join(dir, 'terminal-process.js'), '')
      const log: string[] = []
      await expect(
        startSeparateServer({
          execPath: process.execPath,
          bundleDir: dir,
          dataDir: path.join(dir, 'data'),
          parent: process.pid,
          log: (line) => log.push(line)
        })
      ).rejects.toThrow(/exited \(2\) before announcing itself[\s\S]*--data-dir is wrong/)
      expect(log).toContain('clave-server: --data-dir is wrong')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a child that announces itself is the handle; its stop ends it, and an exit while running is reported', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clave-server-child-ok-'))
    try {
      writeFileSync(
        path.join(dir, 'server-entry.js'),
        [
          "process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:1', token: 't' }) + '\\n')",
          "process.stderr.write('clave-server: listening\\n')",
          "process.on('SIGTERM', () => process.exit(0))",
          'setInterval(() => {}, 1000)'
        ].join('\n')
      )
      writeFileSync(path.join(dir, 'terminal-process.js'), '')
      const exits: Array<number | string | null> = []
      const server = await startSeparateServer({
        execPath: process.execPath,
        bundleDir: dir,
        dataDir: path.join(dir, 'data'),
        parent: process.pid,
        onExit: (code) => exits.push(code)
      })
      expect(server.url).toBe('http://127.0.0.1:1')
      expect(server.token).toBe('t')
      expect(server.pid).toBeGreaterThan(0)
      await server.stop()
      // A stop is not an exit "while running".
      await new Promise((r) => setTimeout(r, 50))
      expect(exits).toEqual([])
      expect(() => process.kill(server.pid, 0)).toThrow()

      const dying = await startSeparateServer({
        execPath: process.execPath,
        bundleDir: dir,
        dataDir: path.join(dir, 'data'),
        parent: process.pid,
        onExit: (code) => exits.push(code)
      })
      process.kill(dying.pid, 'SIGKILL')
      const end = Date.now() + 5000
      while (exits.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
      expect(exits).toEqual(['SIGKILL'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
