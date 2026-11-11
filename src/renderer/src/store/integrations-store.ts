/**
 * The integrations of each machine as the Settings page shows them
 * (PRDCT-4410): this Mac's and every saved server's, by machine id
 * (`LOCAL_SERVER_ID` for this Mac). Nothing here is a truth of its own: the
 * key is sealed on the machine, every read and write goes there
 * (`fleetIntegrations` and the `fleetElevenLabs*` members, which keep this
 * Mac's on its own route), and what is kept is that machine's last answer.
 * The key a person pastes passes through once and is kept nowhere here.
 */
import { create } from 'zustand'
import {
  ELEVENLABS_MODELS,
  INTEGRATIONS_NEED_UPDATE,
  type ElevenLabsModelId,
  type ElevenLabsStatus,
  type ElevenLabsVoice
} from '../../../shared/elevenlabs'

export interface MachineVoices {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  voices: ElevenLabsVoice[]
}

export interface MachineIntegrations {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** One safe sentence, never the raw error. */
  error: string | null
  elevenLabs: ElevenLabsStatus | null
  /** A write in flight (save, check, remove): the buttons wait for it. */
  busy: boolean
  voices: MachineVoices
}

export const EMPTY_MACHINE_VOICES: MachineVoices = { status: 'idle', error: null, voices: [] }
export const EMPTY_MACHINE_INTEGRATIONS: MachineIntegrations = {
  status: 'idle',
  error: null,
  elevenLabs: null,
  busy: false,
  voices: EMPTY_MACHINE_VOICES
}

export const useIntegrationsStore = create<{ byMachine: Record<string, MachineIntegrations> }>(
  () => ({ byMachine: {} })
)

function patchMachine(
  machine: string,
  next: (current: MachineIntegrations) => MachineIntegrations
): void {
  useIntegrationsStore.setState((state) => ({
    byMachine: {
      ...state.byMachine,
      [machine]: next(state.byMachine[machine] ?? EMPTY_MACHINE_INTEGRATIONS)
    }
  }))
}

/** The sentences a machine says that are meant for the person; anything
 *  else (a socket error, a stack) is said with the fallback. */
const SENTENCES =
  /^(Paste the API key first\.|This machine cannot store a secret\.|No ElevenLabs key on this machine\.|The key was refused by ElevenLabs\.|The server could not reach ElevenLabs\.|ElevenLabs answered \d{3}\.|That is not a voice\.|That is not an ElevenLabs model\.|This server has no integrations\.|The server did not answer)$/

export function sentenceOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes(INTEGRATIONS_NEED_UPDATE)) return INTEGRATIONS_NEED_UPDATE
  // IPC wraps a refusal ("Error invoking remote method '…': Error: <sentence>").
  const sentence = (message.split(/\bError: /).pop() ?? '').trim()
  return SENTENCES.test(sentence) ? sentence : fallback
}

/** Read a machine's integrations. */
export async function loadIntegrations(machine: string): Promise<void> {
  patchMachine(machine, (current) => ({ ...current, status: 'loading', error: null }))
  try {
    const { elevenLabs } = await window.electronAPI.fleetIntegrations(machine)
    patchMachine(machine, (current) => ({ ...current, status: 'ready', error: null, elevenLabs }))
  } catch (error) {
    patchMachine(machine, (current) => ({
      ...current,
      status: 'error',
      error: sentenceOf(error, 'The integrations could not be read from this machine.')
    }))
  }
}

/** One write on that machine; the status on screen is its answer. */
async function write(
  machine: string,
  run: () => Promise<{ elevenLabs: ElevenLabsStatus }>,
  fallback: string,
  after?: (current: MachineIntegrations, next: ElevenLabsStatus) => Partial<MachineIntegrations>
): Promise<boolean> {
  patchMachine(machine, (current) => ({ ...current, busy: true, error: null }))
  try {
    const { elevenLabs } = await run()
    patchMachine(machine, (current) => ({
      ...current,
      status: 'ready',
      error: null,
      busy: false,
      elevenLabs,
      ...after?.(current, elevenLabs)
    }))
    return true
  } catch (error) {
    patchMachine(machine, (current) => ({
      ...current,
      busy: false,
      error: sentenceOf(error, fallback)
    }))
    return false
  }
}

/** Seal a pasted key on that machine; it is checked there at once. A new
 *  key may belong to another account: the voices are read again. */
export function setElevenLabsKey(machine: string, apiKey: string): Promise<boolean> {
  return write(
    machine,
    () => window.electronAPI.fleetElevenLabsSetKey(machine, apiKey),
    'The key did not reach the machine.',
    () => ({ voices: EMPTY_MACHINE_VOICES })
  )
}

export function checkElevenLabs(machine: string): Promise<boolean> {
  return write(
    machine,
    () => window.electronAPI.fleetElevenLabsCheck(machine),
    'The check did not reach the machine.'
  )
}

export function removeElevenLabsKey(machine: string): Promise<boolean> {
  return write(
    machine,
    () => window.electronAPI.fleetElevenLabsRemove(machine),
    'The key could not be removed from the machine.',
    () => ({ voices: EMPTY_MACHINE_VOICES })
  )
}

export function setElevenLabsVoice(
  machine: string,
  voiceId: string,
  voiceName: string,
  modelId?: ElevenLabsModelId
): Promise<boolean> {
  return write(
    machine,
    () => window.electronAPI.fleetElevenLabsSetVoice(machine, voiceId, voiceName, modelId),
    'The voice did not reach the machine.'
  )
}

/** The account's voices, read on that machine with its key. */
export async function loadElevenLabsVoices(machine: string): Promise<void> {
  patchMachine(machine, (current) => ({
    ...current,
    voices: { ...current.voices, status: 'loading', error: null }
  }))
  try {
    const { voices } = await window.electronAPI.fleetElevenLabsVoices(machine)
    patchMachine(machine, (current) => ({
      ...current,
      voices: { status: 'ready', error: null, voices }
    }))
  } catch (error) {
    patchMachine(machine, (current) => ({
      ...current,
      voices: {
        ...current.voices,
        status: 'error',
        error: sentenceOf(error, 'The voices could not be read.')
      }
    }))
  }
}

// ── What the page shows ──────────────────────────────────────────────────────

export interface Choice {
  value: string
  label: string
  hint?: string
}

/** A voice as the select offers it: its name, then its labels. A voice
 *  chosen before that the list no longer has stays offered by its name. */
export function voiceChoices(
  voices: ReadonlyArray<ElevenLabsVoice>,
  chosen: { voiceId: string | null; voiceName: string | null }
): Choice[] {
  const choices = voices.map((voice) => ({
    value: voice.voiceId,
    label: [voice.name, ...Object.values(voice.labels)].join(' · ')
  }))
  if (chosen.voiceId && !voices.some((v) => v.voiceId === chosen.voiceId))
    choices.unshift({ value: chosen.voiceId, label: chosen.voiceName ?? chosen.voiceId })
  return choices
}

export function modelChoices(): Choice[] {
  return ELEVENLABS_MODELS.map((model) => ({
    value: model.id,
    label: model.label,
    hint: model.note
  }))
}

const count = (n: number): string => n.toLocaleString('en-US')

/** The account line under the key: `<tier> · <used> of <limit> characters
 *  this period`, as far as the check read it. */
export function accountLine(status: ElevenLabsStatus): string | null {
  if (status.lastError || status.checkedAt === null) return null
  const parts: string[] = []
  if (status.tier) parts.push(status.tier)
  if (status.charactersUsed !== null && status.charactersLimit !== null)
    parts.push(
      `${count(status.charactersUsed)} of ${count(status.charactersLimit)} characters this period`
    )
  return parts.length ? parts.join(' · ') : 'Checked: the account answered.'
}

export function setOnLine(setAt: number | null): string {
  if (setAt === null) return 'Set'
  return `Set on ${new Date(setAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })}`
}
