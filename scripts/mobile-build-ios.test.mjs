/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript archive fixtures */
import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Execute the archive script's actual provenance writer without invoking Xcode.
const script = readFileSync(new URL('./mobile-build-ios.sh', import.meta.url), 'utf8')
const writer = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(script)?.[1]
const scratch = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function archive() {
  const out = mkdtempSync(path.join(tmpdir(), 'clave-ios-archive-'))
  scratch.push(out)
  const app = path.join(out, 'Clave.xcarchive/Products/Applications/Clave.app')
  mkdirSync(app, { recursive: true })
  const executable = path.join(app, 'Clave')
  writeFileSync(executable, 'fixture executable')
  return { out, app, executable, bundle: path.join(app, 'main.jsbundle') }
}

function record(a) {
  expect(writer).toBeTruthy()
  return spawnSync(
    process.execPath,
    [
      '-',
      a.out,
      '/fixture/repository',
      'head',
      'tree',
      'lock',
      'unsigned',
      path.dirname(path.dirname(a.app)),
      a.executable
    ],
    { input: writer, encoding: 'utf8' }
  )
}

describe('iOS archive provenance', () => {
  it('records the executable and bundled JavaScript bytes of a complete archive', () => {
    const a = archive()
    writeFileSync(a.bundle, 'fixture bundled JavaScript')
    const result = record(a)
    expect(result.status, result.stderr).toBe(0)
    const proof = JSON.parse(readFileSync(path.join(a.out, 'provenance.json'), 'utf8'))
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
    expect(proof.javascriptBundle).toEqual({ path: a.bundle, sha256: hash(a.bundle) })
    expect(proof.executable).toEqual({ path: a.executable, sha256: hash(a.executable) })
    expect(proof.signingMode).toBe('unsigned')
  })

  it.each(['missing', 'empty', 'directory', 'symlink'])(
    'refuses a %s JavaScript bundle before writing provenance',
    (kind) => {
      const a = archive()
      if (kind === 'empty') writeFileSync(a.bundle, '')
      if (kind === 'directory') mkdirSync(a.bundle)
      if (kind === 'symlink') symlinkSync(a.executable, a.bundle)
      const result = record(a)
      expect(result.status, result.stderr).not.toBe(0)
      expect(existsSync(path.join(a.out, 'provenance.json'))).toBe(false)
    }
  )
})
