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
// environment, a home folder of the test's own as HOME (the daemon's readers
// that find the home through `os.homedir()` or HOME find it, never the
// person's), a stand-in login shell, recorders for `claude` and `codex` first
// on its PATH, an empty Claude config folder and Codex home, a keychain FILE
// on macOS, and the account issuer on a closed loopback port, never the hub.
// The recorders' log must stay empty. No chat is created.

/** The keys the daemon's environment copies from this one, when set. HOME
 *  is not one of them: the daemon's home is the test's own folder. */
const ENV_ALLOWLIST = ['USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']
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

/** One shell word: the value in single quotes. */
const quoted = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/** The keychain search list's paths, never anything inside a keychain. */
const searchList = () =>
  execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' })

/** The stand-ins and the empty homes, under `root`. On macOS the keychain
 *  file is named to `onKeychain` before it is created, so the cleanup deletes
 *  it whatever happens next. */
function isolation(root, onKeychain) {
  const stubs = path.join(root, 'stubs')
  const home = path.join(root, 'home')
  const claudeConfig = path.join(root, 'claude-config')
  const codexHome = path.join(root, 'codex-home')
  for (const dir of [stubs, home, claudeConfig, codexHome]) mkdirSync(dir)
  const log = path.join(stubs, 'recorder.log')
  writeFileSync(log, '', { mode: 0o600 })
  const record = (name) =>
    `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ${name} "$1" "$2" >> '${log}'`
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
    onKeychain(keychain)
    execFileSync('/usr/bin/security', ['create-keychain', '-p', '', keychain], { stdio: 'ignore' })
    execFileSync('/usr/bin/security', ['set-keychain-settings', keychain], { stdio: 'ignore' })
  }
  const shell = path.join(stubs, 'zsh')
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, {
    HOME: home,
    SHELL: shell,
    PATH: `${stubs}${path.delimiter}${SYSTEM_PATH}`,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
    CLAVE_ANTASPHERE_ISSUER: CLOSED_ISSUER,
    CLAVE_BUN: bun,
    ...(keychain && { CLAVE_KEYCHAIN_FILE: keychain })
  })
  // The daemon reads its login environment through `$SHELL -lic 'env -0'`.
  // This stand-in answers with the daemon's own allowlisted environment,
  // written into it, and nothing of its caller's: `env -i` starts empty, so
  // run by hand from a real shell it still shows only these keys. A `-c`
  // command runs with /bin/sh on the same environment. Named zsh, a name the
  // daemon accepts as a login shell.
  const fixed = Object.entries(env)
    .map(([key, value]) => `${key}=${quoted(value)}`)
    .join(' ')
  script(shell, [
    '#!/bin/sh',
    'cmd=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -c) shift; cmd="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$cmd" in',
    `  ""|"env -0") exec /usr/bin/env -i ${fixed} /usr/bin/env -0 ;;`,
    `  *) exec /usr/bin/env -i ${fixed} /bin/sh -c "$cmd" ;;`,
    'esac'
  ])
  return { env, log, claude, codex, home }
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
  let keychain = null
  afterEach(() => {
    // `security delete-keychain` deletes the keychain file and takes it off the
    // search lists. Whether `create-keychain` put it on one depends on the
    // macOS release (on Darwin 25.6 it puts it on none), so the check below
    // holds one thing: afterwards, the user search list names nothing of this run.
    if (keychain) {
      try {
        execFileSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'ignore' })
      } catch {
        // Never created, or already gone.
      }
      // Matched by the run folder's unique name: the list may spell /var as /private/var.
      expect(searchList()).not.toContain(path.basename(root))
    }
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
    keychain = null
  })

  it(
    'under --no-titles the title module is off inside the daemon, the discovery file says so, and a one-shot would reach only the recorder',
    async () => {
      root = mkdtempSync(path.join(tmpdir(), 'clave-server-no-titles-'))
      const iso = isolation(root, (file) => (keychain = file))
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
        // The home is compared inside the daemon, which answers yes or no.
        const seen = await inside(
          server,
          `async () => {
            const os = await import('node:os')
            const fs = await import('node:fs')
            const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }
            const home = real(${JSON.stringify(iso.home)})
            const titles = globalThis.__claveE2E.titles
            const launch = await titles.launch()
            return {
              disabled: titles.disabled(),
              file: launch.file,
              codex: titles.locate('codex'),
              keys: Object.keys(process.env).sort(),
              home: home !== null && real(os.homedir()) === home && real(process.env.HOME ?? '') === home
            }
          }`
        )
        expect(seen.disabled).toBe('--no-titles')
        expect(realpathSync(seen.file)).toBe(realpathSync(iso.claude))
        expect(realpathSync(seen.codex)).toBe(realpathSync(iso.codex))
        expect(seen.home).toBe(true)
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
      const iso = isolation(root, (file) => (keychain = file))
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
