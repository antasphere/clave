/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of the daemon's entry */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ONE_BOOT_BUDGET_MS,
  bunBinary,
  readServerDiscovery,
  startServerProcess
} from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The daemon's own wiring of `--no-titles` (apps/server/src/main.ts): the flag
// turns the title module off inside the process, not only in the discovery
// file, and without it titles stay on. Every boot here runs under the
// isolation the native fixture was reviewed with (packages/mobile-native,
// PR #355), so that a broken wiring, titles on, still reaches no provider:
// `--test-no-activate` and `--test-no-machine-usage` on every boot (no usage
// clock, no machine login read), Bun with `--no-env-file`, an allowlisted
// environment, a stand-in login shell, recorders for `claude` and `codex`
// first on its PATH, an empty Claude config folder and Codex home, a keychain
// FILE on macOS, and the account issuer on a closed loopback port, never the
// hub. The recorders' log must stay empty. No chat is created.

/** The keys the daemon's environment copies from this one, when set. */
const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ'
]
/** The system directories after the recorders: `security`, `sysctl`, `sh`. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const USAGE_OFF = ['--test-no-activate', '--test-no-machine-usage']
/** A loopback port nothing listens on: a request to the issuer fails here. */
const CLOSED_ISSUER = 'http://127.0.0.1:9'

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function script(file, lines) {
  writeFileSync(file, `${lines.join('\n')}\n`)
  chmodSync(file, 0o755)
  return file
}

/** The stand-ins and the empty homes, under `root`. */
function isolation(root) {
  const stubs = path.join(root, 'stubs')
  const claudeConfig = path.join(root, 'claude-config')
  const codexHome = path.join(root, 'codex-home')
  for (const dir of [stubs, claudeConfig, codexHome]) mkdirSync(dir)
  const log = path.join(stubs, 'recorder.log')
  writeFileSync(log, '', { mode: 0o600 })
  const record = (name) =>
    `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${name} "$1" "$2" >> '${log}'`
  // The daemon reads its login environment through `$SHELL -lic 'env -0'`:
  // this one answers with the environment it was handed. A `-c` command runs
  // with /bin/sh. Named zsh, a name the daemon accepts as a login shell.
  const shell = script(path.join(stubs, 'zsh'), [
    '#!/bin/sh',
    'cmd=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -c) shift; cmd="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$cmd" in',
    '  ""|"env -0") exec /usr/bin/env -0 ;;',
    '  *) exec /bin/sh -c "$cmd" ;;',
    'esac'
  ])
  const claude = script(path.join(stubs, 'claude'), ['#!/bin/sh', record('claude'), 'exit 0'])
  const codex = script(path.join(stubs, 'codex'), ['#!/bin/sh', record('codex'), 'exit 0'])
  const realBun = bunBinary({ PATH: process.env.PATH ?? '' }, REPO)
  // Bun with --no-env-file before the entry, on the environment it was handed:
  // /bin/sh adds PWD and SHLVL to what it runs, so they are taken out again.
  const bun = script(path.join(stubs, 'bun-no-env-file'), [
    '#!/bin/sh',
    `exec /usr/bin/env -u PWD -u SHLVL ${JSON.stringify(realBun)} --no-env-file "$@"`
  ])
  let keychain
  if (process.platform === 'darwin') {
    keychain = path.join(root, 'test.keychain-db')
    execFileSync('/usr/bin/security', ['create-keychain', '-p', '', keychain], { stdio: 'ignore' })
    execFileSync('/usr/bin/security', ['set-keychain-settings', keychain], { stdio: 'ignore' })
  }
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, {
    SHELL: shell,
    PATH: `${stubs}${path.delimiter}${SYSTEM_PATH}`,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
    CLAVE_ANTASPHERE_ISSUER: CLOSED_ISSUER,
    CLAVE_BUN: bun,
    ...(keychain && { CLAVE_KEYCHAIN_FILE: keychain })
  })
  return { env, log, claude, codex }
}

/** Run `source` inside the daemon, through the test route. */
async function inside(server, source) {
  const response = await fetch(`${server.url}/e2e/evaluate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source })
  })
  const body = await response.json()
  if (response.status !== 200 || !body?.ok)
    throw new Error(`POST /e2e/evaluate answered ${response.status}: ${JSON.stringify(body)}`)
  return body.value
}

describe("the daemon's title opt-out, booted", () => {
  let root = null
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it(
    'under --no-titles the title module is off inside the daemon, the discovery file says so, and a one-shot would reach only the recorder',
    async () => {
      root = mkdtempSync(path.join(tmpdir(), 'clave-server-no-titles-'))
      const iso = isolation(root)
      const server = await startServerProcess({
        repo: REPO,
        dataDir: path.join(root, 'data'),
        terminals: 'none',
        env: iso.env,
        args: ['--no-titles', ...USAGE_OFF]
      })
      try {
        expect(readServerDiscovery(server.dataDir)).toMatchObject({
          titles: 'off',
          testMode: true,
          machineUsage: false
        })
        const seen = await inside(
          server,
          `async () => {
            const titles = globalThis.__claveE2E.titles
            const launch = await titles.launch()
            return {
              disabled: titles.disabled(),
              file: launch.file,
              codex: titles.locate('codex'),
              keys: Object.keys(process.env).sort()
            }
          }`
        )
        expect(seen.disabled).toBe('--no-titles')
        expect(realpathSync(seen.file)).toBe(realpathSync(iso.claude))
        expect(realpathSync(seen.codex)).toBe(realpathSync(iso.codex))
        // Names compared, never values: exactly the keys the daemon was handed.
        const handed = Object.keys(iso.env).sort()
        const extra = seen.keys.filter((k) => !handed.includes(k))
        const missing = handed.filter((k) => !seen.keys.includes(k))
        expect({ extra, missing }).toEqual({ extra: [], missing: [] })
      } finally {
        await server.stop()
      }
      expect(alive(server.pid)).toBe(false)
      expect(readFileSync(iso.log, 'utf8')).toBe('')
    },
    ONE_BOOT_BUDGET_MS
  )

  it(
    'without the flag titles stay on: the opt-out is the flag alone, and the hooks answer null',
    async () => {
      root = mkdtempSync(path.join(tmpdir(), 'clave-server-no-titles-'))
      const iso = isolation(root)
      const server = await startServerProcess({
        repo: REPO,
        dataDir: path.join(root, 'data'),
        terminals: 'none',
        env: iso.env,
        args: USAGE_OFF
      })
      try {
        expect(readServerDiscovery(server.dataDir)).toMatchObject({
          titles: 'on',
          testMode: true,
          machineUsage: false
        })
        expect(await inside(server, '() => globalThis.__claveE2E.titles.disabled()')).toBeNull()
      } finally {
        await server.stop()
      }
      expect(alive(server.pid)).toBe(false)
      expect(readFileSync(iso.log, 'utf8')).toBe('')
    },
    ONE_BOOT_BUDGET_MS
  )
})
