import type { ElevenLabsStatus } from '../../../../src/shared/elevenlabs'
import type { HeardVoice, Reading } from './read-aloud'

/* The voice card's words (PRDCT-4430, PRDCT-4411), pure: which state the
   card is in, and which voice will read, said before a click as honestly as
   this window can know it. */

/** The card's states, in the order a reading goes through them. */
export type VoiceCardState = 'idle' | 'rewriting' | 'creating' | 'playing' | 'paused'

/** The state of the card for a page's reading (null when nothing of this
 *  page is being read). */
export function voiceCardState(reading: Reading | null): VoiceCardState {
  if (!reading) return 'idle'
  if (reading.state === 'preparing') return reading.step === 'creating' ? 'creating' : 'rewriting'
  return reading.state
}

/** Which voice will read, and when it is the Mac's, why. */
export interface VoiceSource {
  /** "Bella · ElevenLabs on this Mac", "The Mac's voice", … */
  name: string
  /** One line under it when the Mac's voice reads: why. */
  why?: string
  /** The ElevenLabs voice's own name, when known. */
  voiceName?: string
}

const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)

/**
 * Which voice will read the page, before a click. A tab on this Mac reads
 * this Mac's status (the Integrations store, read again by the card on each
 * page); a server tab says what its last reading heard, else what the
 * Integrations page last read of that server, else only that the server's
 * voice reads if it has one. Pure.
 */
export function voiceSource(
  local: boolean,
  status: ElevenLabsStatus | null | undefined,
  heard: HeardVoice | null
): VoiceSource | null {
  const where = local ? 'on this Mac' : 'on the server'
  const fromStatus = (s: ElevenLabsStatus): VoiceSource => {
    if (!s.configured) return { name: "The Mac's voice", why: 'No ElevenLabs on this server' }
    if (!s.voiceId) return { name: "The Mac's voice", why: 'No voice chosen on this server' }
    const voiceName = s.voiceName ?? undefined
    return {
      name: voiceName ? `${voiceName} · ElevenLabs ${where}` : `ElevenLabs ${where}`,
      ...(voiceName && { voiceName })
    }
  }
  if (local && status) return fromStatus(status)
  if (heard?.voice === 'elevenlabs') {
    const voiceName = status?.configured ? (status.voiceName ?? undefined) : undefined
    return {
      name: voiceName ? `${voiceName} · ElevenLabs ${where}` : `ElevenLabs ${where}`,
      ...(voiceName && { voiceName })
    }
  }
  if (heard?.voice === 'system' && heard.why.kind === 'unset')
    return { name: "The Mac's voice", why: sentence(heard.why.words) }
  if (status) return fromStatus(status)
  return local ? null : { name: "The server's voice, if it has one" }
}

/** What the card says while the Mac's voice reads: the reason's own words,
 *  a note rather than an error. Pure. */
export function macVoiceLine(why: string | undefined): string {
  return why ? `Reading with the Mac's voice: ${why}` : "Reading with the Mac's voice"
}

/** Seconds since `since`, as the card shows them while a step runs. Pure. */
export function stepSeconds(since: number, now: number): string {
  return `${Math.max(0, Math.floor((now - since) / 1000))}s`
}
