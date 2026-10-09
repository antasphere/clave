/**
 * The wire shape of a `.clave` file: a field the schema does not name is
 * dropped on the wire, silently (Effect Schema ignores excess properties), so
 * every field the renderer and the parser know is pinned here by name, and a
 * maximal result goes through encode, JSON and decode unchanged.
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { ClaveFileReadResult, ClaveGroup, ClaveSession, ClaveTerminal } from './model'

describe('the .clave wire shape', () => {
  it('names every field of the six-place mirror (CLAUDE.md)', () => {
    expect(Object.keys(ClaveGroup.fields).sort()).toEqual(
      [
        'category',
        'color',
        'cwd',
        'logo',
        'name',
        'prompt',
        'sessions',
        'terminals',
        'toolbar',
        'view'
      ].sort()
    )
    expect(Object.keys(ClaveSession.fields).sort()).toEqual(
      [
        'account',
        'antigravityMode',
        'claudeAgentsMode',
        'claudeMode',
        'codexMode',
        'cwd',
        'dangerousMode',
        'name',
        'piMode',
        'prompt',
        'rootSession'
      ].sort()
    )
    expect(Object.keys(ClaveTerminal.fields).sort()).toEqual(
      [
        'autoLaunchLocalhost',
        'color',
        'command',
        'commandMode',
        'cwd',
        'groupView',
        'icon',
        'persistent',
        'serverUrl'
      ].sort()
    )
  })

  it('carries a maximal result through encode, JSON and decode unchanged', () => {
    const result: typeof ClaveFileReadResult.Type = {
      type: 'multi',
      groups: [
        {
          name: 'G',
          cwd: '/w',
          color: 'teal',
          toolbar: true,
          category: 'Work',
          logo: 'data:image/png;base64,AQ==',
          prompt: 'brief',
          view: 'https://example.test',
          sessions: [
            {
              cwd: '/w/lib',
              name: 't',
              claudeMode: true,
              antigravityMode: false,
              codexMode: false,
              piMode: true,
              claudeAgentsMode: false,
              dangerousMode: true,
              prompt: 'S',
              rootSession: true,
              account: 'Work'
            }
          ],
          terminals: [
            {
              command: 'npm run dev',
              commandMode: 'auto',
              color: 'blue',
              icon: 'bolt',
              cwd: '/w/web',
              autoLaunchLocalhost: true,
              persistent: true,
              serverUrl: 'http://localhost:3000',
              groupView: true
            }
          ]
        }
      ]
    }
    const back = Schema.decodeUnknownSync(ClaveFileReadResult)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ClaveFileReadResult)(result)))
    )
    expect(back).toEqual(result)
  })
})
