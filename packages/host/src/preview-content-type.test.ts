/**
 * The charset Clave defaults to when it serves a preview file.
 *
 * The guarantee under test: the UTF-8 default fixes files that render as
 * mojibake today and changes nothing for files that render correctly today.
 * Each case below is one arm of that guarantee; if one goes red, the default
 * has either stopped fixing the broken case or started overriding a file's
 * own word.
 */

import { describe, expect, it } from 'vitest'
import { declaresEncoding, isValidUtf8, previewContentType } from './preview-content-type'

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')
const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

describe('previewContentType — the UTF-8 default', () => {
  it('declares utf-8 for an HTML file that says nothing about its encoding (the mojibake case)', () => {
    expect(previewContentType('html', utf8('<p>“quoted” — dash</p>'))).toBe(
      'text/html; charset=utf-8'
    )
  })

  it('applies the same default to every text type', () => {
    expect(previewContentType('css', utf8('body { content: "—" }'))).toBe('text/css; charset=utf-8')
    expect(previewContentType('js', utf8('const s = "é"'))).toBe('text/javascript; charset=utf-8')
    expect(previewContentType('json', utf8('{"a":"é"}'))).toBe('application/json; charset=utf-8')
    expect(previewContentType('svg', utf8('<svg><text>é</text></svg>'))).toBe(
      'image/svg+xml; charset=utf-8'
    )
    expect(previewContentType('csv', utf8('a,b\né,è'))).toBe('text/csv; charset=utf-8')
    expect(previewContentType('md', utf8('# Título'))).toBe('text/plain; charset=utf-8')
  })

  it('pure ASCII is valid UTF-8 and gets the default too (harmless either way)', () => {
    expect(previewContentType('html', utf8('<p>plain</p>'))).toBe('text/html; charset=utf-8')
  })
})

describe('previewContentType — the guard: a file that has spoken is left alone', () => {
  it('an HTML <meta charset> keeps the header bare so the declaration wins', () => {
    const html = utf8('<!doctype html><meta charset="iso-8859-1"><p>x</p>')
    expect(previewContentType('html', html)).toBe('text/html')
  })

  it('the http-equiv form of the meta counts as a declaration', () => {
    const html = utf8(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head></html>'
    )
    expect(previewContentType('html', html)).toBe('text/html')
  })

  it('a CSS @charset keeps the header bare', () => {
    expect(previewContentType('css', utf8('@charset "iso-8859-1";\nbody{}'))).toBe('text/css')
  })

  it('an XML declaration with encoding keeps an SVG bare', () => {
    const svg = utf8('<?xml version="1.0" encoding="ISO-8859-1"?><svg/>')
    expect(previewContentType('svg', svg)).toBe('image/svg+xml')
  })

  it('a byte order mark counts as a declaration for any text type', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('<p>x</p>')])
    expect(previewContentType('html', bom)).toBe('text/html')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x', 'utf16le')])
    expect(previewContentType('txt', utf16)).toBe('text/plain')
  })

  it('a meta charset past the first kilobyte is not a declaration (the browser prescan stops there too)', () => {
    const html = utf8('<!doctype html>' + ' '.repeat(1100) + '<meta charset="iso-8859-1">')
    expect(previewContentType('html', html)).toBe('text/html; charset=utf-8')
  })
})

describe('previewContentType — the guard: bytes that are not UTF-8 are not called UTF-8', () => {
  it('an undeclared Latin-1 file keeps the bare header it renders correctly with today', () => {
    const html = latin1('<p>café</p>')
    expect(isValidUtf8(html)).toBe(false)
    expect(previewContentType('html', html)).toBe('text/html')
  })

  it('the same for a Latin-1 CSS file', () => {
    expect(previewContentType('css', latin1('body { content: "é" }'))).toBe('text/css')
  })
})

describe('previewContentType — non-text types and unknown extensions', () => {
  it('binary types never get a charset', () => {
    expect(previewContentType('png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(previewContentType('woff2', utf8('ascii-looking'))).toBe('font/woff2')
    expect(previewContentType('pdf', utf8('%PDF-1.4'))).toBe('application/pdf')
  })

  it('an unknown extension is served as a generic binary', () => {
    expect(previewContentType('zzz', utf8('x'))).toBe('application/octet-stream')
  })

  it('csv and webmanifest are known types (a page fetching a sibling data.csv must not get octet-stream)', () => {
    expect(previewContentType('csv', utf8('a,b'))).toBe('text/csv; charset=utf-8')
    expect(previewContentType('webmanifest', utf8('{}'))).toBe(
      'application/manifest+json; charset=utf-8'
    )
  })
})

describe('declaresEncoding — scoped per type', () => {
  it('a JS file mentioning <meta charset in a string is not treated as declaring one', () => {
    expect(declaresEncoding('js', utf8('const t = `<meta charset="x">`'))).toBe(false)
  })

  it('an HTML file whose meta lacks a charset attribute declares nothing', () => {
    expect(
      declaresEncoding('html', utf8('<meta name="viewport" content="width=device-width">'))
    ).toBe(false)
  })
})
