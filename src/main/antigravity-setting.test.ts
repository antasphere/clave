import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const own = vi.hoisted(() => ({ settings: {} as unknown }))
vi.mock('./preferences-manager', () => ({ preferencesManager: { get: () => own.settings } }))
import { personAntigravityRung, readAntigravitySettingFrom } from './antigravity-setting'

let dir: string
const save = (text: string): void => writeFileSync(join(dir, 'preferences.json'), text)
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-setting-'))
  own.settings = {}
})
afterEach(() => {
  readAntigravitySettingFrom(undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('personAntigravityRung', () => {
  it("reads the app's file from the server it started, at each spawn", () => {
    readAntigravitySettingFrom(dir)
    save('{"harnessSettings":{"antigravity":{"permissionDefault":"plan"}}}')
    expect(personAntigravityRung()).toBe('plan')
    save('{"harnessSettings":{"antigravity":{"permissionDefault":"default"}}}')
    expect(personAntigravityRung()).toBe('default')
  })
  it('asks when that file is there and does not read', () => {
    readAntigravitySettingFrom(dir)
    save('{"harnessSettings":')
    expect(personAntigravityRung()).toBe('default')
  })
  it('reads its own preferences with no app folder, or no file in it', () => {
    own.settings = { antigravity: { permissionDefault: 'plan' } }
    expect(personAntigravityRung()).toBe('plan')
    readAntigravitySettingFrom(dir)
    expect(personAntigravityRung()).toBe('plan')
  })
})
