import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  prepareRelayDependencies,
  projectRelayLock,
  verifyRelayDependencies
} from '../packages/server/relay-dependencies.mjs'

const root = new URL('../', import.meta.url)
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)))
const manifest = JSON.parse(readFileSync(new URL('packages/server/relay.package.json', root)))
const scratch = []
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('relay packaging', () => {
  it('uses only the workspace-locked runtime closure, with URLs and integrity unchanged', () => {
    const original = JSON.stringify(lock)
    const projected = projectRelayLock(lock, manifest)
    expect(Object.keys(projected.packages)).toEqual([
      '',
      'node_modules/@standard-schema/spec',
      'node_modules/effect',
      'node_modules/fast-check',
      'node_modules/pure-rand',
      'node_modules/ws'
    ])
    for (const [location, entry] of Object.entries(projected.packages)) {
      if (!location) continue
      expect(entry).toEqual(lock.packages[location])
    }
    expect(JSON.stringify(lock)).toBe(original)
  })

  it('refuses a missing transitive instead of resolving it again', () => {
    const changed = structuredClone(lock)
    delete changed.packages['node_modules/pure-rand']
    expect(() => projectRelayLock(changed, manifest)).toThrow('Missing locked dependency pure-rand')
  })

  it('refuses unpinned roots and a manifest that disagrees with the lock', () => {
    for (const version of ['^3.22.1', '3.22.0']) {
      const changed = structuredClone(manifest)
      changed.dependencies.effect = version
      expect(() => projectRelayLock(lock, changed)).toThrow('must match its exact workspace-locked')
    }
  })

  it('refuses a missing integrity or a workspace link', () => {
    for (const change of [(entry) => delete entry.integrity, (entry) => (entry.link = true)]) {
      const changed = structuredClone(lock)
      change(changed.packages['node_modules/effect'])
      expect(() => projectRelayLock(changed, manifest)).toThrow('SHA-512 integrity')
    }
  })

  it('follows nested npm resolution instead of substituting a hoisted version', () => {
    const changed = structuredClone(lock)
    const nested = 'node_modules/fast-check/node_modules/pure-rand'
    changed.packages[nested] = { ...changed.packages['node_modules/pure-rand'], version: '6.1.1' }
    const projected = projectRelayLock(changed, manifest)
    expect(projected.packages[nested].version).toBe('6.1.1')
    expect(projected.packages['node_modules/pure-rand']).toBeUndefined()
  })

  it('records the exact input bytes and refuses to overwrite an existing lock', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'clave-relay-packaging-'))
    scratch.push(directory)
    const provenance = prepareRelayDependencies(
      new URL('package-lock.json', root),
      new URL('packages/server/relay.package.json', root),
      directory
    )
    expect(provenance.packages).toHaveLength(5)
    expect(provenance.workspaceLockSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(() =>
      prepareRelayDependencies(
        new URL('package-lock.json', root),
        new URL('packages/server/relay.package.json', root),
        directory
      )
    ).toThrow('Refusing to overwrite')
    writeFileSync(path.join(directory, 'package-lock.json'), '{}')
    expect(() => verifyRelayDependencies(directory)).toThrow(
      'frozen install changed package-lock.json'
    )
  })

  it('pins the base, passes the actual lock to the build and verifies its frozen consumer', () => {
    const recipe = readFileSync(new URL('packages/server/relay.Dockerfile', root), 'utf8')
    expect(recipe).toMatch(/FROM oven\/bun:1\.4\.1-slim@sha256:[a-f0-9]{64}/)
    expect(recipe).toContain('COPY package-lock.json')
    expect(recipe).toContain('bun install --production --frozen-lockfile --ignore-scripts')
    expect(recipe).toContain('relay-dependencies.mjs --verify /app')
    const context = readFileSync(new URL('.dockerignore', root), 'utf8')
    expect(context.split('\n')).toContain('!package-lock.json')
    expect(context.split('\n')).toContain('!packages/server/relay-dependencies.mjs')
  })
})
