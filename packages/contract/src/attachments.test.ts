import { describe, expect, it } from 'vitest'
import { attachmentFamily, FAMILY_NAMES, FOLDER_MIME_TYPE, mimeTypeOf } from './attachments'

describe('mimeTypeOf', () => {
  it('reads the extension of a name or a whole path, case aside, and knows the common kinds', () => {
    expect(mimeTypeOf('Shot.PNG')).toBe('image/png')
    expect(mimeTypeOf('/Users/x/clip.mov')).toBe('video/quicktime')
    expect(mimeTypeOf('C:\\x\\voice.m4a')).toBe('audio/mp4')
    expect(mimeTypeOf('deck.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(mimeTypeOf('archive.tar.gz')).toBe('application/gzip')
    expect(mimeTypeOf('/a.b/README')).toBe('application/octet-stream')
    expect(mimeTypeOf('.env')).toBe('application/octet-stream')
  })
})

describe('attachmentFamily', () => {
  it('sorts every known media type into the family a chip draws it by', () => {
    const families = (names: string[]): string[] =>
      names.map((n) => attachmentFamily(mimeTypeOf(n)))
    expect(families(['a.png', 'b.heic', 'c.svg'])).toEqual(['image', 'image', 'image'])
    expect(families(['a.mp4', 'b.webm'])).toEqual(['video', 'video'])
    expect(families(['a.mp3', 'b.wav', 'c.caf'])).toEqual(['audio', 'audio', 'audio'])
    expect(families(['a.pdf'])).toEqual(['pdf'])
    expect(families(['a.docx', 'b.pages', 'c.rtf'])).toEqual(['document', 'document', 'document'])
    expect(families(['a.xlsx', 'b.csv', 'c.numbers'])).toEqual(['sheet', 'sheet', 'sheet'])
    expect(families(['a.pptx', 'b.key'])).toEqual(['slides', 'slides'])
    expect(families(['a.txt', 'b.md', 'c.log'])).toEqual(['text', 'text', 'text'])
    expect(families(['a.ts', 'b.py', 'c.json', 'd.html', 'e.sh'])).toEqual([
      'code',
      'code',
      'code',
      'code',
      'code'
    ])
    expect(families(['a.zip', 'b.tgz', 'c.dmg'])).toEqual(['archive', 'archive', 'archive'])
    expect(families(['a.bin', 'Makefile'])).toEqual(['file', 'file'])
    expect(attachmentFamily(FOLDER_MIME_TYPE)).toBe('folder')
  })
  it('names every family', () => {
    for (const family of [
      'image',
      'video',
      'audio',
      'pdf',
      'document',
      'sheet',
      'slides',
      'text',
      'code',
      'archive',
      'folder',
      'file'
    ] as const)
      expect(FAMILY_NAMES[family]).toMatch(/^[A-Z]/)
  })
})
