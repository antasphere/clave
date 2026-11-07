import { describe, expect, it } from 'vitest'
import { CHUNK_MAX, speakable, speechChunks } from './speech'
import { LAB_VIEW } from './meta'

describe('speakable', () => {
  it('reads prose, not markdown', () => {
    expect(speakable('## Result\n\n- **one** thing\n- see [the docs](https://x.y)')).toBe(
      'Result. one thing. see the docs.'
    )
  })
  it('names a code block instead of reading it', () => {
    const spoken = speakable('Run this:\n\n```bash\nnpm test -- --run\n```\n\nThen look.')
    expect(spoken).toBe('Run this: (A code block.) Then look.')
  })
  it('says a bare address is a link and keeps inline code words', () => {
    expect(speakable('Open https://example.com/a?b=c and run `npm ci`.')).toBe(
      'Open a link and run npm ci.'
    )
  })
})

describe('speechChunks', () => {
  it('keeps short text as one utterance', () => {
    expect(speechChunks('One. Two? Three!')).toEqual(['One. Two? Three!'])
  })
  it('cuts between sentences, never past the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const chunks = speechChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= CHUNK_MAX)).toBe(true)
    expect(chunks.every((c) => c.endsWith('.'))).toBe(true)
    expect(chunks.join(' ')).toBe(text)
  })
  it('cuts a sentence too long by itself between words', () => {
    const long = `${'word '.repeat(120).trim()}.`
    const chunks = speechChunks(long, 50)
    expect(chunks.every((c) => c.length <= 50)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })
  it('has nothing to say for nothing', () => {
    expect(speechChunks('')).toEqual([])
  })
})

describe('the view it names', () => {
  it('has a title and one plain sentence for a newcomer', () => {
    expect(LAB_VIEW.title).toBe('Folio')
    expect(LAB_VIEW.tagline).toMatch(/^[A-Z][^]*\.$/)
  })
})
