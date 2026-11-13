import { describe, expect, it } from 'vitest'
import {
  continuedFrom,
  familyOfOptions,
  firstTurn,
  isTransportSwitch,
  launchProfileFor,
  PROVIDER_LABELS,
  planRoad,
  providerOf,
  providerSwitchOptions,
  switchRoad,
  transportSwitchOptions,
  transportTarget
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
  it("carries the message a cap rejected as the resumed thread's first prompt, once, and never beside the handoff (integration round 2, G7)", () => {
    const rejected = { type: 'user_message' as const, text: 'the question the cap refused' }
    const resumed = providerSwitchOptions(
      { ...previous, initialInput: rejected },
      { adapterId: 'codex-chat', model: 'gpt-5.5', resume: 'thread-7' }
    )
    expect(resumed.initialPrompt).toBe('the question the cap refused')
    expect(resumed.initialInput).toBeUndefined()
    // No rejected message on the restart: the resumed thread gets no prompt.
    expect(
      providerSwitchOptions(previous, {
        adapterId: 'codex-chat',
        model: 'gpt-5.5',
        resume: 'thread-7'
      }).initialPrompt
    ).toBeUndefined()
    // The handoff road: the tape is the first message and ends on the question already.
    const handed = providerSwitchOptions(
      { ...previous, initialInput: rejected },
      {
        adapterId: 'codex-chat',
        model: 'gpt-5.5',
        firstMessage: '# Continued from Claude · handoff\n…'
      }
    )
    expect(handed.initialPrompt).toBe('# Continued from Claude · handoff\n…')
    expect(handed.initialInput).toBeUndefined()
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

describe('the message the cap rejected crosses the move once, as the first turn (integration round 2, G7)', () => {
  it('rides alone onto a resumed thread; a handoff goes as written, its tape already ending on the message', () => {
    expect(firstTurn('fix the test', { resume: 'thread-7', firstMessage: 'never' })).toBe(
      'fix the test'
    )
    expect(
      firstTurn('fix the test', { firstMessage: '# Continued from Claude · handoff\n\nbody\n' })
    ).toBe('# Continued from Claude · handoff\n\nbody\n')
  })
  it('is nothing when the move is not the limit’s doing', () => {
    expect(firstTurn(undefined, { resume: 'thread-7' })).toBeUndefined()
    expect(firstTurn('   ', { resume: 'thread-7' })).toBeUndefined()
    expect(firstTurn(undefined, { firstMessage: 'handoff' })).toBe('handoff')
  })
  it('the spawn carries it as the launch prompt, the restart’s initialInput consumed', () => {
    const previous: PtySpawnOptions = {
      claudeMode: true,
      launchProfileId: 'claude-chat',
      initialInput: { type: 'user_message', text: 'the rejected one' }
    }
    const converted = providerSwitchOptions(previous, {
      adapterId: 'codex-chat',
      resume: 'thread-7'
    })
    expect(converted.initialPrompt).toBe('the rejected one')
    expect(converted.initialInput).toBeUndefined()
    const handed = providerSwitchOptions(previous, {
      adapterId: 'codex-chat',
      firstMessage: 'handoff'
    })
    expect(handed.initialPrompt).toBe('handoff')
    expect(handed.initialInput).toBeUndefined()
  })
})

describe('the transport switch: the same harness, chat to terminal and back (lane D, PRDCT-4427)', () => {
  it('reads the harness family a spawn runs, null for a plain terminal', () => {
    expect(familyOfOptions({ claudeMode: true })).toBe('claude')
    expect(familyOfOptions({})).toBe('claude')
    expect(familyOfOptions({ claudeMode: false, claudeAgentsMode: true })).toBe('claude')
    expect(familyOfOptions({ claudeMode: false, codexMode: true })).toBe('codex')
    expect(familyOfOptions({ claudeMode: false, piMode: true })).toBe('pi')
    expect(familyOfOptions({ claudeMode: false, opencodeMode: true })).toBe('opencode')
    expect(familyOfOptions({ claudeMode: false, antigravityMode: true })).toBe('antigravity')
    expect(familyOfOptions({ claudeMode: false })).toBeNull()
  })
  it('is a transport switch only between the terminal and the same family’s own chat', () => {
    expect(isTransportSwitch('pty', 'claude-chat', 'claude')).toBe(true)
    expect(isTransportSwitch('claude-chat', 'pty', 'claude')).toBe(true)
    expect(isTransportSwitch('pty', 'codex-chat', 'codex')).toBe(true)
    expect(isTransportSwitch('codex-chat', 'pty', 'codex')).toBe(true)
    expect(isTransportSwitch('pty', 'codex-chat', 'claude')).toBe(false)
    expect(isTransportSwitch('claude-chat', 'codex-chat', 'claude')).toBe(false)
    expect(isTransportSwitch('pty', 'pty', 'claude')).toBe(false)
    expect(isTransportSwitch('pty', 'claude-chat', null)).toBe(false)
    expect(isTransportSwitch('pty', 'claude-chat', 'antigravity')).toBe(false)
  })

  const chat: PtySpawnOptions = {
    claudeMode: true,
    codexMode: false,
    launchProfileId: 'claude-chat',
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'plan',
    dangerousMode: true,
    claudeProfileId: 'work',
    claudeProfileLabel: 'Work',
    configDir: '/cfg/work',
    resumeSessionId: 'conv-1',
    adoptSessionId: 'tab-1',
    workspaceId: 'ws',
    spawnedBy: 'opener',
    openedBy: 'agent',
    viewId: 'clave.chat-view/lab',
    initialPrompt: 'once',
    initialInput: { type: 'user_message', text: 'rejected' }
  }
  it('to the terminal: the family’s selected profile, the conversation resumed, the chat’s view and prompt and effort dropped, the account and the tab kept', () => {
    const options = transportSwitchOptions(chat, { adapterId: 'pty', resume: 'conv-1' })
    expect(options).toMatchObject({
      claudeMode: true,
      codexMode: false,
      resumeSessionId: 'conv-1',
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      dangerousMode: true,
      claudeProfileId: 'work',
      claudeProfileLabel: 'Work',
      configDir: '/cfg/work',
      adoptSessionId: 'tab-1',
      workspaceId: 'ws',
      spawnedBy: 'opener',
      openedBy: 'agent'
    })
    expect(options.launchProfileId).toBeUndefined()
    expect(options.launchProfile).toBeUndefined()
    expect(options.claudeSessionId).toBeUndefined()
    expect(options.viewId).toBeUndefined()
    expect(options.initialPrompt).toBeUndefined()
    expect(options.initialInput).toBeUndefined()
    expect(options.effort).toBeUndefined()
  })
  it('to the terminal: a chat with no transcript starts its terminal under the same Claude session id (amendment 2)', () => {
    const options = transportSwitchOptions(chat, { adapterId: 'pty', sessionId: 'conv-1' })
    expect(options.resumeSessionId).toBeUndefined()
    expect(options.claudeSessionId).toBe('conv-1')
    // A resume wins over the session id: the CLI takes one or the other.
    const resumed = transportSwitchOptions(chat, {
      adapterId: 'pty',
      resume: 'conv-1',
      sessionId: 'conv-1'
    })
    expect(resumed.claudeSessionId).toBeUndefined()
  })
  it('to the terminal: the chat’s mode is kept only when it is a rung of the harness, the model the target names wins', () => {
    const manual = transportSwitchOptions(
      { ...chat, permissionMode: 'manual' as PtySpawnOptions['permissionMode'] },
      { adapterId: 'pty', resume: 'conv-1', model: 'claude-sonnet-5' }
    )
    expect(manual.permissionMode).toBeUndefined()
    expect(manual.model).toBe('claude-sonnet-5')
    const codex = transportSwitchOptions(
      {
        ...chat,
        claudeMode: false,
        codexMode: true,
        permissionMode: 'workspace-write' as PtySpawnOptions['permissionMode']
      },
      { adapterId: 'pty', resume: 'thread-1' }
    )
    expect(codex.permissionMode).toBe('workspace-write')
    expect(codex.resumeSessionId).toBe('thread-1')
  })
  const terminal: PtySpawnOptions = {
    claudeMode: false,
    codexMode: true,
    launchProfileId: 'codex-default',
    model: 'gpt-5.5',
    effort: 'high',
    permissionMode: 'workspace-write' as PtySpawnOptions['permissionMode'],
    dangerousMode: false,
    codexAccountId: 'c1',
    codexAccountLabel: 'Codex 1',
    adoptSessionId: 'tab-2',
    initialCommand: 'ls',
    autoExecute: true,
    workspaceId: 'ws'
  }
  it('to the chat: the family’s chat profile, the conversation resumed, the view it opens in, the terminal’s launch words dropped, the account kept', () => {
    const options = transportSwitchOptions(terminal, {
      adapterId: 'codex-chat',
      resume: 'thread-9',
      viewId: 'clave.chat-view/folio'
    })
    expect(options).toMatchObject({
      codexMode: true,
      launchProfileId: 'codex-chat',
      resumeSessionId: 'thread-9',
      viewId: 'clave.chat-view/folio',
      model: 'gpt-5.5',
      codexAccountId: 'c1',
      codexAccountLabel: 'Codex 1',
      adoptSessionId: 'tab-2',
      workspaceId: 'ws',
      dangerousMode: false
    })
    expect(options.permissionMode).toBeUndefined()
    expect(options.effort).toBeUndefined()
    expect(options.initialCommand).toBeUndefined()
    expect(options.autoExecute).toBeUndefined()
    expect(options.claudeSessionId).toBeUndefined()
    const claude = transportSwitchOptions(chat, { adapterId: 'claude-chat', resume: 'conv-1' })
    expect(claude.launchProfileId).toBe('claude-chat')
  })
  it('takes the conversation into a chat only when there is one, never as a silent fresh chat (amendment 1)', () => {
    const none = (): boolean => false
    expect(transportTarget({ adapterId: 'claude-chat', viewId: 'v' }, 'c', 'claude', none)).toEqual(
      { adapterId: 'claude-chat', viewId: 'v', resume: 'c' }
    )
    expect(() => transportTarget({ adapterId: 'codex-chat' }, undefined, 'codex', none)).toThrow(
      'This terminal has no conversation to carry into a chat yet.'
    )
    // A chat that never got a message opens a fresh terminal: nothing is lost.
    expect(transportTarget({ adapterId: 'pty' }, undefined, 'claude', none)).toEqual({
      adapterId: 'pty'
    })
  })
  it('resumes a Claude conversation in the terminal only when its transcript exists, else starts under its id (amendment 2)', () => {
    expect(transportTarget({ adapterId: 'pty' }, 'c', 'claude', () => true)).toEqual({
      adapterId: 'pty',
      resume: 'c'
    })
    expect(transportTarget({ adapterId: 'pty' }, 'c', 'claude', () => false)).toEqual({
      adapterId: 'pty',
      sessionId: 'c'
    })
    // A Codex thread was found by its rollout: it is resumed as it is.
    expect(transportTarget({ adapterId: 'pty' }, 't', 'codex', () => false)).toEqual({
      adapterId: 'pty',
      resume: 't'
    })
  })
  it('throws on a target that is neither transport of the harness, and for a plain terminal', () => {
    expect(() => transportSwitchOptions(chat, { adapterId: 'codex-chat', resume: 'x' })).toThrow(
      'not a transport'
    )
    expect(() =>
      transportSwitchOptions({ claudeMode: false }, { adapterId: 'pty', resume: 'x' })
    ).toThrow()
  })
})

// Lane D (PRDCT-4427): OpenCode's chat over the Agent Client Protocol.
describe('the provider switch knows OpenCode (lane D, PRDCT-4427)', () => {
  it('names OpenCode and Pi, and their chat adapters', () => {
    expect(PROVIDER_LABELS.opencode).toBe('OpenCode')
    expect(PROVIDER_LABELS.pi).toBe('Pi')
    expect(providerOf('opencode-chat')).toBe('opencode')
    expect(providerOf('pi-chat')).toBe('pi')
    expect(launchProfileFor('opencode-chat')).toBe('opencode-chat')
    expect(
      switchRoad({ ...facts, fromAdapterId: 'claude-chat', toAdapterId: 'opencode-chat' })
    ).toEqual({
      road: 'handoff',
      reason:
        'No converter exists from Claude to OpenCode yet; the conversation goes as a handoff message.'
    })
  })
  const claudeChat: PtySpawnOptions = {
    claudeMode: true,
    codexMode: false,
    launchProfileId: 'claude-chat',
    claudeProfileId: 'work',
    claudeProfileLabel: 'Work',
    configDir: '/cfg/work',
    codexAccountId: 'c1',
    codexAccountLabel: 'Codex 1',
    claudeSessionId: 'claude-conv',
    adoptSessionId: 'tab-1'
  }
  it('a move onto opencode-chat sets the OpenCode family and drops the Claude and Codex accounts', () => {
    const options = providerSwitchOptions(claudeChat, {
      adapterId: 'opencode-chat',
      firstMessage: 'handoff'
    })
    expect(options).toMatchObject({
      opencodeMode: true,
      claudeMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      antigravityMode: false,
      launchProfileId: 'opencode-chat',
      initialPrompt: 'handoff',
      adoptSessionId: 'tab-1'
    })
    for (const key of [
      'claudeProfileId',
      'claudeProfileLabel',
      'configDir',
      'codexAccountId',
      'codexAccountLabel',
      'claudeSessionId'
    ] as const)
      expect(options[key], key).toBeUndefined()
  })
  it('and back onto claude-chat: the Claude family, the OpenCode flag off', () => {
    const onOpencode = providerSwitchOptions(claudeChat, {
      adapterId: 'opencode-chat',
      firstMessage: 'handoff'
    })
    const back = providerSwitchOptions(
      { ...onOpencode, claudeProfileId: 'home' },
      { adapterId: 'claude-chat', firstMessage: 'handoff back' }
    )
    expect(back).toMatchObject({
      claudeMode: true,
      codexMode: false,
      opencodeMode: false,
      piMode: false,
      launchProfileId: 'claude-chat',
      claudeProfileId: 'home'
    })
  })
  it('a move between an OpenCode chat and its terminal is a transport switch', () => {
    expect(isTransportSwitch('opencode-chat', 'pty', 'opencode')).toBe(true)
    expect(isTransportSwitch('pty', 'opencode-chat', 'opencode')).toBe(true)
    expect(familyOfOptions({ claudeMode: false, opencodeMode: true })).toBe('opencode')
  })
})

// Lane D (PRDCT-4427): Pi's chat over its own rpc mode.
describe('the provider switch knows Pi (lane D, PRDCT-4427)', () => {
  it('names the pi-chat profile a restart onto it launches', () => {
    expect(launchProfileFor('pi-chat')).toBe('pi-chat')
    expect(providerOf('pi-chat')).toBe('pi')
  })
  it('a move between a Pi chat and its terminal is a transport switch', () => {
    expect(isTransportSwitch('pi-chat', 'pty', 'pi')).toBe(true)
    expect(isTransportSwitch('pty', 'pi-chat', 'pi')).toBe(true)
    expect(isTransportSwitch('pty', 'pi-chat', 'opencode')).toBe(false)
  })
  it("resumes Pi's session either way, its terminal never started under the id", () => {
    const none = (): boolean => false
    expect(transportTarget({ adapterId: 'pty' }, 'p1', 'pi', none)).toEqual({
      adapterId: 'pty',
      resume: 'p1'
    })
    const toChat = transportSwitchOptions(
      { claudeMode: false, piMode: true, piSessionId: 'p1', adoptSessionId: 'tab-1' },
      { adapterId: 'pi-chat', resume: 'p1', viewId: 'clave.chat-view/chat' }
    )
    expect(toChat).toMatchObject({
      piMode: true,
      launchProfileId: 'pi-chat',
      resumeSessionId: 'p1',
      viewId: 'clave.chat-view/chat'
    })
    expect(toChat.piSessionId).toBeUndefined()
  })
})
