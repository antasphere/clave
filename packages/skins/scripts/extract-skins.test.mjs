// The committed skins are what the stylesheet says (PRDCT-4169). Found by
// lane B of the server wave, 7 November 2026: the theme declared a token the
// skins did not carry, and nothing said so until a build regenerated the
// files and left a fresh worktree dirty. The extraction is deterministic, so
// the test is the comparison: run `node packages/skins/scripts/extract-skins.mjs`
// and commit when it goes red for the right reason.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  extractSkins,
  extractFromCheckout,
  manifestFor,
  root,
  SKIN_IDS,
  TOKEN_NAMES_FILE
} from './extract-skins.mjs'

const committed = (file) => JSON.parse(readFileSync(file, 'utf8'))

describe('the committed skins against the stylesheet', () => {
  const extracted = extractFromCheckout()

  it('token-names.json is the inventory the stylesheet declares, minus the exclusions', () => {
    expect(committed(TOKEN_NAMES_FILE)).toEqual(extracted.tokenNames)
  })

  for (const id of SKIN_IDS) {
    it(`the ${id} skin carries every token the theme declares, and no other`, () => {
      const skin = committed(`${root}skins/${id}/skin.json`)
      const missing = Object.keys(extracted.skins[id]).filter((k) => !(k in skin))
      const extra = Object.keys(skin).filter((k) => !(k in extracted.skins[id]))
      expect({ missing, extra }).toEqual({ missing: [], extra: [] })
      expect(skin).toEqual(extracted.skins[id])
    })

    it(`the ${id} manifest is the generated one`, () => {
      expect(committed(`${root}skins/${id}/clave-plugin.json`)).toEqual(manifestFor(id))
    })
  }
})

describe('extractSkins', () => {
  const css = `
    @theme {
      --color-accent: #111;
      --ease-out-sample: cubic-bezier(0, 0, 1, 1);
      --radius-sample: 4px;
    }
    [data-theme="dark"] { --color-accent: #222; }
    [data-theme="light"] { --color-accent: #eee; }
  `

  it('declares every custom property the stylesheet has, except the excluded ones', () => {
    const { tokenNames } = extractSkins(css, ['--radius-sample'])
    expect(tokenNames).toEqual(['--color-accent', '--ease-out-sample'])
  })

  it('a token the exclusion list takes back leaves every skin', () => {
    const { skins } = extractSkins(css, ['--radius-sample', '--ease-out-sample'])
    for (const id of SKIN_IDS) expect(skins[id]).not.toHaveProperty('--ease-out-sample')
  })

  it('a token the theme declares reaches every skin, the dark defaults under each theme', () => {
    const { skins } = extractSkins(css, [])
    expect(skins.dark['--color-accent']).toBe('#222')
    expect(skins.light['--color-accent']).toBe('#eee')
    expect(skins.charcoal['--color-accent']).toBe('#222')
    expect(skins.coffee['--color-accent']).toBe('#222')
    for (const id of SKIN_IDS)
      expect(skins[id]['--ease-out-sample']).toBe('cubic-bezier(0, 0, 1, 1)')
  })
})
