import { skinManifestSchema } from '@clave/plugin-sdk'
import excludedTokenNames from '@clave/skins/excluded-token-names.json'
import { describe, it, expect } from 'vitest'
import { validateManifest, validateTokens, parseSkinCss } from './validation'
import { bundledSkins } from '@clave/skins/bundled'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

describe('skin trust boundary', () => {
  it.each(excludedTokenNames)('refuses stylesheet-owned token %s by name', (token) => {
    expect(() => validateTokens({ [token]: '77px' })).toThrow(token)
    expect(() => parseSkinCss(`:root { ${token}: 77px; }`)).toThrow(token)
  })
  it('accepts each bundled skin', () => {
    for (const skin of bundledSkins) {
      expect(validateManifest(skin, '1.90.2').id).toBe(skin.id)
      expect(validateTokens(skin.tokens)).toEqual(skin.tokens)
    }
  })
  it.each(['--unknown', 'background', '__proto__'])('rejects token %s', (key) => {
    expect(() => validateTokens(JSON.parse(`{"${key}": "red"}`))).toThrow()
  })
  it.each([
    'body { --surface-0: red }',
    ':root { color: red }',
    '@import "https://example.com";',
    ':root { --surface-0: url(x) }',
    ':root { --surface-0: uRL(x) }',
    ':root { --surface-0: red !important }',
    ':root { div { --surface-0: red } }'
  ])('refuses disallowed CSS: %s', (css) => {
    expect(() => parseSkinCss(css)).toThrow()
  })
  it.each([
    'url(https://example.com/a)',
    'image-set("https://example.com/a")',
    'expression(alert(1))',
    'var(--unknown)',
    'red; color: blue',
    'red !important',
    'u\\72l(x)'
  ])('refuses unsafe token value %s', (value) => {
    expect(() => validateTokens({ '--surface-0': value })).toThrow()
  })
  it('accepts only known token declarations', () => {
    expect(parseSkinCss(':root { --surface-0: #abcdef; }')).toEqual({ '--surface-0': '#abcdef' })
  })
  it.each(['1', 'latest', '1.02.3', '../1.0.0', 'v1.0.0'])('rejects version %s', (version) => {
    expect(() => validateManifest({ ...bundledSkins[0], version }, '1.90.2')).toThrow()
  })
  it('rejects incompatible engines and traversal paths', () => {
    expect(() =>
      validateManifest({ ...bundledSkins[0], engines: { clave: '>=99.0.0' } }, '1.90.2')
    ).toThrow()
    expect(() =>
      validateManifest(
        { ...bundledSkins[0], skin: { tokens: '../skin.json', base: 'dark' } },
        '1.90.2'
      )
    ).toThrow()
  })
  it('extracts byte-identical JSON', () => {
    const files = bundledSkins.flatMap((s) =>
      ['skin.json', 'clave-plugin.json'].map((f) => `packages/skins/skins/${s.id}/${f}`)
    )
    files.push('packages/skins/token-names.json')
    const before = files.map((f) => readFileSync(f, 'utf8'))
    execFileSync(process.execPath, ['packages/skins/scripts/extract-skins.mjs'])
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before)
  })
})

it('uses the SDK skin sub-schema for nested paths and rejects unknown fields', () => {
  const skin = { tokens: 'theme/tokens.json', css: 'theme/overrides.css', base: 'dark' }
  expect(validateManifest({ ...bundledSkins[0], skin }, '1.90.2').skin).toEqual(
    skinManifestSchema.parse(skin)
  )
  expect(() =>
    validateManifest({ ...bundledSkins[0], skin: { ...skin, script: 'run.js' } }, '1.90.2')
  ).toThrow()
})
