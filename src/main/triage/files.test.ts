import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modeFlags, readBoundedBody, readBoundedJson, readRecordFiles } from './files'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-triage-files-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('readBoundedJson', () => {
  it('reads a small regular file and answers null for a missing one', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{"ok":true}')
    expect(readBoundedJson(path.join(dir, 'a.json'))).toEqual({ ok: true })
    expect(readBoundedJson(path.join(dir, 'missing.json'))).toBeNull()
  })

  it('says a file is not JSON without quoting its text', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"token":"tok-secret-123456" oops')
    expect(() => readBoundedJson(path.join(dir, 'bad.json'))).toThrow(
      /^bad\.json is not valid JSON$/
    )
  })

  it('refuses a FIFO without blocking on it', () => {
    const fifo = path.join(dir, 'fifo.json')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    expect(() => readBoundedJson(fifo)).toThrow(/not a regular file/)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('refuses a link, even to a readable file', () => {
    fs.writeFileSync(path.join(dir, 'target.json'), '{}')
    fs.symlinkSync(path.join(dir, 'target.json'), path.join(dir, 'link.json'))
    expect(() => readBoundedJson(path.join(dir, 'link.json'))).toThrow(/is a link/)
  })

  it('refuses a file larger than its bound', () => {
    fs.writeFileSync(path.join(dir, 'big.json'), `"${'x'.repeat(100)}"`)
    expect(() => readBoundedJson(path.join(dir, 'big.json'), 50)).toThrow(/larger than 50 bytes/)
  })
})

describe('readRecordFiles', () => {
  it('lists every record, reads at most the cap, and never removes one', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{"id":"a","cwd":"/"}')
    fs.writeFileSync(path.join(dir, 'b.json'), 'not json')
    fs.writeFileSync(path.join(dir, 'c.json'), '{"id":"c","cwd":"/gone"}')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    const r = readRecordFiles(dir, 2)
    expect(r.total).toBe(3)
    expect(r.files).toEqual([
      { key: 'a', content: { id: 'a', cwd: '/' } },
      { key: 'b', content: null }
    ])
    expect(fs.readdirSync(dir).sort()).toEqual(['a.json', 'b.json', 'c.json', 'notes.txt'])
  })

  it('answers nothing for a missing folder and refuses a linked one', () => {
    expect(readRecordFiles(path.join(dir, 'none'), 5)).toEqual({ total: 0, files: [] })
    fs.mkdirSync(path.join(dir, 'real'))
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked'))
    expect(() => readRecordFiles(path.join(dir, 'linked'), 5)).toThrow(/not a plain directory/)
  })
})

describe('readBoundedBody', () => {
  it('keeps the cap and cancels the rest of an endless body', async () => {
    let cancelled = false
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1000).fill(97))
      },
      cancel() {
        cancelled = true
      }
    })
    const body = await readBoundedBody(new Response(stream), 2500)
    expect(body).toBe('a'.repeat(2500))
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })
})

describe('modeFlags', () => {
  it('keeps only the flags Clave defines, by name, and server modes it fixes', () => {
    expect(
      modeFlags([
        '/Applications/Clave.app/Contents/MacOS/Clave',
        '--server',
        'separate',
        '--test-no-activate',
        '--test-version=9.9.9',
        '--dev-echo-adapter',
        '--dev-secret=sk-live-abcdefghijkl',
        '--test-anything=TOKEN',
        '--user-data-dir=/Users/x/private',
        'CLAVE_SERVER_TOKEN=abc'
      ])
    ).toEqual(['--server=separate', '--test-no-activate', '--test-version', '--dev-echo-adapter'])
    expect(modeFlags(['--server=http://evil?token=x'])).toEqual(['--server=<other>'])
  })
})
