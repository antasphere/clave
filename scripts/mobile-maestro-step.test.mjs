/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript fixture helpers */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nativeFailedStep } from './mobile-beta-native.mjs'
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/maestro-2.12-command-status.json', import.meta.url), 'utf8')
)
const roots = []
const directory = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-d-status-'))
  roots.push(root)
  return root
}
const status = (entries = fixture, filename = 'commands.json') => {
  const root = directory()
  writeFileSync(path.join(root, filename), JSON.stringify(entries), { mode: 0o600 })
  return root
}
const only = (index) =>
  fixture.map((entry, i) => ({
    ...structuredClone(entry),
    metadata: { ...structuredClone(entry.metadata), status: i === index ? 'FAILED' : 'COMPLETED' }
  }))
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describe('private Maestro failed-step projection', () => {
  it('reads the installed 2.12 serializer shape and retains only three safe fields', () => {
    const result = nativeFailedStep(status())
    expect(result).toEqual({ ordinal: 1, kind: 'tapOnElement', selectorId: 'developer-connect' })
    expect(Object.keys(result).sort()).toEqual(['kind', 'ordinal', 'selectorId'])
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE')
  })
  it('identifies the failed wait instead of an earlier completed tap', () => {
    expect(nativeFailedStep(status(only(1)))).toEqual({
      ordinal: 2,
      kind: 'assertConditionCommand',
      selectorId: 'developer-connection'
    })
  })
  it('never retains an input-text argument or failure error', () => {
    const result = nativeFailedStep(status(only(2)))
    expect(result).toEqual({ ordinal: 3, kind: 'inputTextCommand', selectorId: null })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE')
  })
  it.each(['SYNTHETIC_PRIVATE_ID', 'developer-connect-SYNTHETIC_PRIVATE', 'profile-row-fixture'])(
    'drops nonstatic selector %s',
    (id) => {
      const entries = only(0)
      entries[0].command.tapOnElement.selector.idRegex = id
      expect(nativeFailedStep(status(entries)).selectorId).toBeNull()
    }
  )
  it('ignores raw error and evaluated-command impersonation', () => {
    const entries = only(1)
    entries[1].metadata.error = {
      message: 'SYNTHETIC_PRIVATE_ERROR',
      hierarchy: 'SYNTHETIC_PRIVATE_HIERARCHY'
    }
    entries[1].metadata.evaluatedCommand = {
      tapOnElement: { selector: { idRegex: 'composer-send' } }
    }
    expect(nativeFailedStep(status(entries))).toEqual({
      ordinal: 2,
      kind: 'assertConditionCommand',
      selectorId: 'developer-connection'
    })
  })
  it('does not treat recovered or running commands as failed', () => {
    const entries = fixture.map((entry) => ({
      ...entry,
      metadata: { ...entry.metadata, status: 'COMPLETED' }
    }))
    expect(nativeFailedStep(status(entries))).toBeNull()
    entries[0].metadata.status = 'RUNNING'
    expect(nativeFailedStep(status(entries))).toBeNull()
  })
  it.each([-1, 512, 0.5, 'SYNTHETIC_PRIVATE_ORDINAL'])(
    'refuses invalid sequence %s',
    (sequence) => {
      const entries = only(0)
      entries[0].metadata.sequenceNumber = sequence
      expect(nativeFailedStep(status(entries))).toBeNull()
    }
  )
  it('drops unknown command kinds and ambiguous command objects', () => {
    const entries = only(0)
    entries[0].command = { SYNTHETIC_PRIVATE_KIND: {} }
    expect(nativeFailedStep(status(entries))).toBeNull()
    entries[0].command = { tapOnElement: {}, inputTextCommand: {} }
    expect(nativeFailedStep(status(entries))).toBeNull()
  })
  it.each([false, 'SYNTHETIC_PRIVATE_COMMAND', [], null])(
    'ignores malformed command body %s',
    (value) => {
      const entries = only(0)
      entries[0].command = { tapOnElement: value }
      expect(nativeFailedStep(status(entries))).toBeNull()
    }
  )
  it('reads a nested legacy commands-flow file without returning its path', () => {
    const root = directory()
    mkdirSync(path.join(root, 'flow'))
    writeFileSync(path.join(root, 'flow', 'commands-(fixture).json'), JSON.stringify(fixture))
    expect(nativeFailedStep(root)).toEqual({
      ordinal: 1,
      kind: 'tapOnElement',
      selectorId: 'developer-connect'
    })
  })
  it('fails closed for malformed and oversized status data', () => {
    const root = directory()
    writeFileSync(path.join(root, 'commands.json'), 'invalid SYNTHETIC_PRIVATE_JSON')
    expect(nativeFailedStep(root)).toBeNull()
    const entries = structuredClone(fixture)
    entries[0].metadata.padding = 'x'.repeat(1024 * 1024)
    writeFileSync(path.join(root, 'commands.json'), JSON.stringify(entries))
    expect(nativeFailedStep(root)).toBeNull()
  })
  it('limits entries and inventory', () => {
    expect(nativeFailedStep(status(Array.from({ length: 513 }, () => fixture[0])))).toBeNull()
    const root = status()
    for (let i = 0; i < 65; i++) writeFileSync(path.join(root, 'extra-' + i), '')
    expect(nativeFailedStep(root)).toBeNull()
  })
  it('does not follow status-file or root symlinks', () => {
    const outside = status(),
      root = directory()
    symlinkSync(path.join(outside, 'commands.json'), path.join(root, 'commands.json'))
    expect(nativeFailedStep(root)).toBeNull()
    const alias = path.join(root, 'alias')
    symlinkSync(outside, alias)
    expect(nativeFailedStep(alias)).toBeNull()
  })
})
