import { afterEach, describe, expect, it } from 'vitest'
import type { RequestSnapshot } from '@clave/contract/requests'
import {
  LIMIT_LEFT_PERCENT,
  Notifier,
  type NotifierDeps,
  type UsageReadLike,
  tightestWindow
} from './dispatcher'
import { FakePushTargets, FakePushTransport } from './fake'
import type { PushTransports } from './port'

/**
 * One notification per event, to every push target, through the transport
 * of the target's platform (the mobile wave, lane B). The dispatcher is
 * driven by hand here: the requests service through a snapshot the test
 * edits, the sessions' frames, the server's events, the usage reads.
 */
const notifiers: Notifier[] = []
afterEach(() => {
  for (const n of notifiers.splice(0)) n.close()
})

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface World {
  notifier: Notifier
  targets: FakePushTargets
  ios: FakePushTransport
  android: FakePushTransport
  snapshot: { revision: number; pending: RequestSnapshot['pending'][number][] }
  logged: string[]
  sessions: Map<string, { title: string; cwd: string }>
}

function world(
  input: {
    requests?: boolean
    grace?: number
    transports?: PushTransports
    targets?: FakePushTargets
  } = {}
): World {
  const targets = input.targets ?? new FakePushTargets()
  if (!input.targets) {
    targets.add({ deviceId: 'iphone', platform: 'ios', token: 'ios-token-aaaa' })
    targets.add({ deviceId: 'pixel', platform: 'android', token: 'android-token-bbbb' })
  }
  const ios = new FakePushTransport()
  const android = new FakePushTransport()
  const snapshot: World['snapshot'] = { revision: 0, pending: [] }
  const logged: string[] = []
  const sessions = new Map([['sess-1', { title: 'Fix the build', cwd: '/work/clave-app/src' }]])
  const deps: NotifierDeps = {
    serverId: 'srv-1',
    serverName: 'Valentins-Mac',
    targets,
    transports: input.transports ?? { ios, android },
    fake: false,
    session: (id) => sessions.get(id),
    workspaceName: async (cwd) => (cwd.startsWith('/work/clave-app') ? 'clave-app' : undefined),
    accountLabel: async (_provider, id) => (id === 'acc-1' ? 'Work' : undefined),
    pendingRequests: input.requests === false ? null : () => snapshot,
    requestGraceMs: input.grace ?? 0,
    log: (line) => logged.push(line)
  }
  const notifier = new Notifier(deps)
  notifiers.push(notifier)
  return { notifier, targets, ios, android, snapshot, logged, sessions }
}

const question = (id: string, sessionId = 'sess-1'): RequestSnapshot['pending'][number] => ({
  id,
  sessionId,
  kind: 'clarification',
  description: 'Claude asks a question',
  createdAt: 1,
  providerRequestId: `native-${id}`,
  options: [{ id: 'answer', label: 'Submit' }],
  questions: [{ id: 'q1', question: 'Send now or draft?', options: [{ label: 'Send now' }] }],
  input: { secret: 'THE-INPUT-SECRET' },
  detail: 'THE-DETAIL-TOKEN'
})

describe('the pending requests of a server with a requests service', () => {
  it('pushes one question per request to every target, with the request id as its id', async () => {
    const w = world()
    w.snapshot.pending.push(question('req-1'))
    w.notifier.requestsChanged()
    w.notifier.requestsChanged()
    await tick()
    await w.notifier.flush()
    expect(w.ios.sent.length).toBe(1)
    expect(w.android.sent.length).toBe(1)
    const payload = w.ios.sent[0].payload
    expect(payload).toEqual({
      category: 'question',
      serverId: 'srv-1',
      serverName: 'Valentins-Mac',
      sessionId: 'sess-1',
      sessionTitle: 'Fix the build',
      workspaceName: 'clave-app',
      requestId: 'req-1',
      text: 'Send now or draft?',
      actions: ['open']
    })
    expect(JSON.stringify(payload).includes('THE-INPUT-SECRET')).toBe(false)
    expect(JSON.stringify(payload).includes('THE-DETAIL-TOKEN')).toBe(false)
    expect(w.ios.sent[0].target.deviceId).toBe('iphone')
    expect(w.android.sent[0].target.deviceId).toBe('pixel')
  })
  it('pushes a permission with allow and deny, and a secret with what is asked', async () => {
    const w = world()
    w.snapshot.pending.push(
      {
        id: 'perm-1',
        sessionId: 'sess-1',
        kind: 'permission',
        description: 'Allow Write?',
        createdAt: 1,
        providerRequestId: 'native-perm',
        toolName: 'Write',
        options: [
          { id: 'allow-once', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ],
        input: { file_path: '/Users/me/secret.txt' }
      },
      {
        id: 'sec-1',
        sessionId: 'sess-1',
        kind: 'secret',
        description: 'A deploy key',
        createdAt: 1,
        action: { type: 'env-file', file: '/Users/me/.env', key: 'DEPLOY_KEY' }
      }
    )
    w.notifier.requestsChanged()
    await tick()
    await w.notifier.flush()
    const [permission, secret] = w.ios.sent.map((s) => s.payload)
    expect(permission).toMatchObject({
      category: 'permission',
      requestId: 'perm-1',
      text: 'Allow Write?',
      actions: ['allow', 'deny', 'open']
    })
    expect(secret).toMatchObject({ category: 'secret', requestId: 'sec-1', text: 'A deploy key' })
    for (const sent of w.ios.sent) {
      const text = JSON.stringify(sent.payload)
      expect(text.includes('/Users/me')).toBe(false)
      expect(text.includes('DEPLOY_KEY')).toBe(false)
    }
  })
  it('does not push a request resolved before the grace passed', async () => {
    const w = world({ grace: 30 })
    w.snapshot.pending.push(question('req-1'))
    w.notifier.requestsChanged()
    w.snapshot.pending.length = 0
    w.notifier.requestsChanged()
    await tick(60)
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
    // Seen again under the same id: still nothing, it was settled.
    w.snapshot.pending.push(question('req-1'))
    w.notifier.requestsChanged()
    await tick(60)
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
  it('ignores a permission_request frame where the requests service exists', async () => {
    const w = world()
    w.notifier.streamEvent('sess-1', {
      type: 'permission_request',
      id: 'native-1',
      description: 'Allow Write?',
      options: [{ id: 'allow-once', label: 'Allow once' }]
    })
    await tick()
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
  it('names a session it does not know by its id and no workspace', async () => {
    const w = world()
    w.snapshot.pending.push(question('req-9', 'ghost'))
    w.notifier.requestsChanged()
    await tick()
    await w.notifier.flush()
    expect(w.ios.sent[0].payload).toMatchObject({ sessionId: 'ghost', sessionTitle: 'ghost' })
    expect('workspaceName' in w.ios.sent[0].payload).toBe(false)
  })
})

describe('the frames of a server with no requests service', () => {
  it('pushes a question or a permission off the frame, once, with the frame id', async () => {
    const w = world({ requests: false })
    const frame = {
      type: 'permission_request' as const,
      id: 'native-1',
      description: 'Claude asks 1 question',
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [{ question: 'Which branch?', options: [] }],
      input: { secret: 'THE-INPUT-SECRET' }
    }
    w.notifier.streamEvent('sess-1', frame)
    w.notifier.streamEvent('sess-1', frame)
    w.notifier.streamEvent('sess-1', {
      type: 'permission_request',
      id: 'native-2',
      description: 'Allow Bash?',
      toolName: 'Bash',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' }
      ]
    })
    await tick()
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload)).toMatchObject([
      {
        category: 'question',
        requestId: 'native-1',
        text: 'Which branch?',
        actions: ['reply', 'open']
      },
      {
        category: 'permission',
        requestId: 'native-2',
        text: 'Allow Bash?',
        actions: ['allow', 'deny', 'open']
      }
    ])
    expect(JSON.stringify(w.ios.sent).includes('THE-INPUT-SECRET')).toBe(false)
  })
  it('does not push a frame answered, or a turn ended, before the grace passed', async () => {
    const w = world({ requests: false, grace: 30 })
    const frame = (id: string): Parameters<Notifier['streamEvent']>[1] => ({
      type: 'permission_request',
      id,
      description: 'Allow?',
      options: [{ id: 'allow-once', label: 'Allow once' }]
    })
    w.notifier.streamEvent('sess-1', frame('answered'))
    w.notifier.requestAnswered('sess-1', 'answered')
    w.notifier.streamEvent('sess-1', frame('ended'))
    w.notifier.streamEvent('sess-1', { type: 'state_change', state: 'done' })
    w.notifier.streamEvent('sess-1', frame('interrupted'))
    w.notifier.streamEvent('sess-1', { type: 'turn_interrupted' })
    await tick(60)
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
})

describe('a session finished or failed', () => {
  it('pushes finished when the state reaches done, once per transition', async () => {
    const w = world()
    w.notifier.sessionState('sess-1', 'working')
    w.notifier.sessionState('sess-1', 'done')
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload.category)).toEqual(['finished'])
    expect(w.ios.sent[0].payload.text).toBe('Fix the build finished')
    expect('requestId' in w.ios.sent[0].payload).toBe(false)
  })
  it('pushes failed on a fatal error, once until the session works again', async () => {
    const w = world()
    w.notifier.streamEvent('sess-1', {
      type: 'error',
      message: 'boom at /Users/me/key.p8',
      fatal: true
    })
    w.notifier.streamEvent('sess-1', { type: 'error', message: 'boom again', fatal: true })
    w.notifier.exited('sess-1', 1, false)
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload.category)).toEqual(['failed'])
    expect(w.ios.sent[0].payload.text).toBe('Fix the build failed')
    expect(JSON.stringify(w.ios.sent[0].payload).includes('/Users/me')).toBe(false)
    w.notifier.sessionState('sess-1', 'working')
    w.notifier.exited('sess-1', 2, false)
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload.category)).toEqual(['failed', 'failed'])
  })
  it('pushes nothing for a non-fatal error, an exit of 0, or an exit a stop asked for', async () => {
    const w = world()
    w.notifier.streamEvent('sess-1', { type: 'error', message: 'minor', fatal: false })
    w.notifier.exited('sess-1', 0, false)
    w.notifier.exited('sess-1', 137, true)
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
  it('still names a session that is gone by its last known title', async () => {
    const w = world()
    w.notifier.sessionState('sess-1', 'working')
    w.sessions.delete('sess-1')
    w.notifier.exited('sess-1', 1, false)
    await w.notifier.flush()
    expect(w.ios.sent[0].payload).toMatchObject({
      sessionTitle: 'Fix the build',
      workspaceName: 'clave-app'
    })
  })
})

describe('an account at its limit', () => {
  const read = (
    used: number,
    severity: 'normal' | 'critical' | null = null,
    resetsAt: number | null = 1000
  ): UsageReadLike => ({
    windows: [
      { key: 'five_hour', label: '5-hour limit', usedPercentage: used, resetsAt, severity },
      {
        key: 'seven_day',
        label: 'Weekly limit',
        usedPercentage: 10,
        resetsAt: 9000,
        severity: null
      }
    ]
  })
  it('pushes once per account, window and reset time, at five percent left or critical', async () => {
    const w = world()
    w.notifier.usageRead('claude', 'acc-1', read(50))
    w.notifier.usageRead('claude', 'acc-1', read(96))
    w.notifier.usageRead('claude', 'acc-1', read(99))
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload)).toMatchObject([
      {
        category: 'account_limit',
        text: 'Work: 5-hour limit has 4% left',
        sessionId: '',
        sessionTitle: ''
      }
    ])
    // The window reset: a new period, pushed again.
    w.notifier.usageRead('claude', 'acc-1', read(97, null, 2000))
    // Critical with headroom: the service's own verdict counts.
    w.notifier.usageRead('codex', 'acc-2', read(60, 'critical'))
    await w.notifier.flush()
    expect(w.ios.sent.map((s) => s.payload.text)).toEqual([
      'Work: 5-hour limit has 4% left',
      'Work: 5-hour limit has 3% left',
      'acc-2: 5-hour limit has 40% left'
    ])
  })
  it('ignores a failed read and a read with headroom', async () => {
    const w = world()
    w.notifier.usageRead('claude', 'acc-1', { error: 'unauthorized' })
    w.notifier.usageRead('claude', 'acc-1', read(100 - LIMIT_LEFT_PERCENT - 1))
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
  it('picks the tightest window: the most severe, then the most used', () => {
    const windows = [
      { key: 'a', label: 'A', usedPercentage: 90, resetsAt: null, severity: null },
      { key: 'b', label: 'B', usedPercentage: 50, resetsAt: null, severity: 'warning' as const },
      { key: 'c', label: 'C', usedPercentage: 95, resetsAt: null, severity: null }
    ]
    expect(tightestWindow(windows)?.key).toBe('b')
    expect(tightestWindow(windows.filter((w) => w.key !== 'b'))?.key).toBe('c')
    expect(tightestWindow([])).toBeNull()
  })
})

describe('the targets and the transports', () => {
  it('forgets a token the platform reports gone, and logs a failure without the token', async () => {
    const w = world()
    w.ios.answer = () => ({ outcome: 'gone' })
    w.android.answer = () => ({ outcome: 'failed', reason: '500 Internal' })
    w.notifier.sessionState('sess-1', 'done')
    await w.notifier.flush()
    expect(w.targets.forgotten).toEqual([{ deviceId: 'iphone', token: 'ios-token-aaaa' }])
    expect(w.targets.snapshot().map((t) => t.deviceId)).toEqual(['pixel'])
    expect(w.logged.some((l) => l.includes('pixel') && l.includes('500 Internal'))).toBe(true)
    expect(w.logged.join('\n').includes('android-token-bbbb')).toBe(false)
    expect(w.logged.join('\n').includes('ios-token-aaaa')).toBe(false)
  })
  it('sends nothing, and says so once, for a platform with no transport', async () => {
    const ios = new FakePushTransport()
    const w = world({ transports: { ios } })
    w.notifier.sessionState('sess-1', 'done')
    w.notifier.sessionState('sess-1', 'working')
    w.notifier.sessionState('sess-1', 'done')
    await w.notifier.flush()
    expect(ios.sent.length).toBe(2)
    expect(w.logged.filter((l) => l.includes('no transport configured for android')).length).toBe(1)
  })
  it('answers the status, sends a test to one phone, and refuses an unknown device', async () => {
    const w = world()
    expect(await w.notifier.status()).toEqual({
      transports: { ios: true, android: true },
      fake: false,
      targets: 2,
      serverName: 'Valentins-Mac'
    })
    const answer = await w.notifier.test('pixel')
    expect(answer).toEqual({ deviceId: 'pixel', platform: 'android', result: { outcome: 'sent' } })
    expect(w.android.sent[0].payload).toMatchObject({
      category: 'test',
      text: 'Test notification from Valentins-Mac to pixel'
    })
    expect(w.ios.sent).toEqual([])
    await expect(w.notifier.test('nobody')).rejects.toMatchObject({
      _tag: 'PushTargetNotFound',
      deviceId: 'nobody'
    })
  })
  it('pushes nothing once closed', async () => {
    const w = world({ grace: 30 })
    w.snapshot.pending.push(question('req-1'))
    w.notifier.requestsChanged()
    w.notifier.close()
    await tick(60)
    w.notifier.sessionState('sess-1', 'done')
    await w.notifier.flush()
    expect(w.ios.sent).toEqual([])
  })
})
