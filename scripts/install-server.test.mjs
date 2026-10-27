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

// The messages a Mac publishes when an upgrade fails (issue #266): the script
// appends its own info/warn/error messages to the file CLAVE_INSTALL_STATUS_FILE
// names, plain and one per line, and never hands that path to a command it
// runs, so nothing git, npm or node prints can land there.
describe('the status file install-server.sh writes its own messages to', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567'
  /** The real script up to its clone, under a home of its own, with a `git` that
   *  prints its own [clave-server] line and tries the status file itself. */
  function install({ status = true, lsRemote = true, repo } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'clave-install-status-'))
    try {
      mkdirSync(path.join(home, 'bin'))
      const git = path.join(home, 'bin', 'git')
      writeFileSync(
        git,
        [
          '#!/bin/bash',
          'printf \'%s\\n\' "${CLAVE_INSTALL_STATUS_FILE-unset}" >> "$HOME/git-saw"',
          "printf '[clave-server] git child output\\n' >&2",
          '[[ -n "${CLAVE_INSTALL_STATUS_FILE:-}" ]] && printf \'child wrote here\\n\' >> "$CLAVE_INSTALL_STATUS_FILE"',
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
      const result = spawnSync(
        '/bin/bash',
        [SCRIPT, '--name', 'e2e', '--ref', 'v9.9.9', ...(repo ? ['--repo', repo] : [])],
        {
          encoding: 'utf8',
          env: {
            HOME: home,
            USER: 'e2e',
            SHELL: '/bin/sh',
            PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`,
            ...(status ? { CLAVE_INSTALL_STATUS_FILE: file } : {})
          }
        }
      )
      const read = (name) =>
        existsSync(path.join(home, name)) ? readFileSync(path.join(home, name), 'utf8') : null
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        status: read('status'),
        gitSaw: read('git-saw')
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('holds its info messages, plain and one per line', () => {
    const run = install()
    expect(run.code).not.toBe(0)
    expect(run.status).toBe('v9.9.9 is 0123456789ab\nCloning v9.9.9\n')
    expect(run.stdout).toContain('[clave-server]')
  })

  it('holds its error message, a newline inside it written as a space', () => {
    const run = install({ lsRemote: false, repo: 'https://example.invalid/a\nb.git' })
    expect(run.code).toBe(1)
    expect(run.status).toBe('Could not reach https://example.invalid/a b.git\n')
  })

  it('never hands the path to a command it runs, so their output never lands there', () => {
    const run = install()
    expect(run.gitSaw?.trim().split('\n')).toEqual(['unset', 'unset'])
    expect(run.status).not.toContain('child')
    expect(run.stderr).toContain('[clave-server] git child output')
  })

  it('changes nothing else when the variable is unset', () => {
    const withFile = install()
    const without = install({ status: false })
    expect(without.status).toBeNull()
    expect({ ...without, status: null }).toEqual({ ...withFile, status: null })
  })
})
