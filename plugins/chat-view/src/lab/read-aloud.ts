import { useCallback, useEffect, useRef, useState } from 'react'
import type { DigestLaunch } from '../../../../src/shared/exchange-digest'
import type { SpeakResult, SpeechFailureReason } from '../../../../src/shared/speech'
import type { DigestFailure } from '../digest'
import { AudioQueue, speechParts } from './audio'
import { speechChunks } from './speech'
import { requestSpokenRendering, spokenKeyOf, spokenSource, type SpokenAnswer } from './spoken'

/** What is being read, and how far: the page's key and the part at.
 *  `preparing` while the spoken rendering is asked (`spoken.ts`) and the
 *  first part of the voice, then `speaking`; `fallback` says why the page is
 *  read as written; `voice` which voice reads it, and `why` the system voice
 *  reads it rather than the server's ElevenLabs voice. */
export interface Reading {
  key: string
  at: number
  of: number
  phase: 'preparing' | 'speaking'
  fallback?: DigestFailure | 'missing'
  voice?: 'elevenlabs' | 'system'
  why?: string
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

/** What the control says once a page was read by the system voice, or once
 *  the ElevenLabs voice stopped part way. Pure. */
export function voiceNote(why: VoiceWhy, stopped = false): string {
  if (stopped) return `ElevenLabs stopped: ${why.words}`
  return why.kind === 'unset'
    ? `System voice: ${why.words}`
    : `Read with the system voice: ${why.words}`
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
  read: (key: string, markdown: string) => void
  stop: () => void
} {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const systemVoice = !!synth && typeof SpeechSynthesisUtterance !== 'undefined'
  const audioVoice = typeof Audio !== 'undefined' && typeof URL?.createObjectURL === 'function'
  const supported = systemVoice || audioVoice
  const [reading, setReading] = useState<Reading | null>(null)
  const [fallbacks, setFallbacks] = useState<Record<string, DigestFailure | 'missing'>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const from = useRef(source)
  from.current = source
  // The generation of the reading in flight: an utterance or a part of a
  // cancelled one still fires its end, and must not move the new one along.
  const generation = useRef(0)
  // This pane's token: the voice is ours while `voiceOwner` is it.
  const me = useRef<symbol>(Symbol('folio-voice'))
  const queue = useRef<AudioQueue | null>(null)
  // The tabs whose server said it has no ElevenLabs, for the pane's life: a
  // server without a key is not asked again on every page.
  const unset = useRef(new Map<string, SpeechFailureReason>())

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
    queue.current?.stop()
    if (voiceOwner === me.current) synth?.cancel()
    release()
    setReading(null)
  }, [synth, release])
  const stopRef = useRef(stop)
  stopRef.current = stop

  const read = useCallback(
    (key: string, markdown: string): void => {
      if (!supported) return
      // Whatever another pane was reading stops first: one voice at a time.
      if (voiceOwner && voiceOwner !== me.current) ownerStop?.()
      synth?.cancel()
      queue.current?.stop()
      const mine = ++generation.current
      voiceOwner = me.current
      ownerStop = () => stopRef.current()
      setReading({ key, at: 0, of: 0, phase: 'preparing' })
      const { sessionId, launch } = from.current
      /** Still this reading, and still ours to speak. */
      const current = (): boolean => {
        if (generation.current !== mine) return false
        if (voiceOwner === me.current) return true
        setReading(null)
        return false
      }
      const done = (): void => {
        release()
        setReading(null)
      }

      const speakSystem = (
        text: string,
        fallback: DigestFailure | 'missing' | undefined,
        why: VoiceWhy
      ): void => {
        note(key, voiceNote(why))
        const chunks = speechChunks(text)
        if (!chunks.length || !synth || !systemVoice) return done()
        const at = (n: number): Reading => ({
          key,
          at: n,
          of: chunks.length,
          phase: 'speaking',
          voice: 'system',
          why: why.words,
          ...(fallback && { fallback })
        })
        setReading(at(0))
        chunks.forEach((chunk, n) => {
          const utterance = new SpeechSynthesisUtterance(chunk)
          utterance.lang = document.documentElement.lang || navigator.language
          utterance.rate = 1.04
          utterance.onstart = () => {
            if (generation.current === mine) setReading(at(n))
          }
          const end = (): void => {
            if (generation.current !== mine || n !== chunks.length - 1) return
            done()
          }
          utterance.onend = end
          utterance.onerror = end
          synth.speak(utterance)
        })
      }

      const speakElevenLabs = (
        parts: string[],
        first: Promise<SpeakResult>,
        fallback: DigestFailure | 'missing' | undefined
      ): void => {
        note(key, null)
        const at = (n: number): Reading => ({
          key,
          at: n,
          of: parts.length,
          phase: 'speaking',
          voice: 'elevenlabs',
          ...(fallback && { fallback })
        })
        const player = (queue.current ??= new AudioQueue())
        player.play({
          parts,
          first,
          source: (text) => speakPart(sessionId, text),
          onProgress: (n) => {
            if (generation.current === mine) setReading(at(n))
          },
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
        const { text, fallback } = spokenSource(answer, markdown)
        setFallbacks((now) => {
          if (now[key] === fallback) return now
          const next = { ...now }
          if (fallback) next[key] = fallback
          else delete next[key]
          return next
        })
        const remembered = unset.current.get(sessionId)
        if (remembered) return speakSystem(text, fallback, voiceWhy(remembered))
        const parts = speechParts(text)
        if (!parts.length) return done()
        if (!audioVoice)
          return speakSystem(text, fallback, { kind: 'unset', words: 'this app plays no audio' })
        // The first part decides the voice: ElevenLabs when the server speaks
        // it, the system voice (and why) when it cannot.
        const first = speakPart(sessionId, parts[0])
        void first.then((spoken) => {
          if (!current()) return
          if (spoken.ok) return speakElevenLabs(parts, first, fallback)
          if (spoken.reason === 'no-integration') unset.current.set(sessionId, spoken.reason)
          speakSystem(text, fallback, voiceWhy(spoken.reason))
        })
      }
      requestSpokenRendering(sessionId, spokenKeyOf(markdown), launch, markdown).then(speak, () =>
        speak(null)
      )
    },
    [synth, supported, systemVoice, audioVoice, note, release]
  )
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
  return { supported, reading, fallbacks, notes, read, stop }
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
