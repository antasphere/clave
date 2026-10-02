import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { PreferencesManager } from './preferences-manager'
import { eachTestPorts } from './ports/testing'
import type { StoragePort } from './ports/storage'

/**
 * Main's own preferences (`preferences.json`: the app icon, the telemetry
 * ids, the pre-release toggle, the chat defaults). Silent if wrong: a file
 * read under another name resets every one of them to its default on the
 * next release, and a manager that reads at construction reads before the
 * data directory is known.
 */
describe.each(eachTestPorts())('PreferencesManager on %s', (_name, makePorts) => {
  it('answers the defaults without a file', () => {
    const manager = new PreferencesManager(makePorts())
    expect(manager.get('appIcon')).toBe('dark')
    expect(manager.get('prereleaseUpdates')).toBe(false)
    expect(manager.get('chatModels')).toEqual({})
  })

  it('writes preferences.json, and a fresh manager reads it back', () => {
    const ports = makePorts()
    const manager = new PreferencesManager(ports)
    manager.set('prereleaseUpdates', true)
    manager.set('chatModels', { 'claude-chat': 'claude-opus-5-5' })
    const file = path.join(ports.dir, 'preferences.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({
      prereleaseUpdates: true,
      chatModels: { 'claude-chat': 'claude-opus-5-5' }
    })
    const fresh = new PreferencesManager(ports)
    expect(fresh.get('prereleaseUpdates')).toBe(true)
    expect(fresh.get('appIcon')).toBe('dark')
  })

  it('keeps what an earlier or later build wrote under keys it does not know', () => {
    const ports = makePorts()
    fs.writeFileSync(
      path.join(ports.dir, 'preferences.json'),
      JSON.stringify({ appIcon: 'light', somethingNewer: { a: 1 } })
    )
    const manager = new PreferencesManager(ports)
    expect(manager.get('appIcon')).toBe('light')
    manager.set('telemetryEnabled', false)
    expect(
      JSON.parse(fs.readFileSync(path.join(ports.dir, 'preferences.json'), 'utf-8'))
    ).toMatchObject({ appIcon: 'light', telemetryEnabled: false, somethingNewer: { a: 1 } })
  })

  it('touches nothing until the first read', () => {
    const ports = makePorts()
    const manager = new PreferencesManager({
      get storage(): StoragePort {
        throw new Error('too early')
      },
      secrets: ports.secrets
    })
    expect(() => manager.get('appIcon')).toThrow(/too early/)
  })
})
