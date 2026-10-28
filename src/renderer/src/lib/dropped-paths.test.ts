import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  failureText,
  filesAndFolders,
  pathForMessage,
  pathsFromDataTransfer
} from './dropped-paths'

// The three ways a drop carries paths, in the order the reader prefers them.
const transfer = (data: Record<string, string>, files: File[] = []): DataTransfer =>
  ({ files, getData: (type: string) => data[type] ?? '' }) as unknown as DataTransfer

describe('pathsFromDataTransfer', () => {
  it("reads newline-separated absolute paths from Clave's own panels", () => {
    expect(
      pathsFromDataTransfer(transfer({ 'text/plain': '/a/b c.txt\n~/d.ts\nnot a path\n' }))
    ).toEqual(['/a/b c.txt', '~/d.ts'])
  })
  it('prefers a file: uri-list over plain text and decodes it', () => {
    expect(
      pathsFromDataTransfer(
        transfer({
          'text/uri-list': '# comment\nfile:///x/y%20z.md\nhttps://example.com',
          'text/plain': '/ignored'
        })
      )
    ).toEqual(['/x/y z.md'])
  })
  it('yields nothing for a drop without paths', () => {
    expect(pathsFromDataTransfer(transfer({ 'text/plain': 'hello' }))).toEqual([])
  })
})

describe('filesAndFolders', () => {
  // Finder's items carry a File each and an entry that says which is a
  // folder; a DataTransfer a page builds has the files and no entries.
  const file = (name: string): File => ({ name }) as File
  const item = (
    name: string,
    entry: 'file' | 'folder' | 'none'
  ): { kind: string; getAsFile: () => File; webkitGetAsEntry: () => unknown } => ({
    kind: 'file',
    getAsFile: () => file(name),
    webkitGetAsEntry: () => (entry === 'none' ? null : { isDirectory: entry === 'folder' })
  })
  const transfer = (items: unknown[], files: File[] = []): DataTransfer =>
    ({ items, files }) as unknown as DataTransfer
  afterEach(() => vi.unstubAllGlobals())

  it('tells a folder from the files beside it by its entry, and leaves text items alone', () => {
    vi.stubGlobal('window', {
      electronAPI: { getPathForFile: (f: File) => `/drop/${f.name}` }
    })
    const text = { kind: 'string', getAsFile: () => null }
    expect(filesAndFolders(transfer([item('a.png', 'file'), item('src', 'folder'), text]))).toEqual(
      { files: [file('a.png')], folders: ['/drop/src'] }
    )
  })
  it('takes everything in a transfer without entries as a file', () => {
    expect(filesAndFolders(transfer([item('a.png', 'none'), item('b.txt', 'none')]))).toEqual({
      files: [file('a.png'), file('b.txt')],
      folders: []
    })
  })
  it('falls back to the files list when the items are empty', () => {
    expect(filesAndFolders(transfer([], [file('c.md')]))).toEqual({
      files: [file('c.md')],
      folders: []
    })
  })
})

describe('failureText', () => {
  it("drops an IPC error's routing prefix and keeps the sentence", () => {
    expect(
      failureText(
        new Error(
          "Error invoking remote method 'sessions:files': Error: Folders and special files cannot be attached."
        )
      )
    ).toBe('Folders and special files cannot be attached.')
    expect(failureText(new Error('Pasted images must be 5 MiB or smaller.'))).toBe(
      'Pasted images must be 5 MiB or smaller.'
    )
    expect(failureText('refused')).toBe('refused')
  })
})

describe('pathForMessage', () => {
  it('leaves a plain path bare and quotes one a shell would need quoted', () => {
    expect(pathForMessage('/Users/x/src/a.ts')).toBe('/Users/x/src/a.ts')
    expect(pathForMessage("/Users/x/it's here.md")).toBe("'/Users/x/it'\\''s here.md'")
  })
})
