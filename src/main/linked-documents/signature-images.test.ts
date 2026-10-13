import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Resvg } from '@resvg/resvg-js'
import { rasterizeSvgData, mapCssImages } from './signature-images'
import { importSignature } from './email'
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#345678"/><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="32" height="24" filter="url(#grain)" opacity="0.2"/></svg>'
const data = (value: string): string => 'data:image/svg+xml,' + encodeURIComponent(value)
it('rasterizes self-contained SVG with original dimensions and visible pixels', () => {
  const png = rasterizeSvgData(data(svg))
  expect(png.readUInt32BE(16)).toBe(32)
  expect(png.readUInt32BE(20)).toBe(24)
  expect(
    png.equals(
      new Resvg(svg, {
        font: { loadSystemFonts: false, fontDirs: [], fontFiles: [] },
        logLevel: 'off'
      })
        .render()
        .asPng()
    )
  ).toBe(true)
})
it.each([
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="file:///private/key" /></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect fill="url(https://example.test/x)" /></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="999999" height="20"/>',
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/key">]><svg width="20" height="20"/>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><feTurbulence numOctaves="100" /></svg>'
])('rejects unsupported, external or oversized SVG before rendering', (value) => {
  expect(() => rasterizeSvgData(data(value))).toThrow()
})
it('stages every CSS background layer as PNG and keeps the layout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clave-svg-signature-'))
  try {
    const a = data(svg),
      b = data(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#abcdef"/></svg>'
      )
    const style = `width:62px;height:62px;background-image:url('${a}'), url('${b}');background-size:32px 24px,cover;background-repeat:repeat,no-repeat;border-radius:8px`
    const path = join(root, 'signature.html')
    writeFileSync(
      path,
      `<table><tr><td style="${style}">Synthetic</td><td style="${style}">Repeated</td></tr></table>`
    )
    const html = await importSignature(path)
    rmSync(path)
    expect(html.includes('image/svg+xml')).toBe(false)
    expect((html.match(/data:image\/png;base64/g) || []).length).toBe(4)
    expect(html).toContain('background-size:32px 24px,cover')
    expect(html).toContain('background-repeat:repeat,no-repeat')
    for (const value of [a, b])
      expect(html.includes(rasterizeSvgData(value).toString('base64'))).toBe(true)
    const refs: string[] = []
    mapCssImages(style, (source) => {
      refs.push(source)
      return source
    })
    expect(refs).toEqual([a, b])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
