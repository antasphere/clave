import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { buildClaudeHookSettingsArg, PtyBackend } from './pty-backend'

/**
 * A writing style in a terminal tab (PRDCT-5166): what the process is started
 * with, read off the spawn the terminal port receives, and what the tab's
 * record keeps. The manager resolves the style; the backend is handed its id
 * (`writingStyle`) and its text (`writingStyleText`).
 */

const STYLE = 'Answer first.\nSay "done" when `npm test` passes.'
let dir: string
let spawned: TerminalSpawn[]
let backend: PtyBackend
const cwd = fs.realpathSync(tempDataDir('clave-pty-style-cwd-'))

function terminals(): TerminalPort {
  return {
    spawn(spec) {
      spawned.push(spec)
      return {
        pid: 5166,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => () => {},
        onExit: () => () => {}
      }
    }
  }
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

const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
const styled = { writingStyle: 'dense', writingStyleText: STYLE }

process.env.SHELL = '/bin/sh'

beforeEach(() => {
  dir = tempDataDir()
  spawned = []
  installSettingsPorts(electronTestPorts(dir))
  installTerminalPorts({
    storage: fileStorage(dir),
    terminals: terminals(),
    mcpConfig: { write: vi.fn(() => null), remove: vi.fn() },
    resourcesDir: resourcesDirOfEntry(path.resolve(__dirname, '..', '..'))
  })
  backend = new PtyBackend()
})
afterEach(() => {
  resetTerminalPorts()
  resetSettingsPorts()
})

describe('the settings a Claude tab is started with', () => {
  it("resets the person's output style for a tab with a style, beside the hooks", () => {
    const settings = JSON.parse(buildClaudeHookSettingsArg('s1', { resetOutputStyle: true })!)
    expect(settings.outputStyle).toBe('default')
    expect(settings.hooks.Stop).toBeDefined()
  })

  it('leaves the output style alone without a style', () => {
    expect(JSON.parse(buildClaudeHookSettingsArg('s1')!)).not.toHaveProperty('outputStyle')
    expect(
      JSON.parse(buildClaudeHookSettingsArg('s1', { resetOutputStyle: false })!)
    ).not.toHaveProperty('outputStyle')
  })

  it('is the reset alone where there are no hooks (Windows), and nothing without a style', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      vi.resetModules()
      const fresh = await import('./pty-backend')
      expect(fresh.buildClaudeHookSettingsArg('s1', { resetOutputStyle: true })).toBe(
        '{"outputStyle":"default"}'
      )
      expect(fresh.buildClaudeHookSettingsArg('s1')).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.resetModules()
    }
  })
})

describe('a terminal tab with a style is started with it, its harness its own way', () => {
  it('claude: --append-system-prompt with the text, and the reset in --settings', () => {
    const { command } = start({ claudeMode: true, ...styled })
    expect(command).toContain(`'--append-system-prompt' ${quoted(STYLE)}`)
    const settings = /'--settings' '([^']+)'/.exec(command)![1]
    expect(JSON.parse(settings).outputStyle).toBe('default')
  })

  it("claude: a routine's own line first, then the style", () => {
    const { command } = start({
      claudeMode: true,
      appendSystemPrompt: 'You are a routine run.',
      ...styled
    })
    expect(command).toContain(
      `'--append-system-prompt' ${quoted(`You are a routine run.\n\n${STYLE}`)}`
    )
  })

  it('pi: --append-system-prompt with the text', () => {
    const { command } = start({ piMode: true, ...styled })
    expect(command).toContain(`'--append-system-prompt' ${quoted(STYLE)}`)
  })

  it('codex: developer_instructions, before the resumed thread', () => {
    const thread = '0b7d4c1e-5f6a-4b3c-8d2e-1f0a9b8c7d6e'
    const { command } = start({ codexMode: true, resumeSessionId: thread, ...styled })
    expect(command).toContain(
      `'-c' ${quoted(`developer_instructions=${JSON.stringify(STYLE)}`)} '${thread}'`
    )
  })

  it('opencode: an instruction file named in its inline configuration, the TUI standalone', () => {
    const { spec, command } = start({ opencodeMode: true, ...styled })
    const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(config.instructions).toHaveLength(1)
    const file = config.instructions[0] as string
    expect(file.startsWith(path.join(dir, 'writing-styles', 'applied'))).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(STYLE)
    expect(command).toContain("'--standalone'")
    // On the key's road: past the login profile under a private name.
    expect(command).toMatch(/OPENCODE_CONFIG_CONTENT="\$CLAVE_TAB_CREDENTIAL_\d"/)
    expect(command).not.toContain(STYLE)
  })

  it("opencode: a connection's configuration kept, the file added to its own instructions", () => {
    const own = { model: 'opencode/big-pickle', instructions: ['/their/rules.md'] }
    const { spec } = start({
      opencodeMode: true,
      opencodeStandalone: true,
      providerEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(own) },
      ...styled
    })
    const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(config.model).toBe('opencode/big-pickle')
    expect(config.instructions[0]).toBe('/their/rules.md')
    expect(config.instructions).toHaveLength(2)
  })

  it('antigravity: nothing, and the record names no style', () => {
    const { id, command } = start({ antigravityMode: true, ...styled })
    expect(command).not.toContain('Answer first')
    expect(backend.getSessionRecord(id)?.writingStyle).toBeUndefined()
  })
})

describe("a terminal tab's record keeps its style", () => {
  it('names the style applied', () => {
    const { id } = start({ claudeMode: true, ...styled })
    expect(backend.getSessionRecord(id)?.writingStyle).toBe('dense')
  })

  it('names none for a tab without one, and none for an id with no text applied', () => {
    const bare = start({ claudeMode: true })
    expect(backend.getSessionRecord(bare.id)?.writingStyle).toBeUndefined()
    expect(bare.command).not.toContain('--append-system-prompt')
    expect(JSON.parse(/'--settings' '([^']+)'/.exec(bare.command)![1])).not.toHaveProperty(
      'outputStyle'
    )
    const named = start({ claudeMode: true, writingStyle: 'dense' })
    expect(backend.getSessionRecord(named.id)?.writingStyle).toBeUndefined()
  })

  it('names none for a plain terminal', () => {
    const { id } = start({ claudeMode: false, ...styled })
    expect(backend.getSessionRecord(id)?.writingStyle).toBeUndefined()
  })
})

// The spawn's answer says the style applied (PRDCT-5166): the window's
// `clave_list` reads it off the tab, so it must agree with the record.
describe("a terminal tab's spawn answers the style applied", () => {
  it('names the style the agent was given', () => {
    const session = backend.spawn(cwd, { tmuxMode: false, claudeMode: true, ...styled })
    expect(session.writingStyle).toBe('dense')
    expect(backend.getSessionRecord(session.id)?.writingStyle).toBe('dense')
  })

  it('names none for a tab on none, an id with no text, Antigravity or a plain terminal', () => {
    expect(backend.spawn(cwd, { tmuxMode: false, claudeMode: true })).not.toHaveProperty(
      'writingStyle'
    )
    expect(
      backend.spawn(cwd, { tmuxMode: false, claudeMode: true, writingStyle: 'dense' })
    ).not.toHaveProperty('writingStyle')
    expect(
      backend.spawn(cwd, { tmuxMode: false, antigravityMode: true, ...styled })
    ).not.toHaveProperty('writingStyle')
    expect(
      backend.spawn(cwd, { tmuxMode: false, claudeMode: false, ...styled })
    ).not.toHaveProperty('writingStyle')
  })
})
