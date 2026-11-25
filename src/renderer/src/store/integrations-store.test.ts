import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElevenLabsStatus } from '../../../shared/elevenlabs'
import type { JevStatus } from '../../../shared/jev'

// The Settings page's store of the integrations (PRDCT-4410): every read and
// write goes to the machine the page names, the key passes through and is
// kept nowhere, and what the card says.

let store: typeof import('./integrations-store')

const status = (over: Partial<ElevenLabsStatus> = {}): ElevenLabsStatus => ({
  configured: false,
  setAt: null,
  voiceId: null,
  voiceName: null,
  modelId: 'eleven_flash_v2_5',
  checkedAt: null,
  tier: null,
  charactersUsed: null,
  charactersLimit: null,
  lastError: null,
  ...over
})

const api = {
  fleetIntegrations: vi.fn(),
  fleetElevenLabsSetKey: vi.fn(),
  fleetElevenLabsCheck: vi.fn(),
  fleetElevenLabsRemove: vi.fn(),
  fleetElevenLabsSetVoice: vi.fn(),
  fleetElevenLabsVoices: vi.fn(),
  fleetJevSetKey: vi.fn(),
  fleetJevCheck: vi.fn(),
  fleetJevRemove: vi.fn()
}

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  store = await import('./integrations-store')
})
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  store.useIntegrationsStore.setState({ byMachine: {} })
})

describe('the machine the page names', () => {
  it('reads and writes that machine, and keeps its answer under it alone', async () => {
    api.fleetIntegrations.mockResolvedValue({ elevenLabs: status() })
    await store.loadIntegrations('server-b')
    expect(api.fleetIntegrations).toHaveBeenCalledWith('server-b')
    const configured = status({ configured: true, setAt: 1, checkedAt: 2, tier: 'creator' })
    api.fleetElevenLabsSetKey.mockResolvedValue({ elevenLabs: configured })
    expect(await store.setElevenLabsKey('server-b', 'xi-store-test-key')).toBe(true)
    expect(api.fleetElevenLabsSetKey).toHaveBeenCalledWith('server-b', 'xi-store-test-key')
    const { byMachine } = store.useIntegrationsStore.getState()
    expect(Object.keys(byMachine)).toEqual(['server-b'])
    expect(byMachine['server-b']).toMatchObject({ status: 'ready', busy: false, error: null })
    expect(JSON.stringify(byMachine)).not.toContain('xi-store-test-key')

    api.fleetElevenLabsSetVoice.mockResolvedValue({
      elevenLabs: { ...configured, voiceId: 'v1', voiceName: 'One' }
    })
    await store.setElevenLabsVoice('server-b', 'v1', 'One', 'eleven_multilingual_v2')
    expect(api.fleetElevenLabsSetVoice).toHaveBeenCalledWith(
      'server-b',
      'v1',
      'One',
      'eleven_multilingual_v2'
    )
    api.fleetElevenLabsCheck.mockResolvedValue({ elevenLabs: configured })
    await store.checkElevenLabs('server-b')
    expect(api.fleetElevenLabsCheck).toHaveBeenCalledWith('server-b')
    api.fleetElevenLabsRemove.mockResolvedValue({ elevenLabs: status() })
    await store.removeElevenLabsKey('server-b')
    expect(api.fleetElevenLabsRemove).toHaveBeenCalledWith('server-b')
    expect(store.useIntegrationsStore.getState().byMachine['server-b'].elevenLabs?.configured).toBe(
      false
    )
  })

  it('reads the voices on demand, and says a failure in its sentence', async () => {
    api.fleetElevenLabsVoices.mockResolvedValue({
      voices: [{ voiceId: 'v1', name: 'One', category: 'premade', labels: {}, previewUrl: null }]
    })
    await store.loadElevenLabsVoices('local')
    expect(store.useIntegrationsStore.getState().byMachine.local.voices).toMatchObject({
      status: 'ready',
      voices: [{ voiceId: 'v1' }]
    })
    api.fleetElevenLabsVoices.mockRejectedValue(
      new Error(
        "Error invoking remote method 'integrations:elevenlabs-voices': Error: The key was refused by ElevenLabs."
      )
    )
    await store.loadElevenLabsVoices('local')
    expect(store.useIntegrationsStore.getState().byMachine.local.voices).toMatchObject({
      status: 'error',
      error: 'The key was refused by ElevenLabs.',
      voices: [{ voiceId: 'v1' }]
    })
    // ElevenLabs' own reason is a sentence for the person, whatever it says (PRDCT-4831).
    const reason =
      'ElevenLabs refused the key: The API key you used is missing the permission voices_read to execute this operation. Allow that permission for this key on elevenlabs.io, or paste a key that has it.'
    api.fleetElevenLabsVoices.mockRejectedValue(
      new Error(`Error invoking remote method 'integrations:elevenlabs-voices': Error: ${reason}`)
    )
    await store.loadElevenLabsVoices('local')
    expect(store.useIntegrationsStore.getState().byMachine.local.voices.error).toBe(reason)
    expect(
      store.sentenceOf(new Error(`Error: ElevenLabs refused the key: Error: nope.`), 'fallback')
    ).toBe('ElevenLabs refused the key: Error: nope.')
    expect(store.sentenceOf(new Error('Error: connect ECONNREFUSED 10.0.0.1'), 'fallback')).toBe(
      'fallback'
    )
  })

  it('a refused write keeps the status; an older server says it needs an update; a raw error is not shown', async () => {
    api.fleetIntegrations.mockResolvedValue({ elevenLabs: status() })
    await store.loadIntegrations('local')
    api.fleetElevenLabsSetKey.mockRejectedValue(
      new Error('Error invoking remote method: Error: This machine cannot store a secret.')
    )
    expect(await store.setElevenLabsKey('local', 'xi-x')).toBe(false)
    const local = store.useIntegrationsStore.getState().byMachine.local
    expect(local.elevenLabs).toEqual(status())
    expect(local.error).toBe('This machine cannot store a secret.')
    api.fleetIntegrations.mockRejectedValue(
      new Error('Error: This server needs an update to show its integrations.')
    )
    await store.loadIntegrations('server-old')
    expect(store.useIntegrationsStore.getState().byMachine['server-old'].error).toBe(
      'This server needs an update to show its integrations.'
    )
    api.fleetElevenLabsSetKey.mockRejectedValue(new Error('socket closed: xi-secret-in-error'))
    await store.setElevenLabsKey('server-c', 'xi-secret-in-error')
    expect(store.useIntegrationsStore.getState().byMachine['server-c'].error).toBe(
      'The key did not reach the machine.'
    )
  })
})

describe('what the card says', () => {
  it('the account line, the set date, the voice and model choices', () => {
    expect(
      store.accountLine(
        status({
          configured: true,
          checkedAt: 1,
          tier: 'creator',
          charactersUsed: 1200,
          charactersLimit: 100000
        })
      )
    ).toBe('creator · 1,200 of 100,000 characters this period')
    expect(store.accountLine(status({ configured: true, checkedAt: 1, lastError: 'x' }))).toBeNull()
    // A key that may not read the account: checked, with nothing to count.
    expect(store.accountLine(status({ configured: true, checkedAt: 1 }))).toBe(
      'Checked: ElevenLabs accepted the key.'
    )
    // The same account as the card draws it: the tier as a chip, the words,
    // and the share spent for the meter.
    expect(
      store.accountFigure(
        status({
          configured: true,
          checkedAt: 1,
          tier: 'creator',
          charactersUsed: 1200,
          charactersLimit: 100000
        })
      )
    ).toEqual({
      tier: 'creator',
      credits: '1,200 of 100,000 characters this period',
      spent: 0.012
    })
    expect(
      store.accountFigure(status({ configured: true, checkedAt: 1, charactersLimit: 0 }))
    ).toEqual({ tier: null, credits: null, spent: null })
    expect(store.accountFigure(status({ configured: true, checkedAt: null }))).toBeNull()
    expect(store.setOnLine(Date.UTC(2026, 10, 11, 12))).toBe('Set on 11 November 2026')
    expect(
      store.voiceChoices(
        [
          {
            voiceId: 'v1',
            name: 'One',
            category: 'premade',
            labels: { accent: 'neutral', use_case: 'narration' },
            previewUrl: null
          }
        ],
        { voiceId: 'gone', voiceName: 'Gone voice' }
      )
    ).toEqual([
      { value: 'gone', label: 'Gone voice' },
      { value: 'v1', label: 'One', hint: 'neutral · narration' }
    ])
    expect(store.modelChoices().map((c) => c.value)).toEqual([
      'eleven_flash_v2_5',
      'eleven_multilingual_v2'
    ])
  })
})

// The Jev key (PRDCT-5179), kept beside the ElevenLabs one.
describe('the Jev key', () => {
  const jev = (over: Partial<JevStatus> = {}): JevStatus => ({
    configured: false,
    setAt: null,
    checkedAt: null,
    lastError: null,
    ...over
  })

  it('every answer carries both cards: a Jev write keeps the ElevenLabs status', async () => {
    const eleven = status({ configured: true, setAt: 1, checkedAt: 2 })
    api.fleetIntegrations.mockResolvedValue({ elevenLabs: eleven, jev: jev() })
    await store.loadIntegrations('local')
    expect(store.useIntegrationsStore.getState().byMachine.local).toMatchObject({
      jev: jev(),
      jevOutdated: false
    })
    const set = jev({ configured: true, setAt: 10, checkedAt: 11 })
    api.fleetJevSetKey.mockResolvedValue({ elevenLabs: eleven, jev: set })
    expect(await store.setJevKey('local', 'ts-store-test-key')).toBe(true)
    expect(api.fleetJevSetKey).toHaveBeenCalledWith('local', 'ts-store-test-key')
    const local = store.useIntegrationsStore.getState().byMachine.local
    expect(local.jev).toEqual(set)
    expect(local.elevenLabs).toEqual(eleven)
    expect(JSON.stringify(local)).not.toContain('ts-store-test-key')
    api.fleetJevCheck.mockResolvedValue({ elevenLabs: eleven, jev: set })
    await store.checkJev('local')
    expect(api.fleetJevCheck).toHaveBeenCalledWith('local')
    api.fleetJevRemove.mockResolvedValue({ elevenLabs: eleven, jev: jev() })
    await store.removeJevKey('local')
    expect(store.useIntegrationsStore.getState().byMachine.local.jev?.configured).toBe(false)
  })

  it('an answer with no jev is a server that needs an update, never an error', async () => {
    api.fleetIntegrations.mockResolvedValue({ elevenLabs: status() })
    await store.loadIntegrations('server-old')
    const old = store.useIntegrationsStore.getState().byMachine['server-old']
    expect(old).toMatchObject({ status: 'ready', error: null, jev: null, jevOutdated: true })
    // A Jev write such a server refuses with the integrations' 404.
    api.fleetJevSetKey.mockRejectedValue(
      new Error('This server needs an update to show its integrations.')
    )
    expect(await store.setJevKey('server-old', 'ts-store-test-key')).toBe(false)
    expect(store.useIntegrationsStore.getState().byMachine['server-old']).toMatchObject({
      error: null,
      jevError: null,
      jevOutdated: true
    })
    expect(store.JEV_NEEDS_UPDATE).toBe('This server needs an update to hold a Jev key.')
  })

  it('a refusal in TypeSafe’s words is said whole; a raw error is not shown', async () => {
    api.fleetIntegrations.mockResolvedValue({ elevenLabs: status(), jev: jev() })
    await store.loadIntegrations('local')
    api.fleetJevSetKey.mockRejectedValue(
      new Error(
        "Error invoking remote method 'integrations:jev-set-key': Error: TypeSafe refused the key: Error: the key is revoked."
      )
    )
    await store.setJevKey('local', 'ts-store-test-key')
    expect(store.useIntegrationsStore.getState().byMachine.local).toMatchObject({
      // Said under the Jev card, never under the ElevenLabs one.
      error: null,
      jevError: 'TypeSafe refused the key: Error: the key is revoked.'
    })
    api.fleetJevCheck.mockRejectedValue(new Error('Error: The server could not reach TypeSafe.'))
    await store.checkJev('local')
    expect(store.useIntegrationsStore.getState().byMachine.local.jevError).toBe(
      'The server could not reach TypeSafe.'
    )
    api.fleetJevRemove.mockRejectedValue(new Error('ECONNRESET at socket.ts:12'))
    await store.removeJevKey('local')
    const local = store.useIntegrationsStore.getState().byMachine.local
    expect(local.jevError).toBe('The key could not be removed from the machine.')
    expect(local.jev).toEqual(jev())
  })

  it('the checked line', () => {
    expect(store.checkedOnLine(null)).toBeNull()
    expect(store.checkedOnLine(Date.UTC(2026, 10, 25, 12))).toBe('Checked on 25 November 2026')
  })
})
