import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the decisions preference imported electron')
})

import { fileStorage } from '../ports/storage'
import { tempDataDir } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import {
  DECISION_PREFERENCES_FILE,
  DECISIONS_RUN_ON_SERVER,
  DecisionPreferences,
  installDecisionPreferences,
  refuseDecisionsHere
} from './preferences'
import {
  decisionConfig,
  defineDecision,
  listDecisions,
  setDecisionConfigSource,
  type DecisionDefinition
} from './registry'
import { resetShutdownForTests, runDecision } from './runner'

// The decisions' preference on the host (PRDCT-5179): only what the person
// changed is stored, a decision with no entry is on, an unknown id is
// refused in words, and the runner reads the switch at each request.

let dir: string
let preferences: DecisionPreferences
const portsOn = (folder: string): SettingsPorts => ({
  storage: fileStorage(folder),
  secrets: {} as SettingsPorts['secrets']
})
const stored = (): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, DECISION_PREFERENCES_FILE), 'utf-8'))

const atlas: DecisionDefinition<string, number> = defineDecision<string, number>({
  id: 'atlas-fits',
  label: 'Atlas fits',
  description: 'An invented decision.',
  model: 'jev-1.14.0',
  timeoutMs: 1000,
  build: (input) => ({ state: input, questions: { q: { type: 'noul', instructions: 'Yes?' } } }),
  read: () => 1
})
beforeEach(() => {
  dir = tempDataDir('clave-decisions-')
  preferences = new DecisionPreferences(portsOn(dir))
})
afterEach(() => {
  setDecisionConfigSource()
  resetShutdownForTests()
})

describe('the decisions preference', () => {
  it('lists every declared decision, on, with its description', () => {
    const list = preferences.list()
    expect(list.map((d) => d.id)).toEqual(listDecisions().map((d) => d.id))
    expect(list).toContainEqual({
      id: 'tab-project',
      label: 'Tab project',
      description: expect.stringContaining('first and latest messages'),
      enabled: true
    })
    expect(list).toContainEqual({
      id: 'atlas-fits',
      label: 'Atlas fits',
      description: 'An invented decision.',
      enabled: true
    })
    expect(fs.existsSync(path.join(dir, DECISION_PREFERENCES_FILE))).toBe(false)
  })

  it('stores a decision switched off, and forgets it switched back on', () => {
    const off = preferences.set('atlas-fits', { enabled: false })
    expect(off.find((d) => d.id === 'atlas-fits')?.enabled).toBe(false)
    expect(stored()).toEqual({ version: 1, decisions: { 'atlas-fits': { enabled: false } } })
    preferences.set('atlas-fits', { enabled: true })
    expect(stored()).toEqual({ version: 1, decisions: {} })
  })

  it('refuses an unknown decision and a switch that is not one, in words', () => {
    expect(() => preferences.set('lumen-nope', { enabled: false })).toThrow(
      'There is no decision "lumen-nope" on this machine.'
    )
    expect(() => preferences.set('atlas-fits', { enabled: 'no' as unknown as boolean })).toThrow(
      'The switch is on or off.'
    )
  })

  it('reads a half-written or hand-edited document as far as it is well formed', () => {
    fs.writeFileSync(path.join(dir, DECISION_PREFERENCES_FILE), '{"version":1,"decisions":{')
    expect(preferences.configFor('atlas-fits')).toBeUndefined()
    fs.writeFileSync(
      path.join(dir, DECISION_PREFERENCES_FILE),
      JSON.stringify({ version: 1, decisions: { 'atlas-fits': { enabled: 'off' } } })
    )
    expect(preferences.list().find((d) => d.id === 'atlas-fits')?.enabled).toBe(true)
  })

  it('once installed, the runner reads the switch at each request', async () => {
    installDecisionPreferences(preferences)
    preferences.set('atlas-fits', { enabled: false })
    expect(decisionConfig(atlas)).toEqual({ enabled: false })
    const ask = vi.fn()
    expect(
      await runDecision(atlas, 'x', { openKey: async () => 'k', baseUrl: () => 'http://t', ask })
    ).toMatchObject({ ok: false, reason: 'disabled' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('a process that is not the owner refuses every decision', async () => {
    refuseDecisionsHere()
    const openKey = vi.fn(async () => 'k')
    expect(await runDecision(atlas, 'x', { openKey, baseUrl: () => 'http://t' })).toEqual({
      ok: false,
      reason: 'disabled',
      detail: DECISIONS_RUN_ON_SERVER
    })
    expect(openKey).not.toHaveBeenCalled()
  })
})
