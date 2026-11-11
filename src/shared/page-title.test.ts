import { describe, expect, it } from 'vitest'
import { clipText } from './helper-prompt'
import {
  PAGE_TITLE_KEY_PATTERN,
  PAGE_TITLE_MARKER,
  PAGE_TITLE_MESSAGE_CHARS,
  pageTitleBucket,
  pageTitleKey,
  pageTitlePrompt,
  parsePageTitleReply
} from './page-title'

describe('pageTitlePrompt', () => {
  it('opens with the marker, the message as data clipped, the reply shape after', () => {
    const prompt = pageTitlePrompt(`Can you fix the build? ${'x'.repeat(3000)}`)
    expect(prompt.startsWith(PAGE_TITLE_MARKER)).toBe(true)
    const open = prompt.indexOf('<message>\n')
    const close = prompt.indexOf('\n</message>')
    expect(open).toBeGreaterThan(0)
    expect(close - open - '<message>\n'.length).toBe(PAGE_TITLE_MESSAGE_CHARS + 1)
    expect(prompt.slice(close)).toMatch(/Reply with the title alone/)
  })
})

describe('pageTitleKey', () => {
  it('is stable, differs on a changed word, and has the wire’s shape', () => {
    const a = pageTitleKey('Why does the build fail?')
    expect(pageTitleKey('Why does the build fail?')).toBe(a)
    expect(pageTitleKey('Why does the build pass?')).not.toBe(a)
    expect(a).toMatch(PAGE_TITLE_KEY_PATTERN)
    const clipped = clipText('y'.repeat(9000), PAGE_TITLE_MESSAGE_CHARS)
    expect(pageTitleKey(clipText(clipped, PAGE_TITLE_MESSAGE_CHARS))).toBe(pageTitleKey(clipped))
    expect(pageTitleBucket('s1')).toBe('s1:title')
  })
})

describe('parsePageTitleReply', () => {
  it('reads a sentence-case title, past a label, quotes, a stop and a footer', () => {
    expect(parsePageTitleReply('Why the staging build fails')).toEqual({
      ok: true,
      title: 'Why the staging build fails'
    })
    expect(parsePageTitleReply('Title: "The login redirect loop."\nNext: nothing.')).toEqual({
      ok: true,
      title: 'The login redirect loop'
    })
    expect(parsePageTitleReply('Page title:\n**Pourquoi le build échoue**')).toEqual({
      ok: true,
      title: 'Pourquoi le build échoue'
    })
  })

  it('refuses a reply that talks, runs long, or spans lines', () => {
    expect(parsePageTitleReply('I would fix the build by rerunning it')).toBeNull()
    expect(parsePageTitleReply('Sure, here is a title')).toBeNull()
    expect(
      parsePageTitleReply('One two three four five six seven eight nine ten eleven twelve thirteen')
    ).toBeNull()
    expect(parsePageTitleReply(`A ${'very '.repeat(14)}long title`)).toBeNull()
    expect(parsePageTitleReply('First line\nSecond line')).toBeNull()
    expect(parsePageTitleReply('')).toBeNull()
  })

  it('strips quotes only as a pair wrapping the whole title', () => {
    const read = (reply: string): string | undefined => parsePageTitleReply(reply)?.title
    expect(read('« Build » renommé')).toBe('« Build » renommé')
    expect(read('Le mot « fix »')).toBe('Le mot « fix »')
    expect(read('Renaming the "build"')).toBe('Renaming the "build"')
    expect(read("The users'")).toBe("The users'")
    expect(read('"Build" and "fix"')).toBe('"Build" and "fix"')
    expect(read('« Le build renommé »')).toBe('Le build renommé')
    expect(read('“Fix login”')).toBe('Fix login')
    expect(read('‘Fix login’')).toBe('Fix login')
    expect(read("'The user's page'")).toBe("The user's page")
    expect(read('`Fix login`')).toBe('Fix login')
    expect(read('"Fix login".')).toBe('Fix login')
  })

  it('reads a title past a label in bold, and out of its bold', () => {
    const read = (reply: string): string | undefined => parsePageTitleReply(reply)?.title
    expect(read('**Title:** Fix login')).toBe('Fix login')
    expect(read('**Title**: Fix login')).toBe('Fix login')
    expect(read('**Fix login**')).toBe('Fix login')
    expect(read('**Page title:** **Fix login**')).toBe('Fix login')
  })

  it('refuses a reply that talks in French', () => {
    for (const reply of [
      'Je voudrais corriger le build',
      "J'ai corrigé le build",
      'Nous corrigeons le build',
      'Voici un titre',
      'Il faut corriger le build',
      'Peux-tu corriger le build',
      'Pouvez-vous corriger le build',
      "D'accord, le build",
      'Bien sûr, le build'
    ])
      expect(parsePageTitleReply(reply), reply).toBeNull()
    // A title that merely begins with those letters is a title.
    expect(parsePageTitleReply('Jest config cleanup')?.title).toBe('Jest config cleanup')
  })
})
