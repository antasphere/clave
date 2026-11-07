/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test helpers */
// The service's command line `install-server.sh` writes (issue #266): the
// release's version only for a `v<semver>` tag, and always how the server was
// installed, so a Mac can ask it to upgrade itself. The ARGS block of the
// script itself runs in bash with the variables set, paths with spaces
// included; nothing is installed and no service is touched.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SERVER_UPGRADE_FAILURE_CODES,
  SERVER_UPGRADE_PHASES
} from '../packages/contract/src/upgrade-failure.ts'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-server.sh')
const CURRENT = '/tmp/path with spaces/current'

/** The script's ARGS, as bash builds them for `ref`. */
function args(ref, { tokenFile = '' } = {}) {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('ARGS=(\n')
  const end = source.indexOf('\nswitch_to()')
  expect(start, 'the ARGS block').toBeGreaterThan(0)
  expect(end, 'the end of the ARGS block').toBeGreaterThan(start)
  const setup = [
    'NODE=/opt/node/bin/node',
    `CURRENT_LINK=${JSON.stringify(CURRENT)}`,
    'CLAVE_DATA_DIR="/tmp/data with spaces"',
    'LISTEN_HOST=127.0.0.1',
    'CLAVE_PORT=43127',
    `CLAVE_TOKEN_FILE=${JSON.stringify(tokenFile)}`,
    'NAME=clave-e2e',
    'REF="$1"'
  ].join('\n')
  const out = execFileSync(
    'bash',
    ['-c', `${setup}\n${source.slice(start, end)}\nprintf '%s\\0' "\${ARGS[@]}"`, 'install', ref],
    { encoding: 'utf8' }
  )
  return out.replace(/\0$/, '').split('\0')
}
const after = (list, flag) => list[list.indexOf(flag) + 1]

describe('the service command line install-server.sh writes', () => {
  it.each(['v3.0.0-beta.9', 'v3.0.0', 'v10.2.3-rc.1'])(
    'names the version of the tag %s, without its v',
    (ref) => {
      const list = args(ref)
      expect(list.filter((a) => a === '--app-version')).toHaveLength(1)
      expect(after(list, '--app-version')).toBe(ref.slice(1))
    }
  )

  it.each(['dev', 'main', 'feature/v3.0.0', 'deadbeef', 'v3.0', '3.0.0'])(
    'names no version for %s, which is not a release tag',
    (ref) => {
      expect(args(ref)).not.toContain('--app-version')
    }
  )

  it.each(['v3.0.0-beta.9', 'dev'])('always says how %s was installed', (ref) => {
    const list = args(ref)
    expect(after(list, '--install-name')).toBe('clave-e2e')
    expect(after(list, '--install-script')).toBe(`${CURRENT}/scripts/install-server.sh`)
    expect(after(list, '--install-ref')).toBe(ref)
  })

  it('keeps every path one argument, spaces and all', () => {
    expect(args('v3.0.0', { tokenFile: '/tmp/my token' })).toEqual([
      '/opt/node/bin/node',
      `${CURRENT}/out/main/server-entry.js`,
      '--daemon',
      '--data-dir',
      '/tmp/data with spaces',
      '--host',
      '127.0.0.1',
      '--port',
      '43127',
      '--terminal-process',
      `${CURRENT}/out/main/terminal-process.js`,
      '--node',
      '/opt/node/bin/node',
      '--token-file',
      '/tmp/my token',
      '--app-version',
      '3.0.0',
      '--install-name',
      'clave-e2e',
      '--install-script',
      `${CURRENT}/scripts/install-server.sh`,
      '--install-ref',
      'v3.0.0'
    ])
  })
})

// How an upgrade failed, as a Mac learns it (issue #266): the script writes
// `phase=<phase>` as each phase starts and `code=<code>` where it fails, to the
// file CLAVE_INSTALL_STATUS_FILE names, the values from the contract's closed
// lists, and nothing else: no message, and never a command's output. It never
// hands that path to a command it runs.
describe('the codes install-server.sh writes to its status file', () => {
  /** The script's code, its comments out. */
  const code = () =>
    readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
  /** Its code without the two functions that write the file, `fail` and `phase`. */
  const callers = () =>
    code()
      .split('\n')
      .filter((line) => !/^(fail|phase)\(\)/.test(line))
      .join('\n')

  it('fails with exactly one known code at every site, and every script code has a site', () => {
    const source = callers()
    // `error` is gone: a site without a code cannot be written.
    expect(source.match(/(^|[\s;|&({])error(\s|$)/gm)).toBeNull()
    const sites = [...source.matchAll(/(^|[\s;|&({])fail(?![\w(-])(?:[ \t]+([^\s"']+))?/gm)]
    expect(sites.length, 'the fail sites').toBeGreaterThan(20)
    const used = new Set()
    for (const site of sites) {
      expect(SERVER_UPGRADE_FAILURE_CODES, site[0]).toContain(site[2])
      used.add(site[2])
    }
    const serverOnly = ['launcher-missing', 'launch-failed', 'unknown']
    expect([...used].sort()).toEqual(
      SERVER_UPGRADE_FAILURE_CODES.filter((c) => !serverOnly.includes(c)).sort()
    )
  })

  it('marks phases from the list only, each of them', () => {
    const marks = [...callers().matchAll(/(^|[\s;|&({])phase(?![\w(-])(?:[ \t]+([^\s"']+))?/gm)]
    for (const mark of marks) expect(SERVER_UPGRADE_PHASES, mark[0]).toContain(mark[2])
    expect([...new Set(marks.map((m) => m[2]))].sort()).toEqual([...SERVER_UPGRADE_PHASES].sort())
  })

  it('writes the status file in one place, a key and a value, from fail and phase only', () => {
    const writes = code().match(/>>?\s*"\$STATUS_FILE"/g)
    expect(writes).toEqual(['>> "$STATUS_FILE"'])
    expect(callers()).not.toMatch(/(^|[\s;|&({])status_line\s/m)
    expect(
      code()
        .match(/(^|[\s;|&({])status_line\s+\w+/gm)
        ?.map((m) => m.trim())
    ).toEqual(['status_line phase', 'status_line code'])
    expect(code()).toContain(`printf '%s=%s\\n' "$1" "$2" >> "$STATUS_FILE"`)
  })

  const SHA = '0123456789abcdef0123456789abcdef01234567'
  /** The real script up to its clone, under a home of its own, with a `git`
   *  that records what it was handed and tries the status file itself. */
  function install({ status = true, lsRemote = true, args = [], env = {} } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'clave-install-status-'))
    try {
      mkdirSync(path.join(home, 'bin'))
      const git = path.join(home, 'bin', 'git')
      writeFileSync(
        git,
        [
          '#!/bin/bash',
          'printf \'%s %s\\n\' "${CLAVE_INSTALL_STATUS_FILE-unset}" "${STATUS_FILE-unset}" >> "$HOME/git-saw"',
          "printf '[clave-server] git child output\\n' >&2",
          'for f in "${CLAVE_INSTALL_STATUS_FILE:-}" "${STATUS_FILE:-}"; do [[ -n "$f" ]] && printf \'code=rolled-back\\nchild wrote here\\n\' >> "$f"; done',
          lsRemote
            ? `case " $* " in *" ls-remote "*) printf '${SHA}\\trefs/tags/v9.9.9\\n'; exit 0 ;; esac`
            : '',
          'exit 1',
          ''
        ].join('\n')
      )
      chmodSync(git, 0o700)
      mkdirSync(path.join(home, '.config', 'e2e'), { recursive: true })
      writeFileSync(path.join(home, '.config', 'e2e', 'install.env'), 'CLAVE_HOST=loopback\n')
      const file = path.join(home, 'status')
      const result = spawnSync('/bin/bash', [SCRIPT, '--name', 'e2e', '--ref', 'v9.9.9', ...args], {
        encoding: 'utf8',
        env: {
          HOME: home,
          USER: 'e2e',
          SHELL: '/bin/sh',
          PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`,
          ...(status ? { CLAVE_INSTALL_STATUS_FILE: file } : {}),
          ...env
        }
      })
      const read = (name) =>
        existsSync(path.join(home, name)) ? readFileSync(path.join(home, name), 'utf8') : null
      return {
        code: result.status,
        stdout: result.stdout.replaceAll(home, '<home>'),
        stderr: result.stderr.replaceAll(home, '<home>'),
        status: read('status'),
        gitSaw: read('git-saw')?.replaceAll(home, '<home>') ?? null
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('writes exactly the phase and the code of a failure, never its message', () => {
    const run = install({ lsRemote: false })
    expect(run.code).toBe(1)
    expect(run.status).toBe('phase=resolve\ncode=repository-unreachable\n')
    expect(run.stderr).toContain('Could not reach https://github.com/antasphere/clave.git')
  })

  it('tells the phase of a command that fails under set -e, with no code', () => {
    const run = install()
    expect(run.code).not.toBe(0)
    expect(run.status).toBe('phase=resolve\nphase=clone\n')
    expect(run.stdout).toContain('Cloning v9.9.9')
  })

  it('fails an option it does not know with invalid-options', () => {
    expect(install({ args: ['--bogus'] }).status).toBe('code=invalid-options\n')
  })

  it('never hands the path to a command it runs', () => {
    const run = install()
    expect(run.gitSaw?.trim().split('\n')).toEqual(['unset unset', 'unset unset'])
    expect(run.status).not.toContain('child')
    expect(run.stderr).toContain('[clave-server] git child output')
  })

  it('keeps its own variable from a command even when the environment exported one (V6-F1a)', () => {
    const run = install({ env: { STATUS_FILE: '/tmp/clave-r1026-elsewhere' } })
    expect(run.gitSaw?.trim().split('\n')).toEqual(['unset unset', 'unset unset'])
    expect(run.status).toBe('phase=resolve\nphase=clone\n')
  })

  it('changes nothing else when the variable is unset', () => {
    const withFile = install()
    const without = install({ status: false })
    expect(without.status).toBeNull()
    expect({ ...without, status: null }).toEqual({ ...withFile, status: null })
  })
})
