import { useCallback, useEffect, useRef, useState } from 'react'
import type { DigestLaunch } from '../../../../src/shared/exchange-digest'
import type { DigestFailure } from '../digest'
import { speechChunks } from './speech'
import { requestSpokenRendering, spokenKeyOf, spokenSource, type SpokenAnswer } from './spoken'

/** What is being read, and how far: the page's key and the utterance at.
 *  `preparing` while the spoken rendering is asked (`spoken.ts`), then
 *  `speaking`; `fallback` says why the page is read as written. */
export interface Reading {
  key: string
  at: number
  of: number
  phase: 'preparing' | 'speaking'
  fallback?: DigestFailure | 'missing'
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

/** Whose reading the one system voice is speaking: a pane's own token, so a
 *  pane cancels the voice only while the reading is its own, never another
 *  pane's that took the voice over. */
let voiceOwner: symbol | null = null

/** The page read aloud through the system's own voice (the Web Speech API's
 *  synthesis, offline on macOS), from its spoken rendering when one can be
 *  had, as written when not. One reading at a time across the app: a new
 *  one cancels whatever was being read, ours or another pane's. */
export function useReadAloud(source: ReadSource): {
  supported: boolean
  reading: Reading | null
  /** The pages last read as written, and why: the control says it on hover. */
  fallbacks: Record<string, DigestFailure | 'missing'>
  read: (key: string, markdown: string) => void
  stop: () => void
} {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const supported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined'
  const [reading, setReading] = useState<Reading | null>(null)
  const [fallbacks, setFallbacks] = useState<Record<string, DigestFailure | 'missing'>>({})
  const from = useRef(source)
  from.current = source
  // The generation of the reading in flight: an utterance of a cancelled one
  // still fires its end, and must not move the new one along.
  const generation = useRef(0)
  // This pane's token: the voice is ours while `voiceOwner` is it.
  const me = useRef<symbol>(Symbol('folio-voice'))
  const stop = useCallback((): void => {
    generation.current += 1
    if (voiceOwner === me.current) {
      synth?.cancel()
      voiceOwner = null
    }
    setReading(null)
  }, [synth])
  const read = useCallback(
    (key: string, markdown: string): void => {
      if (!synth || !supported) return
      synth.cancel()
      const mine = ++generation.current
      voiceOwner = me.current
      setReading({ key, at: 0, of: 0, phase: 'preparing' })
      const { sessionId, launch } = from.current
      const speak = (answer: SpokenAnswer | null): void => {
        // Stopped, or another reading began, while the rendering was asked.
        if (generation.current !== mine) return
        // Another pane began a reading since: the voice is the newer one's.
        if (voiceOwner !== me.current) return setReading(null)
        const { text, fallback } = spokenSource(answer, markdown)
        setFallbacks((now) => {
          if (now[key] === fallback) return now
          const next = { ...now }
          if (fallback) next[key] = fallback
          else delete next[key]
          return next
        })
        const chunks = speechChunks(text)
        if (!chunks.length) {
          if (voiceOwner === me.current) voiceOwner = null
          return setReading(null)
        }
        const at0: Reading = { key, at: 0, of: chunks.length, phase: 'speaking' }
        setReading(fallback ? { ...at0, fallback } : at0)
        chunks.forEach((chunk, at) => {
          const utterance = new SpeechSynthesisUtterance(chunk)
          utterance.lang = document.documentElement.lang || navigator.language
          utterance.rate = 1.04
          utterance.onstart = () => {
            if (generation.current !== mine) return
            const now: Reading = { key, at, of: chunks.length, phase: 'speaking' }
            setReading(fallback ? { ...now, fallback } : now)
          }
          const end = (): void => {
            if (generation.current !== mine || at !== chunks.length - 1) return
            if (voiceOwner === me.current) voiceOwner = null
            setReading(null)
          }
          utterance.onend = end
          utterance.onerror = end
          synth.speak(utterance)
        })
      }
      requestSpokenRendering(sessionId, spokenKeyOf(markdown), launch, markdown).then(speak, () =>
        speak(null)
      )
    },
    [synth, supported]
  )
  // A view gone takes its voice with it, and only its own.
  useEffect(() => {
    const token = me.current
    return () => {
      if (voiceOwner === token) {
        synth?.cancel()
        voiceOwner = null
      }
    }
  }, [synth])
  return { supported, reading, fallbacks, read, stop }
}
