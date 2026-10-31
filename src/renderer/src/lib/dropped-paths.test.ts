import { describe, expect, it } from 'vitest'
import { failureText, pathForMessage, pathsFromDataTransfer } from './dropped-paths'

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
