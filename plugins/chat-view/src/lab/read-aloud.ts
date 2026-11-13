import { useCallback, useEffect, useRef, useState } from 'react'
import type { DigestLaunch } from '../../../../src/shared/exchange-digest'
import type { SpeakResult, SpeechFailureReason } from '../../../../src/shared/speech'
import {
  useIntegrationsStore,
  type MachineIntegrations
} from '../../../../src/renderer/src/store/integrations-store'
import { ownerOf } from '../../../../src/renderer/src/lib/fleet-identity'
import type { DigestFailure } from '../digest'
import { AudioQueue, PartCache, blockParts, partKey, type SpeechPart } from './audio'
import { partFor, partPlace, partTicks } from './progress'
import { speechChunks } from './speech'
import { requestSpokenRendering, spokenKeyOf, spokenSource, type SpokenAnswer } from './spoken'

/** What is being read, and how far: the page's key and the part at.
 *  `preparing` while the spoken rendering is asked (`spoken.ts`) and the
 *  first part of the voice, then `speaking`; `fallback` says why the page is
 *  read as written; `voice` which voice reads it, and `why` the system voice
 *  reads it rather than the server's ElevenLabs voice.
 *
 *  The player (PRDCT-4430): `state` is preparing, playing or paused; `block`
 *  the page block being read (`[data-block]`, null when the rendering has no
 *  blocks); `blocks` how many ticks the bar has, `ticks` the block each one
 *  reads, `tick` the one in play and `fraction` how much of it is read;
 *  `elapsedMs` and `totalMs` (null while unknown) the ElevenLabs voice's
 *  clock. */
export interface Reading {
  key: string
  at: number
  of: number
  phase: 'preparing' | 'speaking'
  state: 'preparing' | 'playing' | 'paused'
  block: number | null
  blocks: number
  ticks: number[]
  tick: number
  fraction: number
  elapsedMs: number
  totalMs: number | null
  fallback?: DigestFailure | 'missing'
  voice?: 'elevenlabs' | 'system'
  why?: string
  /** Whether the system voice reads because the server has no ElevenLabs
   *  to offer (`unset`) or because ElevenLabs was asked and failed. */
  whyKind?: VoiceWhy['kind']
  /** While preparing, the step the reading is at (PRDCT-4430, the voice
   *  card): the answer `rewriting` for the voice (the spoken rendering), then
   *  `creating` the voice (the first part asked of ElevenLabs); null once
   *  the voice speaks. `since` is when the step began. */
  step: 'rewriting' | 'creating' | null
  since: number
}

/** What a pane last heard of its tab's voice, from a reading: the server's
 *  ElevenLabs voice spoke, or the system voice read, and why. */
export type HeardVoice = { voice: 'elevenlabs' } | { voice: 'system'; why: VoiceWhy }

/** The reading being prepared: nothing played yet, the block asked to start
 *  from (if any) lit at once. */
function preparingReading(key: string, from: number | null): Reading {
  return {
    key,
    at: 0,
    of: 0,
    phase: 'preparing',
    state: 'preparing',
    block: from,
    blocks: 0,
    ticks: [],
    tick: 0,
    fraction: 0,
    elapsedMs: 0,
    totalMs: null,
    step: 'rewriting',
    since: Date.now()
  }
}

/** The reading at part `at` of `parts`. Pure. */
export function readingAt(
  key: string,
  parts: SpeechPart[],
  at: number,
  extra: Partial<Reading> = {}
): Reading {
  const ticks = partTicks(parts)
  const place = partPlace(parts, at)
  return {
    key,
    at,
    of: parts.length,
    phase: 'speaking',
    state: 'playing',
    block: place.block,
    blocks: ticks.length,
    ticks,
    tick: place.tick,
    fraction: place.fraction,
    elapsedMs: 0,
    totalMs: null,
    step: null,
    since: 0,
    ...extra
  }
}

/** The reading in flight, as the hook holds it: what the controls act on. */
interface Active {
  key: string
  mine: number
  /** The block to start from, asked while the reading was preparing. */
  from: number | null
  /** The parts, once the voice is chosen; null while preparing. */
  parts: SpeechPart[] | null
  pause: () => void
  resume: () => void
  seek: (at: number) => void
}

/** Whose pages are read: the tab, and the account its helper runs on. */
export interface ReadSource {
  sessionId: string
  launch: DigestLaunch
}

const PREF = 'clave.folio.read-aloud'

/** Whether new answers are read aloud as they finish: the reader's own
 *  choice, kept on this machine. */
export function useAutoRead(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(PREF) === 'on'
    } catch {
      return false
    }
  })
  const set = useCallback((value: boolean): void => {
    setOn(value)
    try {
      localStorage.setItem(PREF, value ? 'on' : 'off')
    } catch {
      /* a private store: the choice lasts the view's life */
    }
  }, [])
  return [on, set]
}

/** Why the system voice reads a page rather than the server's ElevenLabs
 *  voice (PRDCT-4411): `unset` when the server has none to offer (no key, no
 *  voice, a release before the speech), `failed` when ElevenLabs was asked
 *  and could not speak it. */
export interface VoiceWhy {
  kind: 'unset' | 'failed'
  words: string
}

/** A speak answer's reason, in the read control's words. Pure. */
export function voiceWhy(reason: SpeechFailureReason | undefined): VoiceWhy {
  switch (reason) {
    case 'no-integration':
      return { kind: 'unset', words: 'no ElevenLabs on this server' }
    case 'no-voice':
      return { kind: 'unset', words: 'no voice chosen on this server' }
    case 'outdated':
      return { kind: 'unset', words: 'this server needs an update' }
    case 'refused':
      return { kind: 'failed', words: 'the key was refused' }
    case 'quota':
      return { kind: 'failed', words: 'the ElevenLabs credits are spent' }
    case 'unreachable':
      return { kind: 'failed', words: 'ElevenLabs could not be reached' }
    case 'unknown-session':
      return { kind: 'failed', words: 'the server has no record of this tab' }
    default:
      return { kind: 'failed', words: 'ElevenLabs could not speak it' }
  }
}

/** What the voice card says once a page was read by the Mac's voice (under
 *  "The Mac's voice" when the server has none to offer), or once the
 *  ElevenLabs voice stopped part way. Pure. */
export function voiceNote(why: VoiceWhy, stopped = false): string {
  if (stopped) return `ElevenLabs stopped: ${why.words}`
  return why.kind === 'unset'
    ? why.words.charAt(0).toUpperCase() + why.words.slice(1)
    : `Read with the Mac's voice: ${why.words}`
}

/** How long a pane remembers that its server has no ElevenLabs to offer (no
 *  key, no voice): long enough that a page after page is not asked again
 *  each time, short enough that a key pasted meanwhile is used soon. The
 *  memory is dropped at once when this window sees the integrations change
 *  (`useIntegrationsStore`, the Integrations page's). */
export const NO_VOICE_MEMORY_MS = 30_000

/** What a pane remembers of a server that had no ElevenLabs to offer. */
export interface NoVoiceMemory {
  reason: SpeechFailureReason
  at: number
}

/** The answers a pane remembers: the server has nothing to offer yet. */
export const rememberedReasons: ReadonlySet<SpeechFailureReason> = new Set([
  'no-integration',
  'no-voice'
])

/** The reason remembered for a tab's server, while the memory holds; null
 *  when ElevenLabs is to be asked again. Pure. */
export function rememberedVoiceReason(
  memory: NoVoiceMemory | undefined,
  now: number
): SpeechFailureReason | null {
  if (!memory) return null
  const age = now - memory.at
  return age >= 0 && age < NO_VOICE_MEMORY_MS ? memory.reason : null
}

/** Whether any machine's ElevenLabs status changed between two states of
 *  the integrations store (a key saved or removed, a voice chosen). Pure. */
export function integrationsChanged(
  before: Record<string, MachineIntegrations>,
  after: Record<string, MachineIntegrations>
): boolean {
  if (before === after) return false
  const machines = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const machine of machines) {
    const was = before[machine]?.elevenLabs ?? null
    const is = after[machine]?.elevenLabs ?? null
    if (was === is) continue
    // The same answer read again (the voice card reads this Mac's on each
    // page) is no change: only the key, the voice or the model are.
    if (
      !was ||
      !is ||
      was.configured !== is.configured ||
      was.voiceId !== is.voiceId ||
      was.modelId !== is.modelId
    )
      return true
  }
  return false
}

/** Whose reading the one voice is speaking: a pane's own token, so a pane
 *  cancels the voice only while the reading is its own, never another
 *  pane's that took the voice over. `ownerStop` stops the owner's reading,
 *  the system voice and the audio queue alike, so one reading at a time
 *  holds across the app. */
let voiceOwner: symbol | null = null
let ownerStop: (() => void) | null = null

/** The page read aloud from its spoken rendering when one can be had (as
 *  written when not): in the ElevenLabs voice of the server the tab runs on
 *  (PRDCT-4411), else through the system's own voice (the Web Speech API's
 *  synthesis, offline on macOS), the control saying why. One reading at a
 *  time across the app: a new one stops whatever was being read, ours or
 *  another pane's. */
export function useReadAloud(source: ReadSource): {
  supported: boolean
  reading: Reading | null
  /** The pages last read as written, and why: the control says it on hover. */
  fallbacks: Record<string, DigestFailure | 'missing'>
  /** The pages last read by the system voice, or whose ElevenLabs read
   *  stopped, and why: the control says it on hover. */
  notes: Record<string, string>
  /** The pages read to their end in this pane: the card offers them again. */
  heardPages: Record<string, true>
  /** What the pane last heard of its tab's voice, null before any reading. */
  heard: HeardVoice | null
  /** Read a page aloud, from its first block or from block `from`. */
  read: (key: string, markdown: string, from?: number) => void
  /** Read from block `n`: a reading of that page moves there, any other
   *  starts one. */
  readFrom: (key: string, markdown: string, n: number) => void
  pause: () => void
  resume: () => void
  /** Move the reading to page block `n` (the first part of that block, or
   *  of the next block with words). */
  seekBlock: (n: number) => void
  stop: () => void
} {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const systemVoice = !!synth && typeof SpeechSynthesisUtterance !== 'undefined'
  const audioVoice = typeof Audio !== 'undefined' && typeof URL?.createObjectURL === 'function'
  const supported = systemVoice || audioVoice
  const [reading, setReading] = useState<Reading | null>(null)
  const [fallbacks, setFallbacks] = useState<Record<string, DigestFailure | 'missing'>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [heardPages, setHeardPages] = useState<Record<string, true>>({})
  const [heard, setHeard] = useState<HeardVoice | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  // The generation of the reading in flight: an utterance or a part of a
  // cancelled one still fires its end, and must not move the new one along.
  const generation = useRef(0)
  // This pane's token: the voice is ours while `voiceOwner` is it.
  const me = useRef<symbol>(Symbol('folio-voice'))
  const queue = useRef<AudioQueue | null>(null)
  const active = useRef<Active | null>(null)
  // The tabs whose server said it has no ElevenLabs (no key, no voice), for
  // NO_VOICE_MEMORY_MS: a server without a key is not asked again on every
  // page, and a key pasted meanwhile is used soon after.
  const unset = useRef(new Map<string, NoVoiceMemory>())
  // The parts already spoken, for the pane's life (Stop keeps them): a page
  // played again, or sought back, is not paid for twice.
  const spokenParts = useRef(new PartCache())
  // A key or a voice changed on the Integrations page: ask again at once.
  useEffect(
    () =>
      useIntegrationsStore.subscribe((state, previous) => {
        if (!integrationsChanged(previous.byMachine, state.byMachine)) return
        unset.current.clear()
        spokenParts.current.clear()
      }),
    []
  )
  /** One part spoken by the tab's server, or the answer it gave before for
   *  the same words in the same voice and model (as far as this window knows
   *  them: the machine's status on the Integrations page). */
  const speakCached = useCallback((sessionId: string, text: string): Promise<SpeakResult> => {
    const machine = ownerOf(sessionId)
    const status = useIntegrationsStore.getState().byMachine[machine]?.elevenLabs
    const voice = `${machine}:${status?.voiceId ?? '?'}`
    return spokenParts.current.get(partKey(voice, status?.modelId ?? '?', text), () =>
      speakPart(sessionId, text)
    )
  }, [])

  const note = useCallback((key: string, line: string | null): void => {
    setNotes((now) => {
      if ((now[key] ?? null) === line) return now
      const next = { ...now }
      if (line) next[key] = line
      else delete next[key]
      return next
    })
  }, [])
  const release = useCallback((): void => {
    if (voiceOwner === me.current) {
      voiceOwner = null
      ownerStop = null
    }
  }, [])
  const stop = useCallback((): void => {
    generation.current += 1
    active.current = null
    queue.current?.stop()
    if (voiceOwner === me.current) synth?.cancel()
    release()
    setReading(null)
  }, [synth, release])
  const stopRef = useRef(stop)
  stopRef.current = stop

  const read = useCallback(
    (key: string, markdown: string, from?: number): void => {
      if (!supported) return
      // Whatever another pane was reading stops first: one voice at a time.
      if (voiceOwner && voiceOwner !== me.current) ownerStop?.()
      synth?.cancel()
      queue.current?.stop()
      const mine = ++generation.current
      voiceOwner = me.current
      ownerStop = () => stopRef.current()
      const run: Active = {
        key,
        mine,
        from: from ?? null,
        parts: null,
        pause: () => undefined,
        resume: () => undefined,
        seek: () => undefined
      }
      active.current = run
      setReading(preparingReading(key, from ?? null))
      const { sessionId, launch } = sourceRef.current
      /** Still this reading, and still ours to speak. */
      const current = (): boolean => {
        if (generation.current !== mine) return false
        if (voiceOwner === me.current) return true
        setReading(null)
        return false
      }
      /** Change the reading, while it is still this one. */
      const patch = (change: (now: Reading) => Reading): void => {
        if (generation.current !== mine) return
        setReading((now) => (now && now.key === key ? change(now) : now))
      }
      const done = (): void => {
        if (active.current === run) active.current = null
        release()
        setReading(null)
        setHeardPages((now) => (now[key] ? now : { ...now, [key]: true }))
      }

      const speakSystem = (
        parts: SpeechPart[],
        start: number,
        fallback: DigestFailure | 'missing' | undefined,
        why: VoiceWhy
      ): void => {
        note(key, voiceNote(why))
        setHeard({ voice: 'system', why })
        if (!parts.length || !synth || !systemVoice) return done()
        const extra = {
          voice: 'system' as const,
          why: why.words,
          whyKind: why.kind,
          ...(fallback && { fallback })
        }
        // Each block is its own run of utterances, so the block in play is
        // known; a seek cancels and speaks again from the asked block.
        let step = 0
        let paused = false
        const sayFrom = (first: number): void => {
          const mineStep = ++step
          paused = false
          synth.cancel()
          setReading(readingAt(key, parts, first, extra))
          const live = (): boolean => generation.current === mine && step === mineStep
          for (let n = first; n < parts.length; n++) {
            const chunks = speechChunks(parts[n].text)
            chunks.forEach((chunk, c) => {
              const utterance = new SpeechSynthesisUtterance(chunk)
              utterance.lang = document.documentElement.lang || navigator.language
              utterance.rate = 1.04
              utterance.onstart = () => {
                if (live())
                  setReading(
                    readingAt(key, parts, n, {
                      ...extra,
                      state: paused ? 'paused' : 'playing',
                      fraction: partPlace(parts, n, c / chunks.length).fraction
                    })
                  )
              }
              const end = (): void => {
                if (!live() || n !== parts.length - 1 || c !== chunks.length - 1) return
                done()
              }
              utterance.onend = end
              utterance.onerror = end
              synth.speak(utterance)
            })
          }
        }
        run.parts = parts
        run.pause = () => {
          paused = true
          synth.pause?.()
          patch((now) => ({ ...now, state: 'paused' }))
        }
        run.resume = () => {
          paused = false
          synth.resume?.()
          patch((now) => ({ ...now, state: 'playing' }))
        }
        run.seek = (at) => sayFrom(at)
        sayFrom(start)
      }

      const speakElevenLabs = (
        parts: SpeechPart[],
        start: number,
        first: Promise<SpeakResult>,
        fallback: DigestFailure | 'missing' | undefined
      ): void => {
        note(key, null)
        setHeard({ voice: 'elevenlabs' })
        const extra = { voice: 'elevenlabs' as const, ...(fallback && { fallback }) }
        const player = (queue.current ??= new AudioQueue())
        const stateNow = (): Reading['state'] => (player.state === 'paused' ? 'paused' : 'playing')
        run.parts = parts
        run.pause = () => {
          player.pause()
          patch((now) => ({ ...now, state: 'paused' }))
        }
        run.resume = () => {
          player.resume()
          patch((now) => ({ ...now, state: 'playing' }))
        }
        run.seek = (at) => {
          player.seek(at)
          patch((now) => ({
            ...readingAt(key, parts, at, extra),
            elapsedMs: now.elapsedMs,
            totalMs: now.totalMs
          }))
        }
        setReading(readingAt(key, parts, start, extra))
        player.play({
          parts,
          start,
          first,
          source: (text) => speakCached(sessionId, text),
          onProgress: (n) =>
            patch((now) => ({
              ...readingAt(key, parts, n, extra),
              state: stateNow(),
              elapsedMs: now.elapsedMs,
              totalMs: now.totalMs
            })),
          onTime: (elapsedMs, totalMs, fraction) =>
            patch((now) => ({
              ...now,
              elapsedMs,
              totalMs,
              fraction: partPlace(parts, now.at, fraction).fraction
            })),
          onEnd: () => {
            if (generation.current === mine) done()
          },
          // A later part that fails stops the read and says so: never a
          // silent switch of voices in the middle of a page.
          onError: (_n, failure) => {
            if (generation.current !== mine) return
            note(key, voiceNote(voiceWhy(failure.reason), true))
            done()
          }
        })
      }

      const speak = (answer: SpokenAnswer | null): void => {
        // Stopped, or another reading began, while the rendering was asked.
        if (!current()) return
        const { blocks, fallback } = spokenSource(answer, markdown)
        setFallbacks((now) => {
          if (now[key] === fallback) return now
          const next = { ...now }
          if (fallback) next[key] = fallback
          else delete next[key]
          return next
        })
        const parts = blockParts(blocks)
        if (!parts.length) return done()
        // The block asked while preparing, if any (a click on the page).
        const asked = run.from === null ? 0 : partFor(parts, run.from)
        const start = asked < 0 ? 0 : asked
        const remembered = rememberedVoiceReason(unset.current.get(sessionId), Date.now())
        if (remembered) return speakSystem(parts, start, fallback, voiceWhy(remembered))
        unset.current.delete(sessionId)
        if (!audioVoice)
          return speakSystem(parts, start, fallback, {
            kind: 'unset',
            words: 'this app plays no audio'
          })
        // The first part decides the voice: ElevenLabs when the server speaks
        // it, the system voice (and why) when it cannot. The card says the
        // voice is being created unless this window already knows the server
        // has none to offer (this Mac's status, read by the card).
        const status = useIntegrationsStore.getState().byMachine[ownerOf(sessionId)]?.elevenLabs
        if (!status || (status.configured && status.voiceId))
          patch((now) => ({ ...now, step: 'creating', since: Date.now() }))
        const first = speakCached(sessionId, parts[start].text)
        void first.then((spoken) => {
          if (!current()) return
          // A block clicked while the first part was asked: start there.
          const now = run.from === null ? start : partFor(parts, run.from)
          const begin = now < 0 ? start : now
          if (spoken.ok)
            return speakElevenLabs(
              parts,
              begin,
              begin === start ? first : speakCached(sessionId, parts[begin].text),
              fallback
            )
          if (spoken.reason && rememberedReasons.has(spoken.reason))
            unset.current.set(sessionId, { reason: spoken.reason, at: Date.now() })
          speakSystem(parts, begin, fallback, voiceWhy(spoken.reason))
        })
      }
      requestSpokenRendering(sessionId, spokenKeyOf(markdown), launch, markdown).then(speak, () =>
        speak(null)
      )
    },
    [synth, supported, systemVoice, audioVoice, note, release, speakCached]
  )
  const seekBlock = useCallback((n: number): void => {
    const run = active.current
    if (!run || run.mine !== generation.current) return
    if (!run.parts) {
      // Still preparing: the reading will start from this block.
      run.from = n
      setReading((now) => (now && now.key === run.key ? { ...now, block: n } : now))
      return
    }
    const at = partFor(run.parts, n)
    if (at >= 0) run.seek(at)
  }, [])
  const readFrom = useCallback(
    (key: string, markdown: string, n: number): void => {
      if (active.current?.key === key && active.current.mine === generation.current)
        return seekBlock(n)
      read(key, markdown, n)
    },
    [read, seekBlock]
  )
  const pause = useCallback((): void => {
    const run = active.current
    if (run?.parts && run.mine === generation.current) run.pause()
  }, [])
  const resume = useCallback((): void => {
    const run = active.current
    if (run?.parts && run.mine === generation.current) run.resume()
  }, [])
  // A view gone takes its voice with it, and only its own.
  useEffect(() => {
    const token = me.current
    const player = queue
    return () => {
      player.current?.stop()
      if (voiceOwner === token) {
        synth?.cancel()
        voiceOwner = null
        ownerStop = null
      }
    }
  }, [synth])
  return {
    supported,
    reading,
    fallbacks,
    notes,
    heardPages,
    heard,
    read,
    readFrom,
    pause,
    resume,
    seekBlock,
    stop
  }
}

/** One part spoken by the server the tab runs on. A call that fails is an
 *  answer: a bridge without the speech reads as a server that needs an
 *  update, a rejection as a server that did not answer. */
function speakPart(sessionId: string, text: string): Promise<SpeakResult> {
  const speakText = typeof window !== 'undefined' ? window.electronAPI?.speakText : undefined
  if (!speakText)
    return Promise.resolve({
      ok: false,
      error: 'This app cannot speak with ElevenLabs.',
      reason: 'outdated'
    })
  return speakText({ sessionId, text }).catch(
    (error: unknown): SpeakResult => ({ ok: false, error: String(error), reason: 'failed' })
  )
}
