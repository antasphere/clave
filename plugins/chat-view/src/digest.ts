import { useEffect, useState } from 'react'
import type { DigestLaunch, DigestMessage, DigestResult } from '../../../src/shared/exchange-digest'

/** How long a timeline must hold still before its digest is asked for: a
 *  burst of messages is read once, at its end, not once per message. */
export const DIGEST_SETTLE_MS = 2500

const STORE = 'clave.exchangeDigests'
const KEEP = 300

type Done = Extract<DigestResult, { ok: true }>

/** Digests already read, by the messages they read: kept across restarts, so
 *  a conversation reopened is not read again. Failures are not kept. */
const cache = new Map<string, Done>(load())
const inflight = new Map<string, Promise<DigestResult>>()

function load(): [string, Done][] {
  try {
    const raw = localStorage.getItem(STORE)
    return raw ? (Object.entries(JSON.parse(raw)) as [string, Done][]) : []
  } catch {
    return []
  }
}

function remember(key: string, result: Done): void {
  cache.set(key, result)
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string)
  try {
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(cache)))
  } catch {
    /* storage full or unavailable: the digest is still shown */
  }
}

/** A short stable key for a run of messages (FNV-1a over what the digest reads). */
export function digestKey(messages: readonly DigestMessage[]): string {
  const text = JSON.stringify(messages)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${messages.length}-${(hash >>> 0).toString(36)}`
}

export type DigestState =
  | { state: 'waiting' }
  | { state: 'reading' }
  | { state: 'done'; result: Done }
  | { state: 'failed' }

/**
 * The digest of a timeline's messages: read from the cache when these exact
 * messages were read before, otherwise asked of main once they have held
 * still for DIGEST_SETTLE_MS (`window.electronAPI.exchangeDigest`). A new
 * message starts the wait again; a timeline that unmounts before the wait is
 * over asks for nothing.
 */
export function useDigest(messages: readonly DigestMessage[], launch: DigestLaunch): DigestState {
  const key = digestKey(messages)
  const [state, setState] = useState<DigestState>(() => {
    const known = cache.get(key)
    return known ? { state: 'done', result: known } : { state: 'waiting' }
  })
  useEffect(() => {
    const known = cache.get(key)
    if (known) {
      setState({ state: 'done', result: known })
      return
    }
    setState({ state: 'waiting' })
    let live = true
    const timer = window.setTimeout(() => {
      const api = window.electronAPI?.exchangeDigest
      if (!api) {
        setState({ state: 'failed' })
        return
      }
      setState({ state: 'reading' })
      let ask = inflight.get(key)
      if (!ask) {
        ask = api({ launch, messages: [...messages] }).catch(
          (error: unknown): DigestResult => ({ ok: false, error: String(error) })
        )
        inflight.set(key, ask)
        void ask.then((result) => {
          inflight.delete(key)
          if (result.ok) remember(key, result)
        })
      }
      void ask.then((result) => {
        if (live) setState(result.ok ? { state: 'done', result } : { state: 'failed' })
      })
    }, DIGEST_SETTLE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
    // The key stands for the messages; the launch only says how to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}
