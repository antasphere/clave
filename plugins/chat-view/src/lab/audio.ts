/* Folio's ElevenLabs voice (PRDCT-4411): a page's spoken rendering cut into
   parts the server speaks one call each, played in order through one audio
   element, the next part asked while the current one plays. The cut is pure;
   the queue takes its element and its URLs from outside, so a test plays it
   with a fake. */
import type { SpeakDone, SpeakResult, SpeechFailureReason } from '../../../../src/shared/speech'
import { speechChunks } from './speech'

/** The longest part one call speaks: well under the server's 5,000, and
 *  short enough that the first part comes back quickly. */
export const SPEECH_PART_MAX = 2_400

/** A rendering as the parts the server speaks, each at most `max`
 *  characters, cut at sentence ends, then clauses, then words. */
export function speechParts(text: string, max = SPEECH_PART_MAX): string[] {
  return speechChunks(text, max)
}

/** What the queue needs of an audio element (an `HTMLAudioElement`). */
export interface AudioLike {
  src: string
  play: () => Promise<void>
  pause: () => void
  onended: (() => void) | null
  onerror: (() => void) | null
}

/** A part that could not be had or played. */
export interface PartFailure {
  error: string
  reason: SpeechFailureReason
}

export interface AudioQueueOptions {
  /** The one element every part plays through; `new Audio()` by default. */
  createAudio?: () => AudioLike
  /** The playable URL of an answer; a Blob URL by default. */
  toUrl?: (answer: SpeakDone) => string
  revoke?: (url: string) => void
}

export interface AudioPlay {
  parts: string[]
  /** Asks the server for one part's audio. */
  source: (part: string) => Promise<SpeakResult>
  /** The first part's answer, when the caller asked for it already. */
  first?: Promise<SpeakResult>
  onProgress?: (at: number, of: number) => void
  onEnd?: () => void
  onError?: (at: number, failure: PartFailure) => void
}

const NOT_PLAYED: PartFailure = { error: 'The audio could not be played.', reason: 'failed' }

/** An answer's audio as a Blob URL the page may play (`media-src blob:`). */
export function blobUrlOf(answer: SpeakDone): string {
  const binary = atob(answer.audio)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: answer.mime }))
}

/**
 * The parts of a page played in order. Part 1 is asked (or taken from the
 * caller), played, and part n+1 is asked while part n plays. `stop()` pauses,
 * revokes the URL in play and drops every answer still to come: a generation
 * counter makes a late answer or a late `ended` of a stopped play a no-op.
 */
export class AudioQueue {
  private generation = 0
  private audio: AudioLike | null = null
  private url: string | null = null
  private active = false
  private readonly createAudio: () => AudioLike
  private readonly toUrl: (answer: SpeakDone) => string
  private readonly revoke: (url: string) => void

  constructor(options: AudioQueueOptions = {}) {
    this.createAudio = options.createAudio ?? (() => new Audio() as unknown as AudioLike)
    this.toUrl = options.toUrl ?? blobUrlOf
    this.revoke = options.revoke ?? ((url) => URL.revokeObjectURL(url))
  }

  /** Whether a play is going (stopped, ended and failed ones are not). */
  get playing(): boolean {
    return this.active
  }

  play(play: AudioPlay): void {
    this.stop()
    const mine = ++this.generation
    const { parts } = play
    if (!parts.length) return play.onEnd?.()
    this.active = true
    const asked: Array<Promise<SpeakResult> | undefined> = []
    const ask = (at: number): Promise<SpeakResult> =>
      (asked[at] ??= (at === 0 && play.first ? play.first : play.source(parts[at])).catch(
        (error: unknown): SpeakResult => ({ ok: false, error: String(error), reason: 'failed' })
      ))
    const live = (): boolean => mine === this.generation
    const fail = (at: number, failure: PartFailure): void => {
      if (!live()) return
      this.halt()
      play.onError?.(at, failure)
    }
    const playAt = async (at: number): Promise<void> => {
      const answer = await ask(at)
      if (!live()) return
      if (!answer.ok) return fail(at, { error: answer.error, reason: answer.reason ?? 'failed' })
      // The next part is asked while this one plays.
      if (at + 1 < parts.length) void ask(at + 1)
      const audio = (this.audio ??= this.createAudio())
      this.release()
      const url = this.toUrl(answer)
      this.url = url
      audio.onended = () => {
        if (!live()) return
        this.release()
        if (at + 1 < parts.length) return void playAt(at + 1)
        this.active = false
        play.onEnd?.()
      }
      audio.onerror = () => fail(at, NOT_PLAYED)
      audio.src = url
      play.onProgress?.(at, parts.length)
      audio.play().catch(() => fail(at, NOT_PLAYED))
    }
    void playAt(0)
  }

  /** Pause, revoke, and drop every answer still to come. */
  stop(): void {
    this.generation += 1
    this.halt()
  }

  private halt(): void {
    this.active = false
    if (this.audio) {
      this.audio.onended = null
      this.audio.onerror = null
      this.audio.pause()
    }
    this.release()
  }

  private release(): void {
    if (this.url) this.revoke(this.url)
    this.url = null
  }
}
