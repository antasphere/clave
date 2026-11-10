/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ASSETS_DIR, ICONS, LOGOS, generateAll, listFiles } from './scripts/generate-assets.mjs'
import { specFromCss } from './scripts/tokens-from-css.mjs'
import { fontNames, sha256Hex, woffToOtf } from './scripts/woff-to-otf.mjs'

/* The native phones' assets are generated from what the desktop ships
   (tokens.css, @heroicons/react, cli-logos.tsx, @fontsource/geist-sans) and
   committed. This test regenerates every one of them and holds the committed
   folder to the result, byte for byte and file for file: a token changed on
   one side only, a hand-edited SVG or a stray font fails here, named. */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const assets = path.join(repoRoot, ASSETS_DIR)
const generated = generateAll(repoRoot)
const read = (rel) => readFileSync(path.join(assets, rel))
const readJson = (rel) => JSON.parse(read(rel).toString('utf8'))
const asBuffer = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))

describe('packages/mobile-native/assets', () => {
  it('holds exactly the files the generator writes', () => {
    expect(listFiles(assets)).toEqual([...generated.keys()])
  })

  it('is byte-identical to what the sources generate today', () => {
    const differ = [...generated]
      .filter(
        ([rel, content]) =>
          !existsSync(path.join(assets, rel)) || !read(rel).equals(asBuffer(content))
      )
      .map(([rel]) => `${ASSETS_DIR}/${rel}`)
    expect(differ, 'run `npm run assets --workspace @clave/mobile-native`').toEqual([])
  })
})

describe('tokens.json', () => {
  const tokens = readJson('tokens.json')
  const COLOR = /^(#[0-9a-f]{6}|rgba\([\d., ]+\))$/

  it('carries the four themes in order with every role a literal colour', () => {
    expect(Object.keys(tokens.themes)).toEqual(['dark', 'light', 'coffee', 'charcoal'])
    for (const [theme, roles] of Object.entries(tokens.themes)) {
      expect(Object.keys(roles).length).toBe(23)
      for (const [role, value] of Object.entries(roles))
        expect(value, `${theme}.${role}`).toMatch(COLOR)
    }
    for (const [role, value] of Object.entries(tokens.shared)) expect(value, role).toMatch(COLOR)
  })

  it('carries the spec numbers of the Compact preset', () => {
    expect(tokens.control).toEqual({
      gap: 6,
      height: 28,
      icon: 16,
      paddingX: 8,
      radius: 6,
      text: 13,
      textSmall: 13
    })
    expect(tokens.frame).toEqual({
      border: 1,
      controlHeight: 24,
      controlIcon: 14,
      controlRadius: 4,
      height: 28,
      inset: 1,
      radius: 6,
      surfaceInset: 4
    })
    expect(tokens.radius).toEqual({ '2xl': 14, full: 9999, lg: 6, md: 4, sm: 3, xl: 11 })
    expect(tokens.controlHeights).toEqual({ lg: 32, md: 28, sm: 24, xs: 20 })
    expect(tokens.sidebar).toEqual({ iconSize: 15, rowGap: 2, rowHeight: 28, rowPaddingX: 10 })
    expect(tokens.typography).toEqual({ fontSans: 'Geist Sans', fontWeightMedium: 400 })
  })
})

describe('icons', () => {
  const icons = readJson('icons.json')
  const names = [...Object.keys(icons.icons), ...Object.keys(icons.logos)]

  it('has the 36 icons and 4 logos, every path drawn', () => {
    expect(Object.keys(icons.icons)).toEqual(Object.keys(ICONS).sort())
    expect(Object.keys(icons.logos)).toEqual(Object.keys(LOGOS).sort())
    expect(Object.keys(icons.icons).length).toBe(36)
    expect(Object.keys(icons.logos).length).toBe(4)
    for (const [name, icon] of Object.entries(icons.icons)) {
      expect(icon.paths.length, name).toBeGreaterThan(0)
      for (const d of icon.paths) expect(d.length, name).toBeGreaterThan(0)
    }
    for (const [name, logo] of Object.entries(icons.logos)) {
      expect(logo.paths.length, name).toBeGreaterThan(0)
      for (const p of logo.paths) expect(p.d.length, name).toBeGreaterThan(0)
    }
    expect(icons.logos['logo-pi'].viewBox).toBe('0 0 800 800')
  })

  it('has one SVG and one VectorDrawable per entry', () => {
    expect(listFiles(path.join(assets, 'icons', 'svg'))).toEqual(
      names.map((n) => `${n}.svg`).sort()
    )
    const drawables = listFiles(path.join(assets, 'icons', 'android'))
    expect(drawables).toEqual(names.map((n) => `ic_${n.replace(/-/g, '_')}.xml`).sort())
    for (const file of drawables) expect(file).toMatch(/^[a-z0-9_]+\.xml$/)
  })
})

describe('fonts', () => {
  const manifest = readJson('fonts/fonts.json')

  it('holds the three faces, the licence and the manifest, nothing else', () => {
    expect(listFiles(path.join(assets, 'fonts'))).toEqual(
      [
        'Geist-Medium.otf',
        'Geist-Regular.otf',
        'Geist-SemiBold.otf',
        'OFL.txt',
        'fonts.json'
      ].sort()
    )
    expect(manifest.faces.map((f) => [f.weight, f.file])).toEqual([
      [400, 'Geist-Regular.otf'],
      [500, 'Geist-Medium.otf'],
      [600, 'Geist-SemiBold.otf']
    ])
  })

  it("names the family and each face's PostScript name as the fonts name themselves, apart from the desktop's CSS alias", () => {
    // What a phone registers and looks a face up by: `UIFont(name:)` and
    // `Font.custom` find "Geist" and "Geist-Regular", never "Geist Sans".
    expect(manifest.family).toBe('Geist')
    expect(manifest.cssFamily).toBe(readJson('tokens.json').typography.fontSans)
    expect(manifest.cssFamily).not.toBe(manifest.family)
    for (const face of manifest.faces) {
      const own = fontNames(readFileSync(path.join(assets, 'fonts', face.file)))
      expect(own, face.file).toEqual({
        family: manifest.family,
        postScriptName: face.postScriptName
      })
    }
    expect(manifest.faces.map((f) => f.postScriptName)).toEqual([
      'Geist-Regular',
      'Geist-Medium',
      'Geist-SemiBold'
    ])
  })

  it('names the Geist release the faces come from', () => {
    expect(manifest.package).toBe('@fontsource/geist-sans')
    expect(manifest.geistRelease).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(manifest.upstream).toMatch(/^https:\/\/github\.com\/vercel\//)
    expect(manifest.attribution).toBe('Vercel')
  })

  it('ships CFF OpenType whose hashes the manifest states', () => {
    for (const face of manifest.faces) {
      const bytes = read(`fonts/${face.file}`)
      expect(bytes.toString('latin1', 0, 4), face.file).toBe('OTTO')
      expect(sha256Hex(bytes), face.file).toBe(face.sha256)
    }
  })
})

describe('specFromCss', () => {
  it('evaluates px, rem, unitless, var() and calc() with + - * and parentheses', () => {
    const full = (values) =>
      `@theme { ${Object.entries(values)
        .map(([k, v]) => `--${k}: ${v};`)
        .join(' ')} }`
    const props = {
      'control-h': 'var(--control-h-md)',
      'control-px': '0.5rem',
      'control-gap': 'calc(var(--control-px) - 2px)',
      'control-text': 'calc(13px + var(--ui-text-offset))',
      'control-text-sm': 'calc((10px + 2px) * 2 - 11px)',
      'control-radius': 'var(--radius-lg)',
      'control-icon': '1rem',
      'frame-border': '1px',
      'frame-inset': '1px',
      'frame-h': 'var(--control-h)',
      'frame-radius': 'var(--control-radius)',
      'framed-control-h': 'calc(var(--frame-h) - 2 * (var(--frame-inset) + var(--frame-border)))',
      'framed-control-radius':
        'calc(var(--frame-radius) - var(--frame-inset) - var(--frame-border))',
      'framed-control-icon': '0.875rem',
      'surface-inset': '4px',
      'radius-sm': '0.1875rem',
      'radius-md': '0.25rem',
      'radius-lg': '0.375rem',
      'radius-xl': 'calc(var(--control-radius) + var(--surface-inset) + var(--frame-border))',
      'radius-2xl': '0.875rem',
      'radius-full': '9999px',
      'control-h-xs': '1.25rem',
      'control-h-sm': '1.5rem',
      'control-h-md': '1.75rem',
      'control-h-lg': '2rem',
      'sidebar-row-h': 'var(--control-h-md)',
      'row-gap': '2px',
      'sidebar-tab-icon-size': 'calc(1.5 * 10px)',
      'sidebar-row-px': '10'
    }
    const spec = specFromCss(full(props))
    expect(spec.control).toEqual({
      height: 28,
      paddingX: 8,
      gap: 6,
      text: 13,
      textSmall: 13,
      radius: 6,
      icon: 16
    })
    expect(spec.frame.controlHeight).toBe(24)
    expect(spec.frame.controlRadius).toBe(4)
    expect(spec.radius.xl).toBe(11)
    expect(spec.sidebar).toEqual({ rowHeight: 28, rowGap: 2, iconSize: 15, rowPaddingX: 10 })

    expect(() => specFromCss(full({ ...props, 'radius-md': 'max(1px, 2px)' }))).toThrow(
      'tokens.css: --radius-md cannot be resolved to a number: max(1px, 2px)'
    )
    expect(() => specFromCss(full({ ...props, 'control-gap': 'calc(2px * 3px)' }))).toThrow(
      /--control-gap cannot be resolved/
    )
  })
})

describe('woffToOtf', () => {
  // Two tables: 'aaaa' stored (5 bytes, padded to 8), 'bbbb' deflated.
  const stored = Buffer.from([1, 2, 3, 4, 5])
  const big = Buffer.alloc(64, 7)
  const deflated = deflateSync(big)
  const woff = (() => {
    const header = Buffer.alloc(44)
    const dir = Buffer.alloc(40)
    const dataStart = 44 + 40
    header.write('wOFF', 0, 'latin1')
    header.writeUInt32BE(0x4f54544f, 4) // 'OTTO'
    header.writeUInt16BE(2, 12)
    const entry = (i, tag, offset, comp, orig, sum) => {
      dir.write(tag, i * 20, 'latin1')
      dir.writeUInt32BE(offset, i * 20 + 4)
      dir.writeUInt32BE(comp, i * 20 + 8)
      dir.writeUInt32BE(orig, i * 20 + 12)
      dir.writeUInt32BE(sum, i * 20 + 16)
    }
    const storedAt = dataStart
    const deflatedAt = dataStart + ((stored.length + 3) & ~3)
    entry(0, 'aaaa', storedAt, stored.length, stored.length, 0x11223344)
    entry(1, 'bbbb', deflatedAt, deflated.length, big.length, 0xdeadbeef)
    const body = Buffer.concat([stored, Buffer.alloc(3), deflated])
    const all = Buffer.concat([header, dir, body])
    all.writeUInt32BE(all.length, 8)
    return all
  })()

  it('lays the tables out behind a standard offset table', () => {
    const otf = woffToOtf(woff)
    expect(otf.toString('latin1', 0, 4)).toBe('OTTO')
    expect(otf.readUInt16BE(4)).toBe(2) // numTables
    expect(otf.readUInt16BE(6)).toBe(32) // searchRange
    expect(otf.readUInt16BE(8)).toBe(1) // entrySelector
    expect(otf.readUInt16BE(10)).toBe(0) // rangeShift
    const record = (i) => ({
      tag: otf.toString('latin1', 12 + i * 16, 16 + i * 16),
      checksum: otf.readUInt32BE(16 + i * 16),
      offset: otf.readUInt32BE(20 + i * 16),
      length: otf.readUInt32BE(24 + i * 16)
    })
    expect(record(0)).toEqual({ tag: 'aaaa', checksum: 0x11223344, offset: 44, length: 5 })
    expect(record(1)).toEqual({ tag: 'bbbb', checksum: 0xdeadbeef, offset: 52, length: 64 })
    expect(otf.subarray(44, 49).equals(stored)).toBe(true)
    expect([...otf.subarray(49, 52)]).toEqual([0, 0, 0])
    expect(otf.subarray(52, 116).equals(big)).toBe(true)
    expect(otf.length).toBe(116)
  })

  it('refuses a file that is not WOFF 1.0, and a table of the wrong size', () => {
    const bad = Buffer.from(woff)
    bad.write('wOF2', 0, 'latin1')
    expect(() => woffToOtf(bad)).toThrow(/bad signature/)
    const short = Buffer.from(woff)
    short.writeUInt32BE(65, 44 + 20 + 12)
    expect(() => woffToOtf(short)).toThrow(/bbbb is 64 bytes, the directory says 65/)
  })
})
