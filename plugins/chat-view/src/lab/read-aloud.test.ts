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
  /** Every state the hook holds, in the order it asks for them: the first
   *  is the reading. */
  const holders: { value: unknown }[] = []
  return {
    cleanups,
    holders,
    react: {
      useState: <T>(initial: T | (() => T)) => {
        const holder = {
          value: (typeof initial === 'function' ? (initial as () => T)() : initial) as unknown
        }
        holders.push(holder)
        const set = (next: T | ((now: T) => T)): void => {
          holder.value =
            typeof next === 'function' ? (next as (now: T) => T)(holder.value as T) : next
        }
        return [holder.value as T, set] as const
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
    answer?.ok
      ? { text: answer.text, blocks: answer.blocks ?? [{ n: 0, text: answer.text }] }
      : {
          text: markdown,
          blocks: markdown.split('\n\n').map((text, i) => ({ n: i + 1, text })),
          fallback: 'missing'
        },
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
  h.holders.length = 0
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
  vi.restoreAllMocks()
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

  it('page 2 answers while page 1, read after it, still prepares: exactly one page speaks (round 3, M20)', async () => {
    // The voice holds every utterance (none ends by itself), so page 1's
    // reading keeps the voice the whole time: only the generation guard
    // can tell page 2's late rendering that it is no longer the reading.
    window.speechSynthesis.speak = (u: FakeUtterance) => void spoken.push(u.text)
    const voice = usePane()
    voice.read('page-2', 'Page two.')
    voice.read('page-1', 'Page one.')
    expect(h.asked.map((a) => a.markdown)).toEqual(['Page two.', 'Page one.'])
    // Page 2's rendering comes back first, while page 1 is still preparing.
    h.asked[0].answer({ ok: true, text: 'Page two spoken.' })
    await flush()
    h.asked[1].answer({ ok: true, text: 'Page one spoken.' })
    await flush()
    expect(spoken).toEqual(['Page one spoken.'])
    expect(speakCalls.map((c) => c.text)).toEqual(['Page one spoken.'])
  })

  it('page 1 read while page 2 waits on its first voice call: exactly one page speaks (round 3, M20)', async () => {
    window.speechSynthesis.speak = (u: FakeUtterance) => void spoken.push(u.text)
    // The server's first answer for page 2 is held until page 1 is read.
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const answer = speakAnswer
    speakAnswer = () =>
      (speakCalls.length === 1 ? held.then(answer) : answer()) as unknown as SpeakResult
    const voice = usePane()
    voice.read('page-2', 'Page two.')
    h.asked[0].answer({ ok: true, text: 'Page two spoken.' })
    await flush()
    expect(speakCalls.map((c) => c.text)).toEqual(['Page two spoken.'])
    voice.read('page-1', 'Page one.')
    h.asked[1].answer({ ok: true, text: 'Page one spoken.' })
    await flush()
    release!()
    await flush()
    expect(spoken).toEqual(['Page one spoken.'])
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

describe('the parts already spoken are kept for the pane (verifier round 3)', () => {
  /** The server's voice: every part answered, the element a fake that
   *  plays and never ends. */
  const elevenLabs = (): void => {
    speakAnswer = () => ({ ok: true, mime: 'audio/mpeg', audio: 'AAAA', characters: 4 })
    vi.stubGlobal(
      'Audio',
      class {
        src = ''
        currentTime = 0
        duration = Number.NaN
        onended = null
        onerror = null
        ontimeupdate = null
        ondurationchange = null
        play = (): Promise<void> => Promise.resolve()
        pause = (): void => undefined
      }
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:part')
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  }
  const PAGE = 'Block one.\n\nBlock two.\n\nBlock three.'

  it('Play after Stop asks the server for no part it answered before', async () => {
    elevenLabs()
    const voice = usePane()
    voice.read('page', PAGE)
    h.asked[0].answer(null)
    await flush()
    // Block one plays, block two is asked beside it.
    expect(speakCalls.map((c) => c.text)).toEqual(['Block one.', 'Block two.'])
    voice.stop()
    voice.read('page', PAGE)
    h.asked[1].answer(null)
    await flush()
    expect(speakCalls).toHaveLength(2)
    // A seek to block three asks for it alone; a seek back asks nothing.
    voice.seekBlock(3)
    await flush()
    voice.seekBlock(1)
    await flush()
    expect(speakCalls.map((c) => c.text)).toEqual(['Block one.', 'Block two.', 'Block three.'])
  })

  it('a voice chosen on the Integrations page asks again', async () => {
    elevenLabs()
    const voice = usePane()
    voice.read('page', PAGE)
    h.asked[0].answer(null)
    await flush()
    voice.stop()
    useIntegrationsStore.setState({
      byMachine: {
        local: {
          status: 'ready',
          error: null,
          elevenLabs: { configured: true, voiceId: 'other' } as never,
          busy: false,
          voices: { status: 'idle', error: null, voices: [] }
        }
      }
    })
    voice.read('page', PAGE)
    h.asked[1].answer(null)
    await flush()
    expect(speakCalls.map((c) => c.text)).toEqual([
      'Block one.',
      'Block two.',
      'Block one.',
      'Block two.'
    ])
  })
})

/** A system voice the test drives: each utterance waits until the test
 *  starts and ends it; cancel, pause and resume are counted. */
function drivenVoice(): {
  queued: FakeUtterance[]
  calls: string[]
} {
  const queued: FakeUtterance[] = []
  const calls: string[] = []
  ;(window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    speak: (u: FakeUtterance) => {
      spoken.push(u.text)
      queued.push(u)
    },
    cancel: () => calls.push('cancel'),
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume')
  }
  return { queued, calls }
}

describe('the player on the system voice (PRDCT-4430)', () => {
  const blocks = [
    { n: 1, text: 'One.' },
    { n: 2, text: 'Two.' },
    { n: 3, text: 'Three.' }
  ]
  const reading = (): Record<string, unknown> | null =>
    h.holders[0].value as Record<string, unknown> | null

  it('speaks each block as its own run, the reading on the block whose utterance started', async () => {
    const v = drivenVoice()
    const voice = usePane()
    voice.read('p', 'One\n\nTwo\n\nThree')
    expect(reading()).toMatchObject({ state: 'preparing', block: null })
    h.asked[0].answer({ ok: true, text: 'One.\n\nTwo.\n\nThree.', blocks })
    await flush()
    expect(spoken).toEqual(['One.', 'Two.', 'Three.'])
    expect(reading()).toMatchObject({ state: 'playing', block: 1, blocks: 3, ticks: [1, 2, 3] })
    v.queued[1].onstart?.()
    expect(reading()).toMatchObject({ block: 2, tick: 1 })
    v.queued[1].onend?.()
    v.queued[2].onstart?.()
    expect(reading()).toMatchObject({ block: 3, tick: 2 })
    v.queued[2].onend?.()
    expect(reading()).toBeNull()
  })

  it('pause and resume go through the system voice and the reading says so', async () => {
    const v = drivenVoice()
    const voice = usePane()
    voice.read('p', 'x')
    h.asked[0].answer({ ok: true, text: 'x', blocks })
    await flush()
    voice.pause()
    expect(v.calls.at(-1)).toBe('pause')
    expect(reading()).toMatchObject({ state: 'paused', phase: 'speaking' })
    voice.resume()
    expect(v.calls.at(-1)).toBe('resume')
    expect(reading()).toMatchObject({ state: 'playing' })
  })

  it('a seek cancels and speaks again from the block; the old run ends nothing', async () => {
    const v = drivenVoice()
    const voice = usePane()
    voice.read('p', 'x')
    h.asked[0].answer({ ok: true, text: 'x', blocks })
    await flush()
    const before = v.queued.length
    voice.seekBlock(3)
    expect(v.calls.at(-1)).toBe('cancel')
    expect(spoken.slice(before)).toEqual(['Three.'])
    expect(reading()).toMatchObject({ block: 3 })
    // The cancelled run's last utterance ends late: the reading goes on.
    v.queued[before - 1].onend?.()
    expect(reading()).not.toBeNull()
    v.queued.at(-1)!.onend?.()
    expect(reading()).toBeNull()
  })

  it('a block clicked while the page prepares is where the reading starts, and the first voice call', async () => {
    drivenVoice()
    const voice = usePane()
    voice.readFrom('p', 'x', 2)
    expect(reading()).toMatchObject({ state: 'preparing', block: 2 })
    // A second click while preparing moves the start, asking nothing new.
    voice.readFrom('p', 'x', 3)
    expect(h.asked).toHaveLength(1)
    expect(reading()).toMatchObject({ block: 3 })
    h.asked[0].answer({ ok: true, text: 'x', blocks })
    await flush()
    expect(speakCalls.map((c) => c.text)).toEqual(['Three.'])
    expect(spoken).toEqual(['Three.'])
    expect(reading()).toMatchObject({ block: 3, tick: 2 })
  })

  it('a rendering without blocks plays as one block and lights nothing', async () => {
    drivenVoice()
    const voice = usePane()
    voice.read('p', 'x')
    h.asked[0].answer({ ok: true, text: 'Old rendering.' })
    await flush()
    expect(spoken).toEqual(['Old rendering.'])
    expect(reading()).toMatchObject({ block: null, blocks: 1, ticks: [0] })
    // A click on a block of such a page restarts from its only part.
    voice.seekBlock(2)
    expect(spoken).toEqual(['Old rendering.'])
    voice.seekBlock(0)
    expect(spoken).toEqual(['Old rendering.', 'Old rendering.'])
  })
})
