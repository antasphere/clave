import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { AdapterLaunch, ConversationAdapter } from '../adapter'
import {
  applyConversationEvent,
  type ConversationEvent,
  type ConversationProvider,
  type ConversationSnapshot
} from '../../../shared/agent-session'
import { createAdapter } from './index'

const owned: ConversationAdapter[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map((a) => a.dispose()))
})
function setup(
  provider: ConversationProvider,
  overrides: Partial<AdapterLaunch> = {}
): { adapter: ConversationAdapter; events: ConversationEvent[] } {
  const events: ConversationEvent[] = []
  const adapter = createAdapter(
    {
      command:
        provider === 'opencode'
          ? [process.execPath, resolve('src/main/conversations/adapters/fixtures/opencode.mjs')]
          : [
              process.execPath,
              resolve('src/main/conversations/adapters/fixtures/provider.mjs'),
              provider
            ],
      additionalArgs: [],
      env: { ...process.env } as Record<string, string>,
      sessionDirectory: process.cwd(),
      options: { provider, cwd: process.cwd() },
      ...overrides
    },
    (event) => events.push(event)
  )
  owned.push(adapter)
  return { adapter, events }
}
async function ended(events: ConversationEvent[], count = 1): Promise<void> {
  await expect.poll(() => events.filter((e) => e.type === 'turn-end').length).toBe(count)
}

describe('Claude profile permissions', () => {
  it.each([
    { name: 'native settings', additionalArgs: [], modes: [] },
    { name: 'split auto flag', additionalArgs: ['--permission-mode', 'auto'], modes: ['auto'] },
    { name: 'inline auto flag', additionalArgs: ['--permission-mode=auto'], modes: ['auto'] }
  ])('preserves $name without appending a mode override', async ({ additionalArgs, modes }) => {
    const { adapter } = setup('claude', {
      additionalArgs,
      env: { ...process.env, EXPECT_PERMISSION_MODES: JSON.stringify(modes) } as Record<
        string,
        string
      >
    })
    await adapter.start()
  })
  it('preserves auto mode in the command prefix', async () => {
    const { adapter } = setup('claude', {
      command: [
        process.execPath,
        resolve('src/main/conversations/adapters/fixtures/provider.mjs'),
        'claude',
        '--permission-mode',
        'auto'
      ],
      env: { ...process.env, EXPECT_PERMISSION_MODES: '["auto"]' } as Record<string, string>
    })
    await adapter.start()
  })
  it('still passes bypass only when the explicit dangerous option is selected', async () => {
    const { adapter } = setup('claude', {
      options: { provider: 'claude', cwd: process.cwd(), dangerousMode: true },
      env: {
        ...process.env,
        EXPECT_PERMISSION_MODES: '[]',
        EXPECT_PERMISSION_BYPASS: '1'
      } as Record<string, string>
    })
    await adapter.start()
  })
})

describe('Pi session lifecycle', () => {
  it('resumes external native history without redirecting its UUID lookup', async () => {
    const { adapter } = setup('pi', {
      options: { provider: 'pi', cwd: process.cwd(), resumeSessionId: 'pi-session' },
      providerSessionId: 'pi-session',
      env: { ...process.env, EXPECT_RESUME: 'pi-session', EXPECT_NATIVE_RESUME: '1' } as Record<
        string,
        string
      >
    })
    await adapter.start()
  })
  it('completes handled inputs without requiring an agent run', async () => {
    const { adapter, events } = setup('pi')
    await adapter.start()
    await adapter.send('handled')
    await ended(events)
    await adapter.send('hello')
    await ended(events, 2)
  })
  it('allows extension questions before the prompt RPC acknowledges', async () => {
    const { adapter, events } = setup('pi')
    await adapter.start()
    await adapter.send('preflight-question')
    await expect.poll(() => events.some((event) => event.type === 'request')).toBe(true)
    await adapter.respond({ requestId: 'preflight-question', answer: 'yes' })
    await ended(events)
  })
  it('waits for agent_settled across an automatic retry', async () => {
    const { adapter, events } = setup('pi')
    await adapter.start()
    await adapter.send('retry')
    await expect.poll(() => events.some((event) => event.type === 'text-delta')).toBe(true)
    expect(events.some((event) => event.type === 'turn-end')).toBe(false)
    await expect(adapter.send('too soon')).rejects.toThrow('already active')
    await ended(events)
    expect(events).toContainEqual({ type: 'turn-end', outcome: 'completed' })
  })
})

describe.each(['claude', 'codex', 'pi', 'opencode'] as const)('%s protocol', (provider) => {
  it('uses the provider resume protocol without creating a replacement session', async () => {
    const providerSessionId = provider === 'opencode' ? 'oc-session' : `${provider}-session`
    const { adapter, events } = setup(provider, {
      providerSessionId,
      env: { ...process.env, EXPECT_RESUME: providerSessionId } as Record<string, string>
    })
    await adapter.start()
    expect(events).toContainEqual({ type: 'provider-session', providerSessionId })
  })
  it('handshakes, accepts multiple turns and deduplicates final snapshots', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('hello')
    await ended(events)
    await adapter.send('again')
    await ended(events, 2)
    let snapshot = {
      session: {},
      sessionId: 's',
      sequence: 0,
      entries: [],
      requests: []
    } as unknown as ConversationSnapshot
    snapshot.session.id = 's'
    events.forEach((event, i) => {
      snapshot = applyConversationEvent(snapshot, {
        sessionId: 's',
        sequence: i + 1,
        timestamp: '',
        event
      })
    })
    expect(
      snapshot.entries.filter((e) => e.kind === 'message').map((e) => 'text' in e && e.text)
    ).toEqual(['héllo', 'héllo'])
    expect(events.some((e) => e.type === 'tool' && e.tool.status === 'running')).toBe(true)
    expect(
      snapshot.entries.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && e.status)
    ).toEqual(['completed', 'completed'])
    expect(events.some((e) => e.type === 'provider-session')).toBe(true)
  })
  it('interrupts without discarding the process history', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('wait')
    await adapter.interrupt()
    await ended(events)
    expect(events).toContainEqual({ type: 'turn-end', outcome: 'interrupted' })
    await adapter.send('after')
    await ended(events, 2)
  })
  it.each(['crash', 'malformed'])('fails visibly on %s', async (text) => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send(text).catch(() => {})
    await expect
      .poll(() => events.some((e) => e.type === 'status' && e.status === 'error'))
      .toBe(true)
  })
  it('fails closed on unknown interactive requests', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('unknown')
    await expect
      .poll(() => events.some((e) => e.type === 'status' && e.status === 'error'))
      .toBe(true)
  })
  it('returns structured answers to provider questions', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('question')
    await expect
      .poll(() => events.some((e) => e.type === 'request' && e.request.kind === 'question'))
      .toBe(true)
    const request = events.find((e) => e.type === 'request')
    if (request?.type !== 'request') throw new Error('missing question')
    await adapter.respond({ requestId: request.request.id, answer: 'A' })
    await ended(events)
    expect(events.some((e) => e.type === 'message' && e.message.text.includes('A'))).toBe(true)
  })
})
describe.each(['claude', 'codex', 'opencode'] as const)('%s permissions', (provider) => {
  it.each(['allow', 'deny'] as const)('requires explicit %s response', async (decision) => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('permission')
    await expect.poll(() => events.some((e) => e.type === 'request')).toBe(true)
    expect(events.some((e) => e.type === 'turn-end')).toBe(false)
    const request = events.find((e) => e.type === 'request')
    if (request?.type !== 'request') throw new Error('missing request')
    await adapter.respond({ requestId: request.request.id, decision })
    await ended(events)
    expect(events.at(-1)?.type).toBe('turn-end')
    const expected =
      provider === 'claude'
        ? decision
        : provider === 'codex'
          ? decision === 'allow'
            ? 'accept'
            : 'decline'
          : decision === 'allow'
            ? 'once'
            : 'reject'
    expect(events.some((e) => e.type === 'message' && e.message.text === expected)).toBe(true)
    await expect(adapter.respond({ requestId: request.request.id, decision })).rejects.toThrow()
  })
  it('invalidates permission requests on interrupt', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('permission')
    await expect.poll(() => events.some((e) => e.type === 'request')).toBe(true)
    const request = events.find((e) => e.type === 'request')
    await adapter.interrupt()
    await ended(events)
    if (request?.type !== 'request') throw new Error('missing request')
    await expect(
      adapter.respond({ requestId: request.request.id, decision: 'allow' })
    ).rejects.toThrow()
  })
})

describe.each(['claude', 'codex'] as const)('%s server cancellation', (provider) => {
  it('invalidates a request cancelled by the provider', async () => {
    const { adapter, events } = setup(provider)
    await adapter.start()
    await adapter.send('cancelpermission')
    await expect.poll(() => events.some((e) => e.type === 'request-resolved')).toBe(true)
    const request = events.find((e) => e.type === 'request')
    if (request?.type !== 'request') throw new Error('missing request')
    await expect(
      adapter.respond({ requestId: request.request.id, decision: 'allow' })
    ).rejects.toThrow()
  })
})

it.each([
  ['claude', '--input-format=text'],
  ['codex', '--listen=ws://localhost:1234'],
  ['opencode', '--hostname=0.0.0.0'],
  ['pi', '--mode=text']
] as const)('rejects %s protocol override %s', async (provider, flag) => {
  const adapter = createAdapter(
    {
      command: [process.execPath],
      additionalArgs: [flag],
      env: {},
      sessionDirectory: process.cwd(),
      options: { provider, cwd: process.cwd() }
    },
    () => {}
  )
  owned.push(adapter)
  await expect(adapter.start()).rejects.toThrow()
})

it('returns safe actionable startup errors without leaking executable paths or credentials', async () => {
  const adapter = createAdapter(
    {
      command: ['/does-not-exist/private-token-command'],
      additionalArgs: ['--private-token=sentinel'],
      env: { SECRET: 'sentinel' },
      sessionDirectory: process.cwd(),
      options: { provider: 'claude', cwd: process.cwd() }
    },
    () => {}
  )
  owned.push(adapter)
  await expect(adapter.start()).rejects.toMatchObject({
    safeMessage: 'Unable to start provider executable'
  })
})
