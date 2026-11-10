import { describe, expect, it } from 'vitest'
import {
  emptyConversation,
  reduceConversation,
  type Action,
  type ChatEvent,
  type Conversation
} from '../../../../plugins/chat-view/src/reducer'

/* PRDCT-4331 in the conversation: the host's reading of each permission
   request is kept by its id, from the stream and from the past alike, and
   every CHANGE of permission mode is one line of the transcript. */

const MODES = [
  { id: 'default', label: 'Manual' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'bypassPermissions', label: 'Bypass permissions' }
]
const mode = (id: string): ChatEvent => ({ type: 'permission_mode', mode: id, modes: MODES })
const apply = (state: Conversation, ...actions: Action[]): Conversation =>
  actions.reduce(reduceConversation, state)
const events = (...list: ChatEvent[]): Action[] => list.map((event) => ({ event, at: 1 }))
const modeLines = (state: Conversation): Conversation['entries'] =>
  state.entries.filter((e) => e.kind === 'mode')

describe('the mode line', () => {
  it('says nothing for the first word on the mode, nor for a repeat', () => {
    const state = apply(
      emptyConversation,
      ...events(mode('bypassPermissions'), mode('bypassPermissions'))
    )
    expect(modeLines(state)).toEqual([])
    expect(state.permissionMode?.mode).toBe('bypassPermissions')
  })

  it('says one line per change, with the labels', () => {
    const state = apply(
      emptyConversation,
      ...events(mode('bypassPermissions'), mode('default'), mode('default'), mode('acceptEdits'))
    )
    expect(modeLines(state)).toEqual([
      {
        kind: 'mode',
        mode: 'default',
        label: 'Manual',
        from: 'bypassPermissions',
        fromLabel: 'Bypass permissions',
        at: 1
      },
      {
        kind: 'mode',
        mode: 'acceptEdits',
        label: 'Accept edits',
        from: 'default',
        fromLabel: 'Manual',
        at: 1
      }
    ])
  })

  it('says one line for a switch this view asked, which comes back twice, and who asked', () => {
    const state = apply(
      emptyConversation,
      ...events(mode('default')),
      { askMode: 'bypassPermissions' },
      ...events(mode('bypassPermissions'), mode('bypassPermissions'))
    )
    expect(modeLines(state)).toHaveLength(1)
    expect(modeLines(state)[0]).toMatchObject({ mode: 'bypassPermissions', by: 'you' })
    expect(state.askedMode).toBeUndefined()
  })

  it('does not credit the view with a change it did not ask', () => {
    const state = apply(
      emptyConversation,
      ...events(mode('default')),
      { askMode: 'acceptEdits' },
      ...events(mode('bypassPermissions'))
    )
    expect(modeLines(state)[0]).not.toHaveProperty('by')
    expect(state.askedMode).toBe('acceptEdits')
  })

  it('replays the past from no mode: no line for its first word, the lines it holds', () => {
    const live = apply(emptyConversation, ...events(mode('acceptEdits')))
    const synced = reduceConversation(live, {
      sync: [
        { event: mode('bypassPermissions'), at: 1 },
        { event: mode('default'), at: 2 }
      ]
    })
    expect(modeLines(synced)).toHaveLength(1)
    expect(modeLines(synced)[0]).toMatchObject({ from: 'bypassPermissions', mode: 'default' })
  })
})

describe('the host reading of a request', () => {
  const reading: ChatEvent = {
    type: 'permission_explained',
    id: 'r1',
    level: 'irreversible',
    sentence: 'Deletes the build folder for good.',
    asked: 'yes'
  }
  it('is kept by the request id, whenever it arrives', () => {
    const before = apply(emptyConversation, ...events(reading))
    expect(before.explained.r1).toEqual(reading)
    const after = apply(
      emptyConversation,
      ...events(
        {
          type: 'permission_request',
          id: 'r1',
          description: 'Allow Bash?',
          toolName: 'Bash',
          input: { command: 'rm -rf build' },
          options: []
        },
        reading
      )
    )
    expect(after.explained.r1).toEqual(reading)
    expect(after.entries.filter((e) => e.kind === 'permission')).toHaveLength(1)
  })

  it('survives a page of the past put in front, and the past rebuilding the entries', () => {
    const live = apply(emptyConversation, ...events(reading))
    const paged = reduceConversation(live, {
      prepend: [
        { event: { type: 'permission_explained', id: 'old', level: 'reads', sentence: 'Old.' } }
      ]
    })
    expect(Object.keys(paged.explained).sort()).toEqual(['old', 'r1'])
    const synced = reduceConversation(live, { sync: [{ event: { type: 'turn_interrupted' } }] })
    expect(synced.explained.r1).toEqual(reading)
  })
})
