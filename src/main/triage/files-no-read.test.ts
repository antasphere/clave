import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The read itself is observed at the filesystem boundary: `readSync` keeps
// its real behaviour and only counts the calls, so the files are real and
// the module under test is unchanged. In its own file so this observation
// stays out of the other file tests.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, readSync: vi.fn(actual.readSync) }
})

const { readBoundedJson } = await import('./files')
const readSync = vi.mocked(fs.readSync)

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-triage-noread-'))
  readSync.mockClear()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a file already larger than its bound (VA-5)', () => {
  it('is refused before a single byte of it is read', () => {
    // Control: the observation sees an ordinary bounded read, so the
    // assertion below cannot pass for want of looking.
    const small = path.join(dir, 'small.json')
    fs.writeFileSync(small, '{"ok":true}')
    expect(readBoundedJson(small, 64)).toEqual({ ok: true })
    expect(readSync).toHaveBeenCalled()

    readSync.mockClear()
    const big = path.join(dir, 'big.json')
    fs.writeFileSync(big, `"${'x'.repeat(4096)}"`)
    expect(() => readBoundedJson(big, 64)).toThrow(/larger than 64 bytes/)
    expect(readSync).not.toHaveBeenCalled()
  })
})
