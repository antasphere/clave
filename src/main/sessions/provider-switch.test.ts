import { describe, expect, it } from 'vitest'
import {
  continuedFrom,
  launchProfileFor,
  planRoad,
  providerOf,
  providerSwitchOptions,
  switchRoad
} from './provider-switch'
import type { PtySpawnOptions } from './adapters/pty-backend'

const facts = {
  fromAdapterId: 'claude-chat',
  toAdapterId: 'codex-chat',
  transcriptFound: true,
  codexVersion: '0.167.0',
  codexSupported: true
}

describe('the road a provider switch takes (PRDCT-4300)', () => {
  it('converts a Claude conversation to Codex when the transcript is there and Codex is the pinned version', () => {
    expect(switchRoad(facts)).toEqual({ road: 'convert', codexVersion: '0.167.0' })
  })
  it('hands off every other direction, saying no converter exists', () => {
    expect(
      switchRoad({ ...facts, fromAdapterId: 'codex-chat', toAdapterId: 'claude-chat' })
    ).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('No converter exists from Codex to Claude')
    })
    expect(switchRoad({ ...facts, toAdapterId: 'echo' })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('from Claude to Echo')
    })
  })
  it('hands off when the transcript is missing, when Codex cannot be run, and when Codex is outside the pin', () => {
    expect(switchRoad({ ...facts, transcriptFound: false })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('no transcript')
    })
    expect(switchRoad({ ...facts, codexVersion: null, codexSupported: false })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('could not be run')
    })
    expect(switchRoad({ ...facts, codexVersion: '0.170.0', codexSupported: false })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('0.170.0')
    })
  })
  it('refuses a move to the provider the tab is already on', () => {
    expect(switchRoad({ ...facts, toAdapterId: 'claude-chat' })).toMatchObject({ road: 'handoff' })
  })
  it('names providers and launch profiles by adapter', () => {
    expect(providerOf('claude-chat')).toBe('claude')
    expect(providerOf('codex-chat')).toBe('codex')
    expect(providerOf('my-plugin')).toBe('my-plugin')
    expect(launchProfileFor('codex-chat')).toBe('codex-chat')
    expect(launchProfileFor('echo')).toBe('dev-echo-adapter')
    expect(continuedFrom('claude-chat', 'convert')).toEqual({
      provider: 'claude',
      road: 'converted'
    })
    expect(continuedFrom('codex-chat', 'handoff')).toEqual({ provider: 'codex', road: 'handoff' })
  })
})

describe("the restart's spawn rebuilt for another adapter (PRDCT-4300)", () => {
  const previous: PtySpawnOptions = {
    claudeMode: true,
    codexMode: false,
    launchProfileId: 'claude-chat',
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'plan',
    allowDangerous: true,
    dangerousMode: false,
    claudeProfileId: 'work',
    claudeProfileLabel: 'Work',
    configDir: '/cfg/work',
    resumeSessionId: 'claude-conv',
    claudeSessionId: 'claude-conv',
    adoptSessionId: 'tab-1',
    workspaceId: 'ws',
    spawnedBy: 'opener'
  }
  it('resumes a converted Codex thread on the Codex adapter, the Claude account and conversation forgotten, the tab and its lineage kept', () => {
    const options = providerSwitchOptions(previous, {
      adapterId: 'codex-chat',
      model: 'gpt-5.5',
      resume: 'thread-7',
      continuedFrom: { provider: 'claude', road: 'converted' }
    })
    expect(options).toMatchObject({
      claudeMode: false,
      codexMode: true,
      claudeAgentsMode: false,
      launchProfileId: 'codex-chat',
      model: 'gpt-5.5',
      resumeSessionId: 'thread-7',
      adoptSessionId: 'tab-1',
      workspaceId: 'ws',
      spawnedBy: 'opener',
      dangerousMode: false,
      continuedFrom: { provider: 'claude', road: 'converted' }
    })
    expect(options.claudeSessionId).toBeUndefined()
    expect(options.claudeProfileId).toBeUndefined()
    expect(options.claudeProfileLabel).toBeUndefined()
    expect(options.configDir).toBeUndefined()
    expect(options.initialInput).toBeUndefined()
    // The source provider's words on how it ran are not the target's.
    expect(options.effort).toBeUndefined()
    expect(options.permissionMode).toBeUndefined()
    expect(options.allowDangerous).toBeUndefined()
    expect(options.launchProfile).toBeUndefined()
  })
  it('opens a fresh conversation on the handoff when nothing is resumed', () => {
    const options = providerSwitchOptions(previous, {
      adapterId: 'codex-chat',
      model: 'gpt-5.5',
      firstMessage: '# Continued from Claude · handoff\n…',
      continuedFrom: { provider: 'claude', road: 'handoff' }
    })
    expect(options.resumeSessionId).toBeUndefined()
    expect(options.initialPrompt).toBe('# Continued from Claude · handoff\n…')
    expect(options.initialInput).toBeUndefined()
    expect(options.continuedFrom).toEqual({ provider: 'claude', road: 'handoff' })
  })
  it('never sends the handoff when a thread is resumed too: the thread already holds the conversation', () => {
    const options = providerSwitchOptions(previous, {
      adapterId: 'codex-chat',
      resume: 'thread-7',
      firstMessage: 'should not go'
    })
    expect(options.initialPrompt).toBeUndefined()
    expect(options.initialInput).toBeUndefined()
  })
  it('moving back to Claude forgets the Codex account and names the Claude profile', () => {
    const options = providerSwitchOptions(
      {
        ...previous,
        claudeMode: false,
        codexMode: true,
        codexAccountId: 'c1',
        codexAccountLabel: 'Codex 1'
      },
      { adapterId: 'claude-chat', model: 'claude-opus-5-5', firstMessage: 'handoff' }
    )
    expect(options).toMatchObject({
      claudeMode: true,
      codexMode: false,
      launchProfileId: 'claude-chat'
    })
    expect(options.codexAccountId).toBeUndefined()
    expect(options.codexAccountLabel).toBeUndefined()
  })
  it('the echo fixture is reached by its development profile', () => {
    expect(providerSwitchOptions(previous, { adapterId: 'echo', firstMessage: 'x' })).toMatchObject(
      {
        claudeMode: true,
        codexMode: false,
        launchProfileId: 'dev-echo-adapter'
      }
    )
  })
})

describe('the plan the popover announces, from the facts the host gathered (verifier round 1, F8)', () => {
  const facts = { fromAdapterId: 'claude-chat', toAdapterId: 'codex-chat', transcriptFound: true }
  it('announces convert on the pinned Codex, naming the version', () => {
    expect(planRoad({ ...facts, codexVersion: '0.167.3' })).toEqual({
      from: { adapterId: 'claude-chat', provider: 'claude' },
      to: { adapterId: 'codex-chat', provider: 'codex' },
      road: 'convert',
      codexVersion: '0.167.3'
    })
  })
  it('announces the handoff for a Codex outside the pin, and for one that cannot be run', () => {
    expect(planRoad({ ...facts, codexVersion: '0.170.0' })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('0.170.0')
    })
    expect(planRoad({ ...facts, codexVersion: null })).toMatchObject({
      road: 'handoff',
      reason: expect.stringContaining('could not be run')
    })
  })
})
