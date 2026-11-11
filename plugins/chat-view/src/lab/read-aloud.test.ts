import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeakResult } from '../../../../src/shared/speech'
import type { SpokenAnswer } from './spoken'

// The read control's hook (PRDCT-4411) run without a DOM, the way the
// plugin's other hook tests run theirs: React is a one-render shim (the
// hook is called once; its state setters record, its effects run at once),
// the spoken rendering is asked of a fake whose answers the test holds, the
// system voice is a fake `speechSynthesis`, and the server's speech a fake
// `speakText`. What is pinned is what the reader hears.

const h = vi.hoisted(() => {
  const cleanups: (() => void)[] = []
  return {
    cleanups,
    react: {
      useState: <T>(initial: T | (() => T)) => {
        let value = typeof initial === 'function' ? (initial as () => T)() : initial
        const set = (next: T | ((now: T) => T)): void => {
          value = typeof next === 'function' ? (next as (now: T) => T)(value) : next
        }
        return [value, set] as const
      },
      useRef: <T>(current: T) => ({ current }),
      useCallback: <T>(fn: T) => fn,
      useEffect: (effect: () => void | (() => void)) => {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
    /** The spoken renderings asked, each answered when the test says. */
    asked: [] as { markdown: string; answer: (a: SpokenAnswer | null) => void }[]
  }
})
vi.mock('react', () => ({ ...h.react, default: h.react }))
vi.mock('./spoken', () => ({
  spokenKeyOf: (markdown: string) => `key-${markdown.length}`,
  spokenSource: (answer: SpokenAnswer | null, markdown: string) =>
    answer?.ok ? { text: answer.text } : { text: markdown, fallback: 'missing' },
  requestSpokenRendering: (_s: string, _k: string, _l: unknown, markdown: string) =>
    new Promise<SpokenAnswer | null>((resolve) => h.asked.push({ markdown, answer: resolve }))
}))

import { useIntegrationsStore } from '../../../../src/renderer/src/store/integrations-store'
import {
  NO_VOICE_MEMORY_MS,
  integrationsChanged,
  rememberedVoiceReason,
  useReadAloud
} from './read-aloud'

let spoken: string[]
let speakCalls: { sessionId: string; text: string }[]
let speakAnswer: () => SpeakResult

class FakeUtterance {
  lang = ''
  rate = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public text: string) {}
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  spoken = []
  speakCalls = []
  h.asked.length = 0
  speakAnswer = () => ({ ok: false, error: 'none', reason: 'no-integration' })
  vi.stubGlobal('window', {
    speechSynthesis: {
      speak: (u: FakeUtterance) => {
        spoken.push(u.text)
        // The voice ends each utterance once spoken.
        setTimeout(() => u.onend?.(), 0)
      },
      cancel: () => undefined
    },
    electronAPI: {
      speakText: async (request: { sessionId: string; text: string }) => {
        speakCalls.push(request)
        return speakAnswer()
      }
    }
  })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('Audio', class {})
  vi.stubGlobal('document', { documentElement: { lang: 'en' } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
})
afterEach(() => {
  for (const cleanup of h.cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useIntegrationsStore.setState({ byMachine: {} })
})

const usePane = (): ReturnType<typeof useReadAloud> =>
  useReadAloud({ sessionId: 's1', launch: {} as never })

describe('one page spoken at a time (verifier rounds 1 and 2, M20)', () => {
  it('page 1 read while page 2 is still preparing: only page 1 is spoken', async () => {
    const voice = usePane()
    voice.read('page-2', 'Page two.')
    expect(h.asked).toHaveLength(1)
    voice.read('page-1', 'Page one.')
    expect(h.asked).toHaveLength(2)
    // Page 1's rendering comes back first, then page 2's, late.
    h.asked[1].answer({ ok: true, text: 'Page one spoken.' })
    await flush()
    h.asked[0].answer({ ok: true, text: 'Page two spoken.' })
    await flush()
    expect(spoken).toEqual(['Page one spoken.'])
    expect(speakCalls.map((c) => c.text)).toEqual(['Page one spoken.'])
  })

  it('a stop while the page prepares speaks nothing', async () => {
    const voice = usePane()
    voice.read('page-1', 'Page one.')
    voice.stop()
    h.asked[0].answer({ ok: true, text: 'Page one spoken.' })
    await flush()
    expect(spoken).toEqual([])
    expect(speakCalls).toEqual([])
  })
})

describe('the "no ElevenLabs" memory (verifier round 2, R02)', () => {
  it('holds for NO_VOICE_MEMORY_MS, then lets go', () => {
    expect(NO_VOICE_MEMORY_MS).toBe(30_000)
    const memory = { reason: 'no-integration' as const, at: 1_000 }
    expect(rememberedVoiceReason(undefined, 1_000)).toBeNull()
    expect(rememberedVoiceReason(memory, 1_000)).toBe('no-integration')
    expect(rememberedVoiceReason(memory, 1_000 + NO_VOICE_MEMORY_MS - 1)).toBe('no-integration')
    expect(rememberedVoiceReason(memory, 1_000 + NO_VOICE_MEMORY_MS)).toBeNull()
    // A clock set back is not trusted to keep it.
    expect(rememberedVoiceReason(memory, 0)).toBeNull()
  })

  it('a change of any machine’s ElevenLabs status is a change; a voices load is not', () => {
    const machine = {
      status: 'ready' as const,
      error: null,
      elevenLabs: null,
      busy: false,
      voices: { status: 'idle' as const, error: null, voices: [] }
    }
    const before = { local: machine }
    expect(integrationsChanged(before, before)).toBe(false)
    expect(integrationsChanged(before, { local: { ...machine, busy: true } })).toBe(false)
    expect(
      integrationsChanged(before, {
        local: { ...machine, elevenLabs: { configured: true } as never }
      })
    ).toBe(true)
  })

  const readPage = async (voice: ReturnType<typeof useReadAloud>, text: string): Promise<void> => {
    voice.read(text, text)
    h.asked.at(-1)!.answer({ ok: true, text })
    await flush()
  }

  it('a server without ElevenLabs is not asked again within the memory, and asked again after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const voice = usePane()
    await readPage(voice, 'One.')
    expect(speakCalls).toHaveLength(1)
    expect(spoken).toEqual(['One.'])
    await readPage(voice, 'Two.')
    expect(speakCalls).toHaveLength(1)
    expect(spoken).toEqual(['One.', 'Two.'])
    // A key pasted on another machine's page meanwhile: past the memory,
    // the next page asks the server again.
    vi.setSystemTime(1_000_000 + NO_VOICE_MEMORY_MS + 1)
    await readPage(voice, 'Three.')
    expect(speakCalls.map((c) => c.text)).toEqual(['One.', 'Three.'])
  })

  it('"no voice" is remembered the same way', async () => {
    speakAnswer = () => ({ ok: false, error: 'none', reason: 'no-voice' })
    const voice = usePane()
    await readPage(voice, 'One.')
    await readPage(voice, 'Two.')
    expect(speakCalls).toHaveLength(1)
  })

  it('a key saved on the Integrations page drops the memory at once', async () => {
    const voice = usePane()
    await readPage(voice, 'One.')
    expect(speakCalls).toHaveLength(1)
    useIntegrationsStore.setState({
      byMachine: {
        local: {
          status: 'ready',
          error: null,
          elevenLabs: { configured: true } as never,
          busy: false,
          voices: { status: 'idle', error: null, voices: [] }
        }
      }
    })
    await readPage(voice, 'Two.')
    expect(speakCalls).toHaveLength(2)
  })
})
