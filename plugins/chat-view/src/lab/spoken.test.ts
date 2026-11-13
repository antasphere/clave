import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spokenKey, SPOKEN_MAX_CHARS } from '../../../../src/shared/spoken-rendering'
import {
  fallbackLine,
  requestSpokenRendering,
  resetSpoken,
  spokenKeyOf,
  spokenSource,
  useSpokenStore
} from './spoken'

/* The spoken rendering on the view's side (PRDCT-4409): asked on demand,
   shared while it is going, found at once once filed, and a failure that
   says why the page was read as written. */

type Api = {
  spokenRendering?: ReturnType<typeof vi.fn>
  spokenRenderingsOf?: ReturnType<typeof vi.fn>
}
const install = (api: Api): void => {
  ;(globalThis as unknown as { window: { electronAPI: Api } }).window = { electronAPI: api }
}
const stateOf = (key: string): unknown => useSpokenStore.getState().states[`s|${key}`]

beforeEach(() => resetSpoken())
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('requestSpokenRendering', () => {
  it('asks once for a page however often it is asked while going, then answers from the store', async () => {
    let answer!: (value: unknown) => void
    const spokenRendering = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    install({ spokenRendering, spokenRenderingsOf: vi.fn(async () => ({})) })
    const first = requestSpokenRendering('s', 'k', {}, '# Hi')
    const second = requestSpokenRendering('s', 'k', {}, '# Hi')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(stateOf('k')).toEqual({ state: 'preparing' }))
    answer({ ok: true, text: 'Hi there.' })
    await expect(first).resolves.toEqual({ ok: true, text: 'Hi there.' })
    expect(stateOf('k')).toEqual({ state: 'ready', text: 'Hi there.' })
    await expect(requestSpokenRendering('s', 'k', {}, '# Hi')).resolves.toEqual({
      ok: true,
      text: 'Hi there.'
    })
    expect(spokenRendering).toHaveBeenCalledTimes(1)
    expect(spokenRendering).toHaveBeenCalledWith({
      sessionId: 's',
      key: 'k',
      launch: {},
      markdown: '# Hi'
    })
  })

  it('sends a long answer clipped as it is keyed', async () => {
    const spokenRendering = vi.fn(async () => ({ ok: true, text: 'Long.' }))
    install({ spokenRendering, spokenRenderingsOf: vi.fn(async () => ({})) })
    const markdown = 'x'.repeat(63_000)
    await requestSpokenRendering('s', spokenKeyOf(markdown), {}, markdown)
    const sent = (spokenRendering.mock.calls[0] as unknown as [{ markdown: string }])[0].markdown
    expect(sent).toHaveLength(SPOKEN_MAX_CHARS + 1)
    expect(spokenKey(sent)).toBe(spokenKeyOf(markdown))
  })

  it('speaks a page read before at once: the filed renderings are loaded once per tab', async () => {
    const spokenRendering = vi.fn()
    const spokenRenderingsOf = vi.fn(async () => ({ k: { ok: true, text: 'Filed.' } }))
    install({ spokenRendering, spokenRenderingsOf })
    await expect(requestSpokenRendering('s', 'k', {}, 'x')).resolves.toEqual({
      ok: true,
      text: 'Filed.'
    })
    await requestSpokenRendering('s', 'other', {}, 'y').catch(() => {})
    expect(spokenRenderingsOf).toHaveBeenCalledTimes(1)
    expect(spokenRendering).toHaveBeenCalledTimes(1)
  })

  it('keeps the reason of a failure, and a rejection reads as the server not answering', async () => {
    install({
      spokenRendering: vi.fn(async () => ({ ok: false, error: 'off', reason: 'disabled' })),
      spokenRenderingsOf: vi.fn(async () => ({}))
    })
    await expect(requestSpokenRendering('s', 'a', {}, 'x')).resolves.toMatchObject({
      ok: false,
      reason: 'disabled'
    })
    expect(stateOf('a')).toEqual({ state: 'failed', reason: 'disabled' })
    install({
      spokenRendering: vi.fn(() => Promise.reject(new Error('gone'))),
      spokenRenderingsOf: vi.fn(async () => ({}))
    })
    await expect(requestSpokenRendering('s', 'b', {}, 'x')).resolves.toMatchObject({
      ok: false,
      reason: 'unanswered'
    })
  })

  it('does not ask again what asking again cannot mend, and does ask a passing failure', async () => {
    const spokenRendering = vi.fn(async () => ({ ok: false, error: 'off', reason: 'disabled' }))
    install({ spokenRendering, spokenRenderingsOf: vi.fn(async () => ({})) })
    await requestSpokenRendering('s', 'a', {}, 'x')
    await requestSpokenRendering('s', 'a', {}, 'x')
    expect(spokenRendering).toHaveBeenCalledTimes(1)
    spokenRendering.mockImplementation(async () => ({ ok: false, error: 'x', reason: 'timeout' }))
    await requestSpokenRendering('s', 'b', {}, 'x')
    await requestSpokenRendering('s', 'b', {}, 'x')
    expect(spokenRendering).toHaveBeenCalledTimes(3)
  })

  it('fails without a call when the app has no way to ask', async () => {
    install({})
    await expect(requestSpokenRendering('s', 'k', {}, 'x')).resolves.toMatchObject({ ok: false })
  })
})

describe('what a reading speaks', () => {
  it('the rendering when there is one, the page as written with why when not', () => {
    expect(spokenSource({ ok: true, text: 'Two things changed.' }, '- **a**\n- b')).toEqual({
      text: 'Two things changed.',
      blocks: [{ n: 0, text: 'Two things changed.' }]
    })
    expect(spokenSource({ ok: false, error: 'x', reason: 'limit' }, '- **a**\n- b')).toEqual({
      text: 'a. b.',
      blocks: [{ n: 1, text: 'a. b.' }],
      fallback: 'limit'
    })
    expect(spokenSource({ ok: false, error: 'x' }, 'Plain.')).toEqual({
      text: 'Plain.',
      blocks: [{ n: 1, text: 'Plain.' }],
      fallback: 'failed'
    })
    expect(spokenSource(null, 'Plain.')).toEqual({
      text: 'Plain.',
      blocks: [{ n: 1, text: 'Plain.' }],
      fallback: 'missing'
    })
    // An empty rendering is no rendering.
    expect(spokenSource({ ok: true, text: '  ' }, 'Plain.').fallback).toBe('missing')
  })

  it('speaks a rendering block by block, and a page read as written by its own blocks (PRDCT-4430)', () => {
    expect(
      spokenSource(
        {
          ok: true,
          text: 'One.\n\nTwo.',
          blocks: [
            { n: 1, text: 'One.' },
            { n: 2, text: '**Two.**' }
          ]
        },
        '# One\n\nTwo'
      ).blocks
    ).toEqual([
      { n: 1, text: 'One.' },
      { n: 2, text: 'Two.' }
    ])
    expect(spokenSource(null, '# Head\n\nBody here\n\n```sh\nls\n```').blocks).toEqual([
      { n: 1, text: 'Head.' },
      { n: 2, text: 'Body here.' },
      { n: 3, text: '(A code block.)' }
    ])
  })

  it('keeps a rendering’s blocks in the store, filed or asked', async () => {
    const blocks = [
      { n: 1, text: 'A.' },
      { n: 2, text: 'B.' }
    ]
    install({
      spokenRendering: vi.fn(async () => ({ ok: true, text: 'A.\n\nB.', blocks })),
      spokenRenderingsOf: vi.fn(async () => ({ old: { ok: true, text: 'Old.' } }))
    })
    await expect(requestSpokenRendering('s', 'k', {}, 'A\n\nB')).resolves.toEqual({
      ok: true,
      text: 'A.\n\nB.',
      blocks
    })
    expect(stateOf('k')).toEqual({ state: 'ready', text: 'A.\n\nB.', blocks })
    expect(stateOf('old')).toEqual({ state: 'ready', text: 'Old.' })
    await expect(requestSpokenRendering('s', 'k', {}, 'A\n\nB')).resolves.toEqual({
      ok: true,
      text: 'A.\n\nB.',
      blocks
    })
  })

  it('says why a page was read as written, in the digests’ words', () => {
    expect(fallbackLine('limit')).toBe('Read as written: this account is at its limit.')
    expect(fallbackLine('disabled')).toBe(
      'Read as written: spoken versions are switched off in Settings.'
    )
    expect(fallbackLine('unanswered')).toBe('Read as written: the server did not answer.')
  })

  it('keys the markdown as the host does, clipped first', () => {
    const long = 'a'.repeat(SPOKEN_MAX_CHARS + 50)
    expect(spokenKeyOf('short')).toBe(spokenKey('short'))
    expect(spokenKeyOf(long)).toBe(spokenKeyOf(`${long}more`))
  })
})
