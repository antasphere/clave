/**
 * The card an agent puts to the person names the harness (PRDCT-4507): in
 * a Pi chat it read "PI ASKS", in an OpenCode chat "THE AGENT ASKS", from a
 * private map that knew Claude, Codex and Pi alone. The name now comes from
 * the harness table (`agentNameOf`) for every harness, in the chat, the
 * terminal and the folio views alike.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// The stores the card's module reaches read the browser's storage at import.
vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  const noop = (): void => undefined
  Object.assign(globalThis, {
    localStorage,
    window: { localStorage, addEventListener: noop, removeEventListener: noop, electronAPI: {} },
    document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' }
  })
})
import { renderToStaticMarkup } from 'react-dom/server'
import { HARNESSES, agentNameOf } from '../../../src/shared/harness'
import { InputPrompt } from './InputPrompt'
import { PromptDock } from './PromptDock'

const request = {
  type: 'permission_request' as const,
  id: 'r1',
  description: 'A question',
  options: [],
  questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }]
}

const eyebrow = (agent: string): string | undefined =>
  /<span class="chat-prompt-eyebrow">([^<]*)<\/span>/.exec(
    renderToStaticMarkup(
      createElement(InputPrompt, {
        request,
        busy: false,
        agent,
        remote: false,
        onAnswer: () => {}
      })
    )
  )?.[1]

describe('the card a harness asks with names it (PRDCT-4507)', () => {
  it("says each harness by its agent's name in the table, Claude's words kept", () => {
    expect(HARNESSES.map((h) => eyebrow(agentNameOf(h.id)))).toEqual([
      'Claude asks',
      'Codex asks',
      'Antigravity asks',
      'Pi asks',
      'OpenCode asks'
    ])
    for (const harness of HARNESSES)
      expect(eyebrow(agentNameOf(harness.id))).toBe(`${harness.agentName} asks`)
    expect(agentNameOf('claude-agents')).toBe(agentNameOf('claude'))
    expect(agentNameOf('gemini')).toBe(agentNameOf('antigravity'))
    expect(agentNameOf('echo')).toBe('the agent')
    expect(agentNameOf(undefined, 'The agent')).toBe('The agent')
  })

  // A Claude permission card reads as it did on dev.
  it('a Claude permission card still asks "Allow Claude to …?"', () => {
    const html = renderToStaticMarkup(
      createElement(PromptDock, {
        requests: [
          {
            type: 'permission_request',
            id: 'p1',
            description: 'Write notes.txt',
            options: [{ id: 'allow', label: 'Allow' }],
            toolName: 'Write',
            input: { file_path: '/repo/notes.txt', content: 'x' }
          }
        ],
        agent: agentNameOf('claude'),
        busy: () => false,
        onAnswer: () => {}
      })
    )
    expect(html).toContain('Allow Claude to write notes.txt?')
  })

  it('every view takes the name from the table, none from a map of its own', () => {
    for (const file of ['ChatView.tsx', 'TerminalView.tsx', 'lab/FolioView.tsx']) {
      const source = readFileSync(path.join(__dirname, file), 'utf8')
      expect(source, file).not.toMatch(/AGENT_NAMES/)
      expect(source, file).toMatch(/agentNameOf\(session\.provider/)
    }
  })
})
