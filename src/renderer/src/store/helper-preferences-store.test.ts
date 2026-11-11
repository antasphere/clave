import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelperPreference } from '../../../shared/helper-preferences'

// The Settings page's store of the helpers (PRDCT-4330): every read and
// write goes to the machine the page names, and what the rows offer.

let store: typeof import('./helper-preferences-store')

const helper = (over: Partial<HelperPreference> = {}): HelperPreference => ({
  id: 'tab-title',
  label: 'Tab titles',
  enabled: true,
  model: 'haiku',
  defaultModel: 'haiku',
  account: { kind: 'session' },
  ...over
})

const api = { fleetHelpers: vi.fn(), fleetHelperSet: vi.fn() }

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  store = await import('./helper-preferences-store')
})
beforeEach(() => {
  api.fleetHelpers.mockReset()
  api.fleetHelperSet.mockReset()
  store.useHelperPreferencesStore.setState({ byMachine: {} })
})

describe('the machine the page names', () => {
  it('reads and writes that machine, and keeps its answer under it alone', async () => {
    api.fleetHelpers.mockResolvedValue([helper()])
    await store.loadHelperPreferences('server-b')
    expect(api.fleetHelpers).toHaveBeenCalledWith('server-b')
    api.fleetHelperSet.mockResolvedValue([helper({ enabled: false })])
    await store.setHelperPreference('server-b', 'tab-title', { enabled: false })
    expect(api.fleetHelperSet).toHaveBeenCalledWith('server-b', 'tab-title', { enabled: false })
    const { byMachine } = store.useHelperPreferencesStore.getState()
    expect(Object.keys(byMachine)).toEqual(['server-b'])
    expect(byMachine['server-b']).toMatchObject({ status: 'ready', error: null })
    expect(byMachine['server-b'].helpers[0].enabled).toBe(false)
  })

  it('a refused write keeps the list and says the machine’s sentence; a failed read says so', async () => {
    api.fleetHelpers.mockResolvedValue([helper()])
    await store.loadHelperPreferences('local')
    api.fleetHelperSet.mockRejectedValue(
      new Error("Error invoking remote method 'helpers:set': Error: That is not a model name.")
    )
    await store.setHelperPreference('local', 'tab-title', { model: 'x y' })
    const local = store.useHelperPreferencesStore.getState().byMachine.local
    expect(local.helpers).toEqual([helper()])
    expect(local.error).toBe('That is not a model name.')
    api.fleetHelpers.mockRejectedValue(
      new Error(
        'Error invoking remote method: Error: This server needs an update to show its helpers.'
      )
    )
    await store.loadHelperPreferences('server-old')
    expect(store.useHelperPreferencesStore.getState().byMachine['server-old'].error).toBe(
      'This server needs an update to show its helpers.'
    )
    api.fleetHelpers.mockRejectedValue(new Error('socket closed: token=secret'))
    await store.loadHelperPreferences('server-c')
    const failed = store.useHelperPreferencesStore.getState().byMachine['server-c']
    expect(failed.status).toBe('error')
    expect(failed.error).not.toContain('secret')
  })
})

describe('what a row offers', () => {
  it('models: the helper’s default first and marked, every alias once, an unknown pick kept', () => {
    const choices = store.helperModelChoices(helper({ model: 'claude-sonnet-4-6' }))
    // By family, never a version the page cannot know: the CLI resolves the alias.
    expect(choices[0]).toEqual({ value: 'haiku', label: 'Haiku (default)' })
    expect(choices.find((c) => c.value === 'sonnet')?.label).toBe('Sonnet')
    expect(choices.find((c) => c.value === 'opus')?.label).toBe('Opus')
    expect(choices.find((c) => c.value === 'fable')?.label).toBe('Fable')
    expect(
      choices
        .filter((c) => !c.value.startsWith('claude-'))
        .map((c) => c.label)
        .join(' ')
    ).not.toMatch(/\d/)
    // A full id picked elsewhere reads from its own shape.
    expect(choices.find((c) => c.value === 'claude-sonnet-4-6')?.label).toBe('Sonnet 4.6')
    const values = choices.map((c) => c.value)
    expect(values).toEqual(expect.arrayContaining(['opus', 'sonnet', 'fable', 'claude-sonnet-4-6']))
    expect(new Set(values).size).toBe(values.length)
  })

  it('accounts: the tab’s own, the machine login, each account but Default', () => {
    const accounts = [
      { id: 'default', label: 'Default' },
      { id: 'helpers', label: 'Helpers account' }
    ]
    expect(store.helperAccountChoices(accounts).map((c) => c.value)).toEqual([
      'session',
      'machine',
      'account:helpers'
    ])
    for (const account of [
      { kind: 'session' as const },
      { kind: 'machine' as const },
      { kind: 'account' as const, accountId: 'helpers' }
    ])
      expect(store.accountFromValue(store.accountValue(account))).toEqual(account)
  })

  it('says what a person gets when a helper is off, a later one included', () => {
    expect(store.helperWhenOff('tab-title')).toMatch(/first words/)
    expect(store.helperWhenOff('exchange-digest')).toMatch(/no digest/)
    expect(store.helperWhenOff('exchange-digest')).toContain(
      'Not read: digests are switched off in Settings.'
    )
    expect(store.helperWhenOff('work-digest')).toContain(
      'No title: titles are switched off in Settings.'
    )
    expect(store.helperDoes('tab-title')).toBe('Names a new tab from its first message.')
    // The permission explainer (PRDCT-4331), in the card's own words: the
    // rules' level alone, or "Not verified", and the failed reading's line.
    expect(store.helperDoes('permission-explainer')).toMatch(/permission card/)
    expect(store.helperWhenOff('permission-explainer')).toContain('the level the rules found')
    expect(store.helperWhenOff('permission-explainer')).toContain('"Not verified"')
    expect(store.helperWhenOff('permission-explainer')).toContain('"Could not read what this does"')
    // A helper declared later and named nowhere here still says something true.
    expect(store.helperDoes('zz-later-helper')).toMatch(/short call/)
    expect(store.helperWhenOff('zz-later-helper')).toMatch(/goes without it/)
  })
})
