// Clave's own tools inside a Pi or an OpenCode tab (PRDCT-4507). Real hidden
// Electron, the real in-process tool server, and stand-in harnesses that call
// it with exactly what the tab was handed (tests/e2e/fixtures/
// clave-tools-call.mjs): a Pi chat (`pi --mode rpc`, the stand-in loads the
// extension on its command line as Pi does and calls the server it
// registers), a Pi terminal (the same, in the terminal form), an OpenCode
// chat (`opencode acp`, the stand-in reads `mcp.servers.clave` of the inline
// configuration and resolves its `{env:…}` header) and an OpenCode terminal
// (the TUI form, the same reading). Each calls `clave_list` and must be
// answered AS that tab: the server names the caller. The token is on no
// command line and, for Pi, in no variable at all. No provider is called.
// Pinned to the in-process server; tmux is off for the run.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('clave-tools-pi-opencode')
const ROOT = fixturePath('clave-tools-pi-opencode-root')
const BIN = path.join(ROOT, 'bin')
const LOG = path.join(ROOT, 'clave-tools.jsonl')
const PI_HOME = path.join(ROOT, 'pi-agent')
const PI_STATE = path.join(ROOT, 'pi-state')
const ACP_STATE = path.join(ROOT, 'acp-state')
const PI_AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const ACP_AGENT = path.join(REPO, 'tests/e2e/fixtures/acp-agent.mjs')
const CALL = path.join(REPO, 'tests/e2e/fixtures/clave-tools-call.mjs')
const WS = { id: 'tools-ws', name: 'Tools', rootDir: ROOT, profileFile: null, createdAt: 1 }

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(PI_HOME, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    path.join(BIN, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'pi'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.5.2"; exit 0; fi
case " $* " in
  *" --mode rpc "*)
    PI_STAND_IN_STATE=${quote(PI_STATE)}
    export PI_STAND_IN_STATE
    exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
    ;;
esac
PI_STAND_IN_TERMINAL=1
export PI_STAND_IN_TERMINAL
exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
`,
    { mode: 0o755 }
  )
  // OpenCode's TUI form: reads `mcp.servers.clave` of the inline
  // configuration the way 2.3.0 does, calls it, records its argv, waits.
  writeFileSync(
    path.join(BIN, 'opencode-tui.mjs'),
    `import { appendFileSync } from 'node:fs'
import { callClaveTools, opencodeSubstitute } from ${JSON.stringify(CALL)}
appendFileSync(${JSON.stringify(path.join(ROOT, 'opencode-tui-argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
let config = null
try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '') } catch {}
const inline = config?.mcp?.servers?.clave
const server = inline ? { url: inline.url, headers: Object.fromEntries(Object.entries(inline.headers ?? {}).map(([k, v]) => [k, opencodeSubstitute(v)])) } : null
await callClaveTools(server, { harness: 'opencode', form: 'terminal', codemode: inline?.codemode ?? null, standalone: process.argv.includes('--standalone') })
process.stdout.write('stub opencode terminal\\r\\n')
setInterval(() => {}, 60000)
`
  )
  writeFileSync(
    path.join(BIN, 'opencode'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.3.0"; exit 0; fi
if [ "$1" = "acp" ]; then
  ACP_STAND_IN_STATE=${quote(ACP_STATE)}
  export ACP_STAND_IN_STATE
  exec ${quote(process.execPath)} ${quote(ACP_AGENT)} acp
fi
exec ${quote(process.execPath)} ${quote(path.join(BIN, 'opencode-tui.mjs'))} "$@"
`,
    { mode: 0o755 }
  )
}

const records = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: path.join(BIN, 'bash'),
    PATH: `${BIN}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME,
    CLAVE_TOOLS_STAND_IN_LOG: LOG
  }
  let app = null
  const opened = []
  try {
    const launched = await launchApp(DIR, {
      server: 'in-process',
      args: ['--test-no-machine-usage'],
      env
    })
    app = launched.app
    const win = launched.win
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })

    /** Open one tab, start its process, and wait for its one record. */
    const openAndCall = async (label, payload, match) => {
      const before = records().length
      const result = await callMcp(app, 'openSession', { cwd: ROOT, name: label, ...payload })
      const id = result?.sessionId
      assert.ok(id, `${label}: the tab opened (${JSON.stringify(result)})`)
      opened.push(id)
      if (payload.chat)
        await win.evaluate((id) => window.electronAPI.sessionsModels(id), id).catch(() => undefined)
      const record = await until(() => records().slice(before).find(match) ?? null, {
        tries: 80
      })
      assert.ok(
        record,
        `${label}: the stand-in called Clave's tools (${JSON.stringify(records())})`
      )
      return { id, record }
    }

    const piChat = await openAndCall(
      'Pi chat',
      { mode: 'pi', chat: true },
      (r) => r.harness === 'pi' && r.form === 'rpc'
    )
    const piTerminal = await openAndCall(
      'Pi terminal',
      { mode: 'pi', chat: false },
      (r) => r.harness === 'pi' && r.form === 'terminal'
    )
    const opencodeChat = await openAndCall(
      'OpenCode chat',
      { mode: 'opencode', chat: true },
      (r) => r.harness === 'opencode' && r.form === 'acp'
    )
    const opencodeTerminal = await openAndCall(
      'OpenCode terminal',
      { mode: 'opencode', chat: false },
      (r) => r.harness === 'opencode' && r.form === 'terminal'
    )

    for (const { id, record } of [piChat, piTerminal, opencodeChat, opencodeTerminal]) {
      assert.equal(record.ok, true, `${record.harness} ${record.form}: ${record.error ?? ''}`)
      assert.equal(
        record.callerSessionId,
        id,
        `${record.harness} ${record.form} answered as itself`
      )
      assert.ok(record.tools.includes('clave_list'))
      assert.ok(record.tools.includes('clave_open_session'))
      assert.equal(record.tokenOnArgv, false)
    }
    for (const { record } of [piChat, piTerminal]) {
      assert.equal(record.extension, true)
      assert.equal(record.exposure, 'direct')
      assert.deepEqual(record.tokenInEnv, [])
    }
    for (const { record } of [opencodeChat, opencodeTerminal]) {
      assert.equal(record.codemode, false)
      assert.deepEqual(record.tokenInEnv, ['CLAVE_TAB_MCP_TOKEN'])
    }
    assert.equal(opencodeChat.record.source, 'inline')
    assert.equal(opencodeChat.record.configHoldsToken, false)
    assert.equal(opencodeTerminal.record.standalone, true)
    assert.equal(
      new Set([piChat, piTerminal, opencodeChat, opencodeTerminal].map((s) => s.id)).size,
      4
    )
    t.check('a Pi chat calls clave_list and is answered as itself', true)
    t.check('a Pi terminal calls clave_list and is answered as itself', true)
    t.check('an OpenCode chat calls clave_list and is answered as itself', true)
    t.check('an OpenCode terminal, standalone, calls clave_list and is answered as itself', true)
    t.check(
      'the token is on no command line, in no variable for Pi, and named by reference for OpenCode',
      true
    )
  } finally {
    for (const id of opened) await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
    await app?.close()
  }
}
