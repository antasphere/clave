/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test helpers */
// The service's command line `install-server.sh` writes (issue #266): the
// release's version only for a `v<semver>` tag, and always how the server was
// installed, so a Mac can ask it to upgrade itself. The ARGS block of the
// script itself runs in bash with the variables set, paths with spaces
// included; nothing is installed and no service is touched.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
