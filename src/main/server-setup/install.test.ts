import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installFailure,
  installScriptPath,
  parseInstallEnv,
  readIdentityToken,
  readInstalledServer,
  runInstallScript,
  serviceState
} from './install'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-install-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** What bash's `printf %q` really writes for `value`. */
const quoted = (value: string): string =>
  execFileSync('/bin/bash', ['-c', 'printf "%q" "$1"', '_', value], { encoding: 'utf8' })

describe('installScriptPath', () => {
  it('is in the resources when packaged, in the app otherwise', () => {
    const opts = { resourcesPath: '/r', appPath: '/a' }
    expect(installScriptPath({ ...opts, isPackaged: true })).toBe('/r/scripts/install-server.sh')
    expect(installScriptPath({ ...opts, isPackaged: false })).toBe('/a/scripts/install-server.sh')
  })
})

describe('parseInstallEnv', () => {
  it('round-trips what printf %q writes', () => {
    const values = {
      PLAIN: '/home/someone/.local/share/clave-server',
      SPACE: '/home/some one/data dir',
      QUOTE: "/home/someone/it's here",
      LINE: 'one\ntwo\tthree',
      EMPTY: ''
    }
    const text = [
      '# Written by install-server.sh',
      '',
      ...Object.entries(values).map(([key, value]) => `${key}=${quoted(value)}`)
    ].join('\n')
    expect(parseInstallEnv(text)).toEqual(values)
  })

  it('decodes the octal bytes of a non-ASCII path as UTF-8, as a C-locale bash writes them', () => {
    // bash 3.2 under LC_ALL=C writes each byte of "ü" as an octal escape.
    const written = execFileSync('/bin/bash', ['-c', 'printf "%q" "$1"', '_', '/tmp/ü data'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' }
    })
    expect(parseInstallEnv(`V=${written}`)).toEqual({ V: '/tmp/ü data' })
    expect(parseInstallEnv("V=$'/tmp/\\303\\274'")).toEqual({ V: '/tmp/ü' })
  })

  it('reads single-quoted and $-quoted words', () => {
    expect(parseInstallEnv("A='x y'\nB=$'a\\nb\\'c\\\\'\nC=a\\ b\\\\c")).toEqual({
      A: 'x y',
      B: "a\nb'c\\",
      C: 'a b\\c'
    })
  })
})

describe('readInstalledServer', () => {
  it('reads the url and the data dir, null without either', () => {
    const config = temp()
    expect(readInstalledServer({ configDir: config, name: 'clave-server' })).toBeNull()
    mkdirSync(join(config, 'clave-server'))
    const file = join(config, 'clave-server', 'install.env')
    writeFileSync(
      file,
      `CLAVE_DATA_DIR=${quoted('/data/with space')}\nCLAVE_URL=${quoted('http://100.64.0.1:43127')}\n`
    )
    expect(readInstalledServer({ configDir: config, name: 'clave-server' })).toEqual({
      url: 'http://100.64.0.1:43127',
      dataDir: '/data/with space'
    })
    writeFileSync(file, `CLAVE_DATA_DIR=/data\nCLAVE_URL=''\n`)
    expect(readInstalledServer({ configDir: config, name: 'clave-server' })).toBeNull()
  })
})

describe('readIdentityToken', () => {
  it("refuses a token one character short of the daemon's own rule, takes one at the floor", () => {
    const data = mkdtempSync(join(tmpdir(), 'clave-identity-'))
    mkdirSync(join(data, 'daemon'), { recursive: true })
    const write = (token: string): void =>
      writeFileSync(join(data, 'daemon', 'identity.json'), JSON.stringify({ serverId: 's', token }))
    write('x'.repeat(31))
    expect(() => readIdentityToken(data)).toThrow(/no valid token/)
    write('x'.repeat(32))
    expect(readIdentityToken(data)).toBe('x'.repeat(32))
    write('y'.repeat(4097))
    expect(() => readIdentityToken(data)).toThrow(/no valid token/)
  })

  it('accepts a good token and refuses a short one', () => {
    const data = temp()
    mkdirSync(join(data, 'daemon'))
    const file = join(data, 'daemon', 'identity.json')
    const token = 'a'.repeat(48)
    writeFileSync(file, JSON.stringify({ serverId: 'srv', token }))
    expect(readIdentityToken(data)).toBe(token)
    writeFileSync(file, JSON.stringify({ serverId: 'srv', token: 'short' }))
    expect(() => readIdentityToken(data)).toThrow(/no valid token/)
    try {
      readIdentityToken(data)
    } catch (error) {
      expect((error as Error).message).not.toContain('short')
    }
    writeFileSync(file, `{"token": "${token}"`)
    expect(() => readIdentityToken(data)).toThrow(/no valid token/)
    expect(() => readIdentityToken(join(data, 'absent'))).toThrow(/no valid token/)
  })
})

describe('serviceState', () => {
  it('is running, stopped or not installed', async () => {
    const dir = temp()
    const plistPath = join(dir, 'service.plist')
    const probed: string[] = []
    const probe = async (url: string): Promise<boolean> => (probed.push(url), url.includes(':1/'))
    expect(await serviceState({ url: 'http://127.0.0.1:1', plistPath, probe })).toBe('running')
    expect(probed).toEqual(['http://127.0.0.1:1/health/live'])
    expect(await serviceState({ url: 'http://127.0.0.1:2', plistPath, probe })).toBe(
      'not-installed'
    )
    writeFileSync(plistPath, '<plist/>')
    expect(await serviceState({ url: null, plistPath, probe })).toBe('stopped')
  })
})

describe('runInstallScript', () => {
  const standIn = (body: string): string => {
    const file = join(temp(), 'install-server.sh')
    writeFileSync(file, `set -e\n${body}\n`)
    return file
  }

  it('reports the phases in order and keeps the output in the log', async () => {
    const script = standIn(
      [
        'echo "args: $*"',
        'echo "phase=resolve" >> "$CLAVE_INSTALL_STATUS_FILE"',
        'sleep 0.5',
        'echo "phase=build" >> "$CLAVE_INSTALL_STATUS_FILE"',
        'echo building >&2',
        'sleep 0.5'
      ].join('\n')
    )
    const logDir = join(temp(), 'logs')
    const phases: string[] = []
    const result = await runInstallScript({
      script,
      args: ['--host', '127.0.0.1'],
      env: { PATH: process.env.PATH },
      logDir,
      onPhase: (phase) => phases.push(phase)
    })
    expect(result.code).toBe(0)
    expect(phases).toEqual(['resolve', 'build'])
    expect(result.logPath).toBe(join(logDir, 'install.log'))
    const log = readFileSync(result.logPath, 'utf8')
    expect(log).toContain('install-server.sh --host 127.0.0.1')
    expect(log).toContain('args: --host 127.0.0.1')
    expect(log).toContain('building')
    expect(statSync(result.logPath).mode & 0o777).toBe(0o600)
    expect(statSync(logDir).mode & 0o777).toBe(0o700)
  })

  it('turns a failed run into its code, phase and exit code', async () => {
    const script = standIn(
      [
        'echo "phase=build" >> "$CLAVE_INSTALL_STATUS_FILE"',
        'echo "code=build-incomplete" >> "$CLAVE_INSTALL_STATUS_FILE"',
        'exit 3'
      ].join('\n')
    )
    const result = await runInstallScript({
      script,
      args: [],
      env: { PATH: process.env.PATH },
      logDir: temp(),
      onPhase: () => undefined
    })
    expect(result.code).toBe(3)
    expect(installFailure(result.status, result.code, result.logPath)).toEqual({
      ok: false,
      code: 'build-incomplete',
      phase: 'build',
      exitCode: 3,
      logPath: result.logPath
    })
  })

  it('says unknown when the script stopped without a code', () => {
    expect(installFailure(null, 1, '/log')).toEqual({
      ok: false,
      code: 'unknown',
      exitCode: 1,
      logPath: '/log'
    })
  })
})
