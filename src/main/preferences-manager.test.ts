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

  it('shows the first-run walk on an empty data directory only', () => {
    const fresh = makePorts()
    expect(new PreferencesManager(fresh).get('onboarding')).toBe('pending')

    // An install from before the walk: its preferences file has no key.
    const upgraded = makePorts()
    fs.writeFileSync(
      path.join(upgraded.dir, 'preferences.json'),
      JSON.stringify({ appIcon: 'light' })
    )
    expect(new PreferencesManager(upgraded).get('onboarding')).toBe('done')

    // An install that never wrote preferences.json, but left other files.
    const older = makePorts()
    fs.writeFileSync(path.join(older.dir, 'claude-accounts.json'), '[]')
    expect(new PreferencesManager(older).get('onboarding')).toBe('done')
  })

  it('keeps a first run pending when the app quits before anything else saved', () => {
    const ports = makePorts()
    expect(new PreferencesManager(ports).get('onboarding')).toBe('pending')
    // Other managers leave their files during the run; nothing else touched preferences.
    fs.writeFileSync(path.join(ports.dir, 'claude-accounts.json'), '[]')
    fs.writeFileSync(path.join(ports.dir, 'clave-server.json'), '{}')
    expect(new PreferencesManager(ports).get('onboarding')).toBe('pending')
  })

  it('keeps a first run pending across launches until the walk ends', () => {
    const ports = makePorts()
    const first = new PreferencesManager(ports)
    expect(first.get('onboarding')).toBe('pending')
    // Something else writes the file during the first run: the walk is still owed.
    first.set('appIcon', 'light')
    expect(new PreferencesManager(ports).get('onboarding')).toBe('pending')
    new PreferencesManager(ports).set('onboarding', 'done')
    expect(new PreferencesManager(ports).get('onboarding')).toBe('done')
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
