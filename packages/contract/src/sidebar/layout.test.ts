import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import type {
  GroupTerminalConfig,
  GroupViewConfig,
  SessionGroup
} from '../../../../src/renderer/src/store/session-types'
import {
  type GroupTerminal,
  type GroupView,
  LayoutSnapshot,
  SaveWindowLayout,
  type SidebarGroup,
  WindowKey
} from './layout'
import { normalizeLayout } from './ops'

/**
 * The renderer's group types (`session-types.ts`, the first of the six
 * `.clave` mirrors) and this contract's schemas describe the same objects.
 * The checks below are TYPE-level: a field added to one side and not the
 * other stops compiling here, which is the whole point. The renderer's
 * closed icon and colour unions widen to `string` on the wire, deliberately:
 * the wire carries what the file carries, and the renderer's fallbacks
 * (an unknown icon draws the default) decide what to do with a stranger. So
 * every renderer group is a wire group, and the two key sets are the same,
 * nested types included; the reverse assignment is not expected to hold.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }

const groupShape: Same<keyof SessionGroup, keyof SidebarGroup> = true
const terminalShape: Same<keyof GroupTerminalConfig, keyof GroupTerminal> = true
const viewShape: Same<keyof GroupViewConfig, keyof GroupView> = true
const rendererIsWire: SessionGroup extends Mutable<SidebarGroup> ? true : false = true

describe('the sidebar contract', () => {
  it('holds the renderer group types and the wire schemas together', () => {
    expect([groupShape, terminalShape, viewShape, rendererIsWire]).toEqual([true, true, true, true])
  })

  it('accepts a window key of the minted alphabet and nothing that could name a path', () => {
    const decode = Schema.decodeUnknownEither(WindowKey)
    expect(Either.isRight(decode('8f3b2c1d-aaaa-4bbb-8ccc-0123456789ab'))).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a.json', 'x'.repeat(129), 'é']) {
      expect(Either.isRight(decode(bad)), bad).toBe(false)
    }
  })

  it('decodes a whole save with its base revision and a snapshot back', () => {
    const payload = {
      windowKey: 'w1',
      baseRevision: 3,
      groups: [
        {
          id: 'g1',
          name: 'Lanes',
          sessionIds: ['s1'],
          collapsed: false,
          cwd: null,
          terminals: [
            {
              id: 't1',
              command: 'npm run dev',
              commandMode: 'auto',
              color: 'blue',
              sessionId: null
            }
          ],
          view: { url: 'http://127.0.0.1:4793', terminalId: 't1' }
        }
      ],
      displayOrder: ['g1', 's2']
    }
    const decoded = Schema.decodeUnknownSync(SaveWindowLayout.payload)(payload)
    expect(decoded.groups[0].terminals[0].commandMode).toBe('auto')
    const snapshot = Schema.decodeUnknownSync(LayoutSnapshot)({
      windowKey: 'w1',
      revision: 4,
      groups: payload.groups,
      displayOrder: payload.displayOrder
    })
    expect(snapshot.revision).toBe(4)
    expect(() => Schema.decodeUnknownSync(LayoutSnapshot)({ ...snapshot, revision: -1 })).toThrow()
  })
})

describe('normalizeLayout', () => {
  it('brings a file of any older release to the declared shape without losing a group', () => {
    const layout = normalizeLayout({
      groups: [
        { id: 'g1', name: 'A' },
        { id: 'g2', name: 'B', sessionIds: ['s1', 7], terminals: [{ id: 't', command: 'x' }] },
        { name: 'no id' },
        { id: 'g1', name: 'duplicate' },
        'junk'
      ],
      displayOrder: ['g1', 's1', 'g1', 4]
    })
    expect(layout.groups.map((g) => g.id)).toEqual(['g1', 'g2'])
    expect(layout.groups[0]).toEqual({
      id: 'g1',
      name: 'A',
      sessionIds: [],
      collapsed: false,
      cwd: null,
      terminals: []
    })
    expect(layout.groups[1].sessionIds).toEqual(['s1'])
    expect(layout.groups[1].terminals).toEqual([
      { id: 't', command: 'x', commandMode: 'prefill', color: 'black', sessionId: null }
    ])
    expect(layout.displayOrder).toEqual(['g1', 's1'])
  })

  it('keeps every optional field a group may carry', () => {
    const group = {
      id: 'g',
      name: 'N',
      sessionIds: [],
      collapsed: true,
      cwd: '/w',
      terminals: [],
      prompt: null,
      rootSession: true,
      color: 'teal',
      view: { url: 'u', title: 't', terminalId: null },
      workspaceId: 'ws'
    }
    expect(normalizeLayout({ groups: [group], displayOrder: [] }).groups[0]).toEqual(group)
  })

  it('answers an empty layout for nothing, null and nonsense', () => {
    for (const input of [undefined, null, 42, [], { groups: 'no' }]) {
      expect(normalizeLayout(input)).toEqual({ groups: [], displayOrder: [] })
    }
  })
})
