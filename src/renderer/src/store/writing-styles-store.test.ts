import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILT_IN_STYLES,
  type WritingStyle,
  type WritingStylesView
} from '../../../shared/writing-styles'
import { HARNESS_BY_ID, HARNESSES } from '../../../shared/harness'

// The Settings page's store of the writing styles (PRDCT-5166): every read
// and write goes to the machine the page names, a refusal comes back as the
// machine's sentence, and what the page derives from the seam's table.

let store: typeof import('./writing-styles-store')

const mine: WritingStyle = {
  id: 'plain',
  name: 'Plain',
  description: 'Plainly.',
  text: 'Write plainly.',
  statusCard: true,
  builtIn: false
}
const view = (over: Partial<WritingStylesView> = {}): WritingStylesView => ({
  styles: [...BUILT_IN_STYLES, mine],
  defaultStyleId: null,
  claudeOutputStyle: null,
  ...over
})

const api = {
  fleetWritingStyles: vi.fn(),
  fleetWritingStyleSave: vi.fn(),
  fleetWritingStyleDelete: vi.fn(),
  fleetWritingStyleSetDefault: vi.fn(),
  fleetWritingStyleImportClaude: vi.fn()
}

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  store = await import('./writing-styles-store')
})
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  store.useWritingStylesStore.setState({ byMachine: {} })
})

describe('the machine the page names', () => {
  it('reads and writes that machine, and keeps its answer under it alone', async () => {
    api.fleetWritingStyles.mockResolvedValue(view())
    await store.loadWritingStyles('server-b')
    expect(api.fleetWritingStyles).toHaveBeenCalledWith('server-b')
    api.fleetWritingStyleSetDefault.mockResolvedValue(view({ defaultStyleId: 'plain' }))
    expect(await store.setDefaultWritingStyle('server-b', 'plain')).toBeNull()
    expect(api.fleetWritingStyleSetDefault).toHaveBeenCalledWith('server-b', 'plain')
    const draft = store.duplicateDraft(mine)
    api.fleetWritingStyleSave.mockResolvedValue(view({ defaultStyleId: 'plain' }))
    expect(await store.saveWritingStyle('server-b', draft)).toBeNull()
    expect(api.fleetWritingStyleSave).toHaveBeenCalledWith('server-b', draft)
    api.fleetWritingStyleDelete.mockResolvedValue(view())
    await store.deleteWritingStyle('server-b', 'plain')
    expect(api.fleetWritingStyleDelete).toHaveBeenCalledWith('server-b', 'plain')
    api.fleetWritingStyleImportClaude.mockResolvedValue(view())
    await store.importClaudeOutputStyle('server-b')
    expect(api.fleetWritingStyleImportClaude).toHaveBeenCalledWith('server-b')
    const { byMachine } = store.useWritingStylesStore.getState()
    expect(Object.keys(byMachine)).toEqual(['server-b'])
    expect(byMachine['server-b']).toMatchObject({ status: 'ready', error: null })
    expect(byMachine['server-b'].view?.defaultStyleId).toBeNull()
  })

  it('a refused write keeps the view and answers the machine’s sentence', async () => {
    api.fleetWritingStyles.mockResolvedValue(view())
    await store.loadWritingStyles('local')
    api.fleetWritingStyleSave.mockRejectedValue(
      new Error(
        'Error invoking remote method \'writing-styles:save\': Error: Another style is already named "Brief".'
      )
    )
    expect(await store.saveWritingStyle('local', { ...store.EMPTY_DRAFT, name: 'brief' })).toBe(
      'Another style is already named "Brief".'
    )
    // The server's road throws the tagged refusal with the sentence alone.
    api.fleetWritingStyleDelete.mockRejectedValue(
      new Error('The built-in styles cannot be deleted.')
    )
    expect(await store.deleteWritingStyle('local', 'brief')).toBe(
      'The built-in styles cannot be deleted.'
    )
    expect(store.useWritingStylesStore.getState().byMachine.local.view).toEqual(view())
    api.fleetWritingStyleSetDefault.mockRejectedValue(new Error('socket closed: token=secret'))
    const failed = await store.setDefaultWritingStyle('local', null)
    expect(failed).toBe('The change did not reach the machine.')
  })

  it('a failed read says so, and an older server says the update it needs', async () => {
    api.fleetWritingStyles.mockRejectedValue(
      new Error(
        'Error invoking remote method: Error: This server needs an update to show its writing styles.'
      )
    )
    await store.loadWritingStyles('server-old')
    expect(store.useWritingStylesStore.getState().byMachine['server-old']).toMatchObject({
      status: 'error',
      error: 'This server needs an update to show its writing styles.'
    })
    api.fleetWritingStyles.mockRejectedValue(new Error('socket closed: token=secret'))
    await store.loadWritingStyles('server-c')
    const failed = store.useWritingStylesStore.getState().byMachine['server-c']
    expect(failed.status).toBe('error')
    expect(failed.error).toBe('The writing styles could not be read from this machine.')
  })
})

describe('what the page offers', () => {
  it('duplicates a style as a draft with no id, named as a copy', () => {
    expect(store.duplicateDraft(BUILT_IN_STYLES[0])).toEqual({
      name: 'Brief copy',
      description: BUILT_IN_STYLES[0].description,
      text: BUILT_IN_STYLES[0].text,
      statusCard: true
    })
    expect(store.draftOf(mine)).toEqual({
      id: 'plain',
      name: 'Plain',
      description: 'Plainly.',
      text: 'Write plainly.',
      statusCard: true
    })
  })

  it('says what each harness takes, from the table: once when both agree, both when not', () => {
    expect(store.styleSupportLine(HARNESS_BY_ID.claude)).toBe(
      'Claude Code: in its instructions, in a chat and in a terminal.'
    )
    expect(store.styleSupportLine(HARNESS_BY_ID.antigravity)).toBe(
      `${HARNESS_BY_ID.antigravity.name}: with the first message in a chat; not taken in a terminal.`
    )
    for (const harness of HARNESSES) expect(store.styleSupportLine(harness)).toMatch(/\.$/)
  })
})
