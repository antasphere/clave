import { useCallback, useEffect, useRef, useState } from 'react'
import { speakable, speechChunks } from './speech'

/** What is being read, and how far: the page's key and the utterance at. */
export interface Reading {
  key: string
  at: number
  of: number
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
 *  synthesis, offline on macOS). One reading at a time across the app: a
 *  new one cancels whatever was being read, ours or another pane's. */
export function useReadAloud(): {
  supported: boolean
  reading: Reading | null
  read: (key: string, markdown: string) => void
  stop: () => void
} {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  const supported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined'
  const [reading, setReading] = useState<Reading | null>(null)
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
      const chunks = speechChunks(speakable(markdown))
      if (!chunks.length) return setReading(null)
      voiceOwner = me.current
      setReading({ key, at: 0, of: chunks.length })
      chunks.forEach((chunk, at) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        utterance.lang = document.documentElement.lang || navigator.language
        utterance.rate = 1.04
        utterance.onstart = () => {
          if (generation.current === mine) setReading({ key, at, of: chunks.length })
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
  return { supported, reading, read, stop }
}
