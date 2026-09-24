import { describe, expect, it, vi } from 'vitest'

// The module reaches for Electron, node-pty (through pty-manager) and the
// history store at import; none of them is needed to read the CLI arguments.
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('./pty-manager', () => ({ getLoginShellEnv: () => ({}) }))
vi.mock('./session-history', () => ({ TITLE_HELPER_MARKER: 'title-helper' }))

import { TITLE_CLI_ARGS } from './title-generator'

describe('title generation CLI arguments', () => {
  it('asks Haiku for one turn with no MCP server, skill or tool', () => {
    expect(TITLE_CLI_ARGS.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(TITLE_CLI_ARGS).toContain('--strict-mcp-config')
    const config = TITLE_CLI_ARGS[TITLE_CLI_ARGS.indexOf('--mcp-config') + 1]
    expect(JSON.parse(config)).toEqual({ mcpServers: {} })
    expect(TITLE_CLI_ARGS).toContain('--disable-slash-commands')
    expect(TITLE_CLI_ARGS[TITLE_CLI_ARGS.indexOf('--tools') + 1]).toBe('')
  })

  it('keeps the user settings in force and the prompt off the command line', () => {
    // `--setting-sources ''` would drop an auth helper; a positional prompt
    // would be swallowed by the variadic `--tools`.
    expect(TITLE_CLI_ARGS).not.toContain('--setting-sources')
    expect(TITLE_CLI_ARGS.at(-1)).toBe('')
    expect(TITLE_CLI_ARGS.at(-2)).toBe('--tools')
  })
})
