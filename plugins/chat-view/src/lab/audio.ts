/* Folio's ElevenLabs voice (PRDCT-4411): a page's spoken rendering cut into
   parts the server speaks one call each, played in order through one audio
   element, the next part asked while the current one plays. A part never
   spans two blocks of the page (PRDCT-4430), so the part in play says which
   block is read; the play can be paused, resumed and moved to any part. The
   cut is pure; the queue takes its element and its URLs from outside, so a
   test plays it with a fake. */
import type { SpeakDone, SpeakResult, SpeechFailureReason } from '../../../../src/shared/speech'
import { speechChunks } from './speech'

/** The longest part one call speaks: well under the server's 5,000, and
 *  short enough that the first part comes back quickly. */
export const SPEECH_PART_MAX = 2_400

/** One part the server speaks: its text, and the page block it reads (0 for
 *  a rendering filed before the blocks: the whole page, nothing to light). */
export interface SpeechPart {
  block: number
  text: string
}

/** A rendering's blocks as the parts the server speaks: one part per block,
 *  a block longer than `max` cut at sentence ends (then clauses, then words)
 *  into several parts of the same block. An empty block has no part. */
export function blockParts(
  blocks: { n: number; text: string }[],
  max = SPEECH_PART_MAX
): SpeechPart[] {
  return blocks.flatMap((block) => {
    const text = block.text.trim()
    if (!text) return []
    const pieces = text.length <= max ? [text] : speechChunks(text, max)
    return pieces.map((piece) => ({ block: block.n, text: piece }))
  })
}

/** How many answered parts a pane keeps (`PartCache`). */
export const PART_CACHE_MAX = 64

/** A part's key in the cache: the voice and the model that speak it, and its
 *  words. Pure. */
export const partKey = (voice: string, model: string, text: string): string =>
  `${voice}|${model}|${text}`

/**
 * The parts a pane already had spoken, so Play after Stop, a seek back, or
 * the same page read again asks the server for nothing it answered before
 * (each call is paid). Kept for the pane's life, across Stop, bounded to the
 * last `max` parts used. A part being asked is kept too, so a second ask
 * while the first is in flight waits for it; a failure is not kept, so the
 * next ask goes to the server again.
 */
export class PartCache {
  private readonly entries = new Map<string, Promise<SpeakResult>>()

  constructor(private readonly max = PART_CACHE_MAX) {}

  get size(): number {
    return this.entries.size
  }

  /** The answer kept for `key`, else `ask()`'s, kept unless it fails. */
  get(key: string, ask: () => Promise<SpeakResult>): Promise<SpeakResult> {
    const kept = this.entries.get(key)
    if (kept) {
      // The most recently used part is the last one dropped.
      this.entries.delete(key)
      this.entries.set(key, kept)
      return kept
    }
    const forget = (): void => {
      if (this.entries.get(key) === asked) this.entries.delete(key)
    }
    const asked: Promise<SpeakResult> = ask().then(
      (answer) => {
        if (!answer.ok) forget()
        return answer
      },
      (error: unknown) => {
        forget()
        throw error
      }
    )
    this.entries.set(key, asked)
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!)
    return asked
  }

  clear(): void {
    this.entries.clear()
  }
}

/** What the queue needs of an audio element (an `HTMLAudioElement`). */
export interface AudioLike {
  src: string
  /** Seconds into the part; its length once known (NaN or Infinity before). */
  currentTime: number
  duration: number
  play: () => Promise<void>
  pause: () => void
  onended: (() => void) | null
  onerror: (() => void) | null
  ontimeupdate: (() => void) | null
  ondurationchange: (() => void) | null
}

/** A part that could not be had or played. */
export interface PartFailure {
  error: string
  reason: SpeechFailureReason
}

export type QueueState = 'idle' | 'playing' | 'paused'

export interface AudioQueueOptions {
  /** The one element every part plays through; `new Audio()` by default. */
  createAudio?: () => AudioLike
  /** The playable URL of an answer; a Blob URL by default. */
  toUrl?: (answer: SpeakDone) => string
  revoke?: (url: string) => void
  /** A part's length before it plays, from its answer (`mp3Ms` by default);
   *  the element's own figure replaces it once the part is loaded. */
  lengthOf?: (answer: SpeakDone) => number | null
}

export interface AudioPlay {
  parts: SpeechPart[]
  /** Asks the server for one part's audio. */
  source: (part: string) => Promise<SpeakResult>
  /** The part to begin with (0 by default). */
  start?: number
  /** The starting part's answer, when the caller asked for it already. */
  first?: Promise<SpeakResult>
  onProgress?: (at: number, of: number, block: number) => void
  /** The time read and the whole length (null while a part's length is
   *  unknown), and how far into the part in play, 0 to 1. */
  onTime?: (elapsedMs: number, totalMs: number | null, fraction: number) => void
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

/** An MP3 answer's length in ms: the server asks ElevenLabs for 128 kbit/s
 *  (`mp3_44100_128`), 16 bytes a millisecond. */
export function mp3Ms(answer: SpeakDone): number | null {
  const pad = answer.audio.endsWith('==') ? 2 : answer.audio.endsWith('=') ? 1 : 0
  const bytes = Math.floor((answer.audio.length * 3) / 4) - pad
  return bytes > 0 ? Math.round(bytes / 16) : null
}

/** The play the queue holds: its parts, the answers asked, the lengths known. */
interface Held {
  play: AudioPlay
  generation: number
  asked: Array<Promise<SpeakResult> | undefined>
  lengths: Array<number | undefined>
  /** Lengths the element measured: an estimate never overwrites them. */
  measured: boolean[]
  at: number
}

/**
 * The parts of a page played in order. A part is asked (or taken from the
 * caller), played, and the next part is asked while it plays. `pause()`
 * keeps the part and its place, `resume()` goes on from there, `seek(n)`
 * stops the part in play and starts part n (the answers already had are
 * kept; prefetch goes on from n). `stop()` pauses, revokes the URL in play
 * and drops every answer still to come. A generation counter makes a late
 * answer or a late `ended` of a stopped play a no-op, and a step counter
 * does the same for a part sought away from.
 */
export class AudioQueue {
  private generation = 0
  private step = 0
  private audio: AudioLike | null = null
  private url: string | null = null
  private held: Held | null = null
  private current: QueueState = 'idle'
  /** The part in play has its source set: pause and resume act on it. */
  private loaded = false
  private readonly createAudio: () => AudioLike
  private readonly toUrl: (answer: SpeakDone) => string
  private readonly revoke: (url: string) => void
  private readonly lengthOf: (answer: SpeakDone) => number | null

  constructor(options: AudioQueueOptions = {}) {
    this.createAudio = options.createAudio ?? (() => new Audio() as unknown as AudioLike)
    this.toUrl = options.toUrl ?? blobUrlOf
    this.revoke = options.revoke ?? ((url) => URL.revokeObjectURL(url))
    this.lengthOf = options.lengthOf ?? mp3Ms
  }

  /** Whether a play is going, paused or not (stopped, ended and failed ones
   *  are not). */
  get playing(): boolean {
    return this.current !== 'idle'
  }

  get state(): QueueState {
    return this.current
  }

  /** The part in play, or null with no play. */
  get at(): number | null {
    return this.held ? this.held.at : null
  }

  play(play: AudioPlay): void {
    this.stop()
    if (!play.parts.length) return play.onEnd?.()
    const start = Math.max(0, Math.min(play.parts.length - 1, play.start ?? 0))
    this.held = {
      play,
      generation: ++this.generation,
      asked: [],
      lengths: [],
      measured: [],
      at: start
    }
    this.current = 'playing'
    void this.go(start)
  }

  /** Pause the part in play, keeping it and its place. */
  pause(): void {
    if (this.current !== 'playing') return
    this.current = 'paused'
    if (this.loaded) this.audio?.pause()
  }

  /** Go on from where the play was paused, in the same part. */
  resume(): void {
    if (this.current !== 'paused' || !this.held) return
    this.current = 'playing'
    if (this.loaded && this.audio) {
      const held = this.held
      const at = held.at
      this.audio.play().catch(() => this.fail(held, this.step, at, NOT_PLAYED))
    }
  }

  /** Stop the part in play and start part `at`; a paused play plays again. */
  seek(at: number): void {
    const held = this.held
    if (!held || this.current === 'idle' || at < 0 || at >= held.play.parts.length) return
    this.current = 'playing'
    void this.go(at)
  }

  /** Pause, revoke, and drop every answer still to come. */
  stop(): void {
    this.generation += 1
    this.step += 1
    this.held = null
    this.halt()
  }

  private ask(held: Held, at: number): Promise<SpeakResult> {
    const { play } = held
    return (held.asked[at] ??= (
      at === (play.start ?? 0) && play.first ? play.first : play.source(play.parts[at].text)
    )
      .catch(
        (error: unknown): SpeakResult => ({ ok: false, error: String(error), reason: 'failed' })
      )
      .then((answer) => {
        if (answer.ok && !held.measured[at]) held.lengths[at] = this.lengthOf(answer) ?? undefined
        return answer
      }))
  }

  private live(held: Held, step: number): boolean {
    return held === this.held && held.generation === this.generation && step === this.step
  }

  private fail(held: Held, step: number, at: number, failure: PartFailure): void {
    if (!this.live(held, step)) return
    this.held = null
    this.halt()
    held.play.onError?.(at, failure)
  }

  private time(held: Held): void {
    const audio = this.audio
    if (!audio) return
    const { parts } = held.play
    let before = 0
    for (let i = 0; i < held.at; i++) before += held.lengths[i] ?? 0
    const into = Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0
    const length = held.lengths[held.at]
    let total: number | null = 0
    for (let i = 0; i < parts.length; i++) {
      const known = held.lengths[i]
      if (known === undefined) {
        total = null
        break
      }
      total += known
    }
    const fraction = length ? Math.max(0, Math.min(1, into / length)) : 0
    held.play.onTime?.(
      Math.round(before + into),
      total === null ? null : Math.round(total),
      fraction
    )
  }

  private async go(at: number): Promise<void> {
    const held = this.held
    if (!held) return
    const step = ++this.step
    // The part in play stops; its answer stays asked.
    this.detach()
    held.at = at
    const { play } = held
    const { parts } = play
    const answer = await this.ask(held, at)
    if (!this.live(held, step)) return
    if (!answer.ok)
      return this.fail(held, step, at, { error: answer.error, reason: answer.reason ?? 'failed' })
    // The next part is asked while this one plays.
    if (at + 1 < parts.length) void this.ask(held, at + 1)
    const audio = (this.audio ??= this.createAudio())
    this.release()
    const url = this.toUrl(answer)
    this.url = url
    audio.onended = () => {
      if (!this.live(held, step)) return
      this.release()
      this.loaded = false
      if (at + 1 < parts.length) return void this.go(at + 1)
      this.held = null
      this.current = 'idle'
      play.onEnd?.()
    }
    audio.onerror = () => this.fail(held, step, at, NOT_PLAYED)
    audio.ontimeupdate = () => {
      if (this.live(held, step)) this.time(held)
    }
    audio.ondurationchange = () => {
      if (!this.live(held, step)) return
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        held.lengths[at] = audio.duration * 1000
        held.measured[at] = true
      }
      this.time(held)
    }
    audio.src = url
    this.loaded = true
    play.onProgress?.(at, parts.length, parts[at].block)
    this.time(held)
    // Paused while the part was asked: it waits, loaded, for the resume.
    if (this.current === 'paused') return
    audio.play().catch(() => this.fail(held, step, at, NOT_PLAYED))
  }

  /** The part in play stops: its handlers off, paused when it was loaded
   *  (or always, on a stop), its URL revoked. */
  private detach(always = false): void {
    const wasLoaded = this.loaded
    this.loaded = false
    if (this.audio) {
      this.audio.onended = null
      this.audio.onerror = null
      this.audio.ontimeupdate = null
      this.audio.ondurationchange = null
      if (always || wasLoaded) this.audio.pause()
    }
    this.release()
  }

  private halt(): void {
    this.current = 'idle'
    this.detach(true)
  }

  private release(): void {
    if (this.url) this.revoke(this.url)
    this.url = null
  }
}
