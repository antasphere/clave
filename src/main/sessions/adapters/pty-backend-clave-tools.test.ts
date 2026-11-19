import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { installSettingsPorts, resetSettingsPorts } from '../../ports/registry'
import {
  installTerminalPorts,
  resetTerminalPorts,
  resourcesDirOfEntry
} from '../../ports/terminals'
import { fileStorage } from '../../ports/storage'
import type { TerminalPort, TerminalSpawn } from '../../ports/terminal'
import { electronTestPorts, tempDataDir } from '../../ports/testing'
import { PtyBackend, TMUX_SESSION_ENV_VARS } from './pty-backend'
import { CLAVE_TAB_CREDENTIAL_ENV_VARS } from '../../connection-handover'

/**
 * Clave's own tools in a Pi or an OpenCode terminal (PRDCT-4507). The tab's
 * credential is the MCP config port's file, the one a Claude tab gets: Pi is
 * told its PATH, OpenCode its address in the inline configuration and the
 * token under a variable of its own. The token is never on a command line.
 */

const TOKEN = 'made-up-tab-token-4507'
const URL = 'http://127.0.0.1:47999/mcp'

let dir: string
let spawned: TerminalSpawn[]
let mcpConfig: { write: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
let backend: PtyBackend
const cwd = fs.realpathSync(tempDataDir('clave-pty-tools-cwd-'))

function terminals(): TerminalPort {
  return {
    spawn(spec) {
      spawned.push(spec)
      return {
        pid: 4507,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => () => {},
        onExit: () => () => {}
      }
    }
  }
}

/** The issuer's file, as it writes it: mode 0600, the token in a header. */
function issue(id: string): string {
  const file = path.join(dir, 'mcp-configs', `${id}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        clave: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } }
      }
    }),
    { mode: 0o600 }
  )
  return file
}

function start(options: Parameters<PtyBackend['spawn']>[1]): {
  id: string
  spec: TerminalSpawn
  command: string
} {
  const session = backend.spawn(cwd, { tmuxMode: false, ...options })
  backend.start(session.id, 80, 24)
  const spec = spawned[spawned.length - 1]
  return { id: session.id, spec, command: spec.args.join(' ') }
}

/** The token is in no argument, and in the environment only under the
 *  names given (its own variable and a private handover name). */
function tokenOnlyUnder(spec: TerminalSpawn, names: string[]): void {
  for (const arg of spec.args) expect(arg).not.toContain(TOKEN)
  const holders = Object.entries(spec.env ?? {})
    .filter(([, value]) => typeof value === 'string' && value.includes(TOKEN))
    .map(([name]) => name)
    .sort()
  expect(holders).toEqual([...names].sort())
}

const config = (spec: TerminalSpawn): Record<string, unknown> =>
  JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>

process.env.SHELL = '/bin/sh'

beforeEach(() => {
  dir = tempDataDir()
  spawned = []
  installSettingsPorts(electronTestPorts(dir))
  mcpConfig = { write: vi.fn((id: string) => issue(id)), remove: vi.fn() }
  installTerminalPorts({
    storage: fileStorage(dir),
    terminals: terminals(),
    mcpConfig,
    resourcesDir: resourcesDirOfEntry(path.resolve(__dirname, '..', '..'))
  })
  backend = new PtyBackend()
})
afterEach(() => {
  resetTerminalPorts()
  resetSettingsPorts()
})

describe("a Pi terminal is handed Clave's tools (PRDCT-4507)", () => {
  it("asks the one issuer for the tab's file and names its PATH beside the state file, never its token", () => {
    const { id, spec, command } = start({ piMode: true })
    expect(mcpConfig.write).toHaveBeenCalledExactlyOnceWith(id)
    const file = path.join(dir, 'mcp-configs', `${id}.json`)
    expect(command).toContain(`CLAVE_MCP_CONFIG_FILE='${file}'`)
    expect(command).toMatch(/'--extension' '[^']+pi-clave-state\.js'/)
    tokenOnlyUnder(spec, [])
  })

  it('starts without tools when no tool server is up, never refused', () => {
    mcpConfig.write.mockReturnValue(null)
    const { command } = start({ piMode: true })
    expect(command).not.toContain('CLAVE_MCP_CONFIG_FILE')
    expect(command).toContain("'--extension'")
  })

  it('lets go of the credential on a real close, and keeps it on a quit', () => {
    const closed = start({ piMode: true })
    backend.kill(closed.id)
    expect(mcpConfig.remove).toHaveBeenCalledExactlyOnceWith(closed.id)
    const kept = start({ piMode: true })
    backend.kill(kept.id, false)
    expect(mcpConfig.remove).toHaveBeenCalledTimes(1)
  })
})

describe("an OpenCode terminal is handed Clave's tools (PRDCT-4507)", () => {
  const clave = {
    type: 'remote',
    url: URL,
    headers: { Authorization: 'Bearer {env:CLAVE_TAB_MCP_TOKEN}' },
    oauth: false
  }

  it('on no connection and no model: its own inline configuration, standalone, the token by reference', () => {
    const { id, spec, command } = start({ opencodeMode: true })
    expect(mcpConfig.write).toHaveBeenCalledExactlyOnceWith(id)
    expect(config(spec)).toEqual({ mcp: { servers: { clave } } })
    expect(spec.env?.CLAVE_TAB_MCP_TOKEN).toBe(TOKEN)
    expect(command).toContain("'--standalone'")
    // The key's road: past the login profile under a private name.
    expect(command).toMatch(
      /CLAVE_TAB_MCP_TOKEN="\$CLAVE_TAB_CREDENTIAL_\d"; export CLAVE_TAB_MCP_TOKEN; unset CLAVE_TAB_CREDENTIAL_\d; /
    )
    const privateName = /CLAVE_TAB_MCP_TOKEN="\$(CLAVE_TAB_CREDENTIAL_\d)"/.exec(command)![1]
    tokenOnlyUnder(spec, ['CLAVE_TAB_MCP_TOKEN', privateName])
  })

  it("on a connection: the connection's configuration and key kept as they are, Clave's server beside", () => {
    const own = {
      providers: { 'kimi-code-plan-global': { settings: { apiKey: '{env:KIMI_API_KEY}' } } },
      enabled_providers: ['kimi-code-plan-global'],
      model: 'kimi-code-plan-global/k3'
    }
    const { spec, command } = start({
      opencodeMode: true,
      opencodeStandalone: true,
      providerEnv: { KIMI_API_KEY: 'made-up-kimi', OPENCODE_CONFIG_CONTENT: JSON.stringify(own) }
    })
    expect(config(spec)).toEqual({ ...own, mcp: { servers: { clave } } })
    expect(spec.env?.KIMI_API_KEY).toBe('made-up-kimi')
    expect(command).toContain("'--standalone'")
    expect(command).not.toContain("'--standalone' '--standalone'")
    expect(command).not.toContain('made-up-kimi')
    // Three values carried: the key, the configuration, the token.
    for (const name of CLAVE_TAB_CREDENTIAL_ENV_VARS.slice(0, 3))
      expect(spec.env?.[name]).toBeDefined()
  })

  it('with a model alone: the model kept, the server added', () => {
    const { spec } = start({
      opencodeMode: true,
      opencodeStandalone: true,
      providerEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'opencode/big-pickle' }) }
    })
    expect(config(spec)).toEqual({ model: 'opencode/big-pickle', mcp: { servers: { clave } } })
  })

  it('runs standalone even with no tool server up, and then carries nothing of Clave', () => {
    mcpConfig.write.mockReturnValue(null)
    const { spec, command } = start({ opencodeMode: true })
    expect(command).toContain("'--standalone'")
    expect(spec.env?.CLAVE_TAB_MCP_TOKEN).toBeUndefined()
    expect(spec.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('lets go of the credential on a real close', () => {
    const closed = start({ opencodeMode: true })
    backend.kill(closed.id)
    expect(mcpConfig.remove).toHaveBeenCalledExactlyOnceWith(closed.id)
  })

  it('the token variable crosses into a tmux session, with a spare private name left', () => {
    expect(TMUX_SESSION_ENV_VARS).toContain('CLAVE_TAB_MCP_TOKEN')
    expect(TMUX_SESSION_ENV_VARS).toEqual(
      expect.arrayContaining([...CLAVE_TAB_CREDENTIAL_ENV_VARS])
    )
    expect(CLAVE_TAB_CREDENTIAL_ENV_VARS).toHaveLength(4)
  })
})

describe('a Pi terminal on a connection is watched by name (PRDCT-4540)', () => {
  it("tells the extension the provider, the key's variable and the report file: names only", () => {
    const { id, spec, command } = start({
      piMode: true,
      model: 'k-first',
      piProvider: 'kimi-coding',
      connectionId: 'conn-1',
      connectionLabel: 'Kimi',
      providerEnv: {
        KIMI_API_KEY: 'made-up-kimi-4540',
        PI_CODING_AGENT_DIR: path.join(dir, 'pi-c')
      }
    })
    expect(command).toContain("CLAVE_CONNECTION_PROVIDER='kimi-coding'")
    expect(command).toContain("CLAVE_CONNECTION_KEY_VAR='KIMI_API_KEY'")
    expect(command).toContain(
      `CLAVE_CONNECTION_REPORT_FILE='${path.join(dir, 'agent-state', `${id}.connection`)}'`
    )
    expect(command).not.toContain('made-up-kimi-4540')
    expect(spec.env?.CLAVE_CONNECTION_KEY_VAR).toBeUndefined()
  })

  it('a Pi terminal on no connection is told nothing', () => {
    const { command } = start({ piMode: true })
    expect(command).not.toContain('CLAVE_CONNECTION_')
  })
})

// Issue #423, verifier V14: a Claude terminal given an effort (a routine's own)
// unsets CLAUDE_CODE_EFFORT_LEVEL after the login profile, which may export
// it and which Claude would prefer to --effort; one given none keeps it.
describe('a Claude terminal given an effort runs at it (#423, verifier V14)', () => {
  it('unsets the effort variable before the agent when it passes an effort', () => {
    const { command } = start({ claudeMode: true, effort: 'max' })
    expect(command).toContain('unset CLAUDE_CODE_EFFORT_LEVEL; ')
    expect(command).toContain("'--effort' 'max'")
  })
  it('leaves it to the person when it passes none', () => {
    const { command } = start({ claudeMode: true })
    expect(command).not.toContain('CLAUDE_CODE_EFFORT_LEVEL')
  })
})
