import { describe, it, expect } from 'vitest'
import { bundledSkins } from '@clave/skins/bundled'
import { XTERM_TOKEN_MAP, skinToXterm, inheritSkinTokens } from '@clave/skins/skin-to-xterm'
import legacy from '../../../tests/visual/fixtures/legacy-xterm.json'

describe('skin terminal mapping', () => {
  it.each(bundledSkins)('$id preserves every original xterm color', (skin) => {
    const expected = legacy[skin.id as keyof typeof legacy]
    expect(skinToXterm(skin.tokens)).toEqual(
      Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value ?? undefined]))
    )
    expect(Object.keys(XTERM_TOKEN_MAP).sort()).toEqual(Object.keys(expected).sort())
  })
  it('derives every mapped property from its token', () => {
    for (const [key, token] of Object.entries(XTERM_TOKEN_MAP)) {
      expect(skinToXterm({ ...bundledSkins[0].tokens, [token]: '#abcdef' })[key]).toBe('#abcdef')
    }
  })
  it('maps imported accents into the cursor and permits explicit terminal overrides', () => {
    expect(
      skinToXterm(inheritSkinTokens(bundledSkins[0].tokens, { '--color-accent': '#abcdef' })).cursor
    ).toBe('#abcdef')
    expect(
      skinToXterm(
        inheritSkinTokens(bundledSkins[0].tokens, {
          '--color-accent': '#abcdef',
          '--terminal-cursor': '#fedcba'
        })
      ).cursor
    ).toBe('#fedcba')
  })
  it('resolves whitespace and fallback syntax in known token references', () => {
    const tokens = {
      ...bundledSkins[0].tokens,
      '--terminal-cursor': 'var( --color-accent, rgb(1, 2, 3))'
    }
    // --color-accent is itself an alias of the per-theme --accent, so this also
    // proves a reference is followed through more than one hop.
    expect(tokens['--color-accent']).toBe('var(--accent)')
    expect(skinToXterm(tokens).cursor).toBe(tokens['--accent'])
  })
  it('refuses missing and cyclic terminal tokens', () => {
    expect(() => skinToXterm({})).toThrow('Missing')
    expect(() =>
      skinToXterm({ ...bundledSkins[0].tokens, '--terminal-cursor': 'var(--terminal-cursor)' })
    ).toThrow('Circular')
  })
})
