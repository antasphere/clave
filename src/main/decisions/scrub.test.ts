import { describe, expect, it } from 'vitest'
import { clip, scrubPaths, scrubText } from './scrub'

// What a decision sends is scrubbed and clipped (PRDCT-5179): each rule of
// the measurement kit, ported, and a text that holds them all at once. Every
// path, address and token here is invented.

const context = { workspaceRoot: '/Users/ada/w', home: '/Users/ada' }

describe('clip', () => {
  it('collapses whitespace and cuts with a final ellipsis, the ellipsis counted', () => {
    expect(clip('  a\n\n b\tc  ', 10)).toBe('a b c')
    expect(clip('abcdefghij', 10)).toBe('abcdefghij')
    const cut = clip('abcdefghijk', 10)
    expect(cut).toBe('abcdefghi…')
    expect(cut.length).toBe(10)
  })
})

describe('scrubText', () => {
  it('makes a path inside the workspace relative to it, the root itself a dot', () => {
    expect(scrubPaths('open /Users/ada/w/labs/quill/src/a.ts now', context)).toBe(
      'open labs/quill/src/a.ts now'
    )
    expect(scrubPaths('cd /Users/ada/w && ls', context)).toBe('cd . && ls')
    expect(scrubPaths('see /Users/ada/w/atlas.', context)).toBe('see atlas.')
  })

  it('leaves a folder that only starts like the workspace to the home rule', () => {
    expect(scrubPaths('/Users/ada/work/x', context)).toBe('~/work/x')
  })

  it('takes the home off any other path under a home folder, any person', () => {
    expect(scrubPaths('/Users/ada/notes/todo.md', context)).toBe('~/notes/todo.md')
    expect(scrubPaths('/home/lumen/.config/x', context)).toBe('~/.config/x')
    expect(scrubPaths('/Users/bob', context)).toBe('~')
    expect(scrubPaths('/opt/tools/bin', context)).toBe('/opt/tools/bin')
  })

  it('replaces a JWT and a token-like run', () => {
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'
    expect(scrubText(`bearer ${jwt}`, context)).toBe('bearer <token>')
    expect(scrubText('key sk-quillTESTKEY0123456789', context)).toBe('key <token>')
    expect(scrubText('id ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123 end', context)).toBe('id <token> end')
    // A long folder name inside a path is a path, not a token.
    expect(scrubText('labs/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123/x', context)).toBe(
      'labs/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123/x'
    )
  })

  it('replaces an e-mail address', () => {
    expect(scrubText('write to ada.quill+x@atlas.example.org please', context)).toBe(
      'write to <email> please'
    )
  })

  it('keeps a link to its scheme and host', () => {
    expect(scrubText('see https://atlas.example.com/a/b?c=d#e and', context)).toBe(
      'see https://atlas.example.com/… and'
    )
    // The path of a link is never taken for the workspace's.
    expect(scrubText('http://lumen.test/Users/ada/w/x', context)).toBe('http://lumen.test/…')
  })

  it('applies every rule to one text, in the order paths, JWT, e-mail, link, token', () => {
    const text = [
      'Fix /Users/ada/w/labs/quill/web/app.ts',
      'and /Users/ada/Desktop/shot.png,',
      'mail ada@quill.example,',
      'docs https://lumen.example/x/y,',
      'token ghp_abcdefghijklmnop1234',
      'jwt eyJabcdefghij.eyJabcdefghij.abcdefghijkl'
    ].join(' ')
    expect(scrubText(text, context)).toBe(
      'Fix labs/quill/web/app.ts and ~/Desktop/shot.png, mail <email>, docs https://lumen.example/… token <token> jwt <token>'
    )
  })
})
