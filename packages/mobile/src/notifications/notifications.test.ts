import { describe, expect, it } from 'vitest'
import { ServerError } from '../api/errors'
import { MemoryKeyValueStore } from '../chat/drafts'
import type { PendingRequest, RequestResponse } from '../contract/types'
import {
  ACTION_IDS,
  categoryDeclarations,
  categoryIdentifier,
  categoryOfIdentifier,
  declareCategories
} from './categories'
import { deepLinkOf, navigationStateOf, routeOf } from './deeplink'
import { parsePayload, type NotificationPayload } from './payload'
import { DEFAULT_ACTION_IDENTIFIER, type IncomingResponse } from './port'
import {
  interpretResponse,
  permissionOptionId,
  replyResponse,
  settleFromNotification,
  type SettleClient
} from './respond'
import { clearDeviceToken, pushTokenKey, registerDeviceToken } from './token'

/** Lane B's permission payload, as `packages/server/src/notify/payload.ts` builds it. */
const permission: NotificationPayload = {
  category: 'permission',
  serverId: 'srv-1',
  serverName: 'Valentin’s Mac',
  sessionId: 's-1',
  sessionTitle: 'Fix the flaky test',
  workspaceName: 'clave',
  requestId: 'r-1',
  text: 'Run npm test in /Users/v/clave?',
  actions: ['allow', 'deny', 'open']
}
const question: NotificationPayload = {
  ...permission,
  category: 'question',
  requestId: 'r-2',
  text: 'Which branch should the fix land on?',
  actions: ['reply', 'open']
}

/** What iOS hands the app: the APNs user info, `clave` beside `aps`. */
const iosData = (payload: NotificationPayload): unknown => ({
  aps: {
    alert: { title: payload.sessionTitle, body: payload.text },
    category: `clave.${payload.category}`
  },
  clave: payload
})
/** What Android hands the app: the FCM data map, every field a string. */
const androidData = (payload: NotificationPayload): Record<string, string> => {
  const out: Record<string, string> = { categoryId: `clave.${payload.category}` }
  for (const [key, value] of Object.entries(payload))
    if (value !== undefined) out[key] = Array.isArray(value) ? value.join(',') : String(value)
  return out
}

const response = (
  data: unknown,
  actionIdentifier = DEFAULT_ACTION_IDENTIFIER,
  userText?: string
): IncomingResponse => ({
  notification: {
    date: 1,
    request: { identifier: 'n-1', content: { title: 't', body: 'b', data } }
  },
  actionIdentifier,
  ...(userText !== undefined ? { userText } : {})
})

describe('parsePayload', () => {
  it('reads the iOS shape, under the clave key beside aps', () => {
    expect(parsePayload(iosData(permission))).toEqual(permission)
  })

  it('reads the Android shape, every field a string and the actions joined by commas', () => {
    expect(parsePayload(androidData(permission))).toEqual(permission)
    const account = parsePayload(
      androidData({
        category: 'account_limit',
        serverId: 'srv-1',
        serverName: 'Mac',
        sessionId: '',
        sessionTitle: '',
        text: 'Claude: 5h window has 5% left',
        actions: ['open']
      })
    )
    expect(account).toEqual({
      category: 'account_limit',
      serverId: 'srv-1',
      serverName: 'Mac',
      sessionId: '',
      sessionTitle: '',
      text: 'Claude: 5h window has 5% left',
      actions: ['open']
    })
  })

  it('reads a JSON string in either place', () => {
    expect(parsePayload(JSON.stringify(iosData(question)))).toEqual(question)
    expect(parsePayload({ aps: {}, clave: JSON.stringify(question) })).toEqual(question)
  })

  it('answers null for a push that is not Clave’s, and open for actions it does not know', () => {
    expect(parsePayload({ foo: 1 })).toBeNull()
    expect(parsePayload({ category: 'party', serverId: 'x' })).toBeNull()
    expect(parsePayload({ category: 'finished' })).toBeNull()
    expect(parsePayload('not json')).toBeNull()
    expect(parsePayload(null)).toBeNull()
    expect(parsePayload({ ...permission, actions: ['jump', 'allow', 'allow'] })?.actions).toEqual([
      'allow'
    ])
    expect(parsePayload({ ...permission, actions: 'launch' })?.actions).toEqual(['open'])
    expect(parsePayload({ ...permission, actions: undefined })?.actions).toEqual(['open'])
  })
})

describe('the categories', () => {
  it('declares allow and deny on a permission, a reply field on a question, a tap elsewhere', () => {
    const declared = categoryDeclarations()
    expect(declared.map((c) => c.identifier)).toEqual([
      'clave.question',
      'clave.permission',
      'clave.secret',
      'clave.finished',
      'clave.failed',
      'clave.account_limit',
      'clave.test'
    ])
    const perm = declared.find((c) => c.identifier === categoryIdentifier('permission'))!
    expect(perm.actions.map((a) => a.identifier)).toEqual([ACTION_IDS.allow, ACTION_IDS.deny])
    expect(perm.actions[0]!.options).toEqual({
      isAuthenticationRequired: true,
      opensAppToForeground: false
    })
    expect(perm.actions[1]!.options).toEqual({ isDestructive: true, opensAppToForeground: false })
    const q = declared.find((c) => c.identifier === categoryIdentifier('question'))!
    expect(q.actions).toHaveLength(1)
    expect(q.actions[0]!.textInput).toEqual({
      submitButtonTitle: 'Send',
      placeholder: 'Your answer'
    })
    expect(q.actions[0]!.options?.opensAppToForeground).toBe(false)
    for (const other of ['secret', 'finished', 'failed', 'account_limit', 'test'])
      expect(declared.find((c) => c.identifier === `clave.${other}`)!.actions).toEqual([])
  })

  it('declares every category to the platform', async () => {
    const calls: string[] = []
    await declareCategories({
      setNotificationCategoryAsync: async (identifier) => {
        calls.push(identifier)
      }
    })
    expect(calls).toHaveLength(7)
  })

  it('reads a category off the notification’s own identifier', () => {
    expect(categoryOfIdentifier('clave.question')).toBe('question')
    expect(categoryOfIdentifier('clave.party')).toBeNull()
    expect(categoryOfIdentifier('other.question')).toBeNull()
    expect(categoryOfIdentifier(null)).toBeNull()
  })
})

describe('interpretResponse', () => {
  it('a tap opens; an action the payload offers is that action', () => {
    expect(interpretResponse(response(iosData(permission)))).toEqual({
      kind: 'open',
      payload: permission
    })
    expect(interpretResponse(response(androidData(permission), ACTION_IDS.allow))).toEqual({
      kind: 'allow',
      payload: permission
    })
    expect(interpretResponse(response(iosData(permission), ACTION_IDS.deny))).toEqual({
      kind: 'deny',
      payload: permission
    })
    expect(interpretResponse(response(iosData(question), ACTION_IDS.reply, ' main '))).toEqual({
      kind: 'reply',
      payload: question,
      text: 'main'
    })
  })

  it('an action the payload did not offer, or a reply without text, is an open', () => {
    expect(interpretResponse(response(iosData(question), ACTION_IDS.allow))?.kind).toBe('open')
    expect(interpretResponse(response(iosData(permission), ACTION_IDS.reply, 'x'))?.kind).toBe(
      'open'
    )
    expect(interpretResponse(response(iosData(question), ACTION_IDS.reply, '  '))?.kind).toBe(
      'open'
    )
  })

  it('a push without a readable payload is nothing', () => {
    expect(interpretResponse(response({ foo: 1 }))).toBeNull()
  })
})

describe('the answer shaping', () => {
  const base: PendingRequest = {
    id: 'r-1',
    sessionId: 's-1',
    kind: 'permission',
    description: 'Run npm test?',
    createdAt: 1
  }

  it('answers with the request’s own option ids, the Claude ones when none are known', () => {
    const claude = {
      options: [
        { id: 'allow-once', label: 'Allow' },
        { id: 'allow-always', label: 'Always' },
        { id: 'deny', label: 'Deny' }
      ]
    }
    expect(permissionOptionId(claude, 'allow')).toBe('allow-once')
    expect(permissionOptionId(claude, 'deny')).toBe('deny')
    const mcp = {
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' }
      ]
    }
    expect(permissionOptionId(mcp, 'allow')).toBe('approve')
    expect(permissionOptionId(null, 'allow')).toBe('allow-once')
    expect(permissionOptionId(null, 'deny')).toBe('deny')
  })

  it('keys a reply by the question’s id, else its text, as the server reads it', () => {
    const clarification: PendingRequest = {
      ...base,
      id: 'r-2',
      kind: 'clarification',
      questions: [{ id: 'q-branch', question: 'Which branch?', options: [] }]
    }
    expect(replyResponse(clarification, 'main')).toEqual({
      type: 'clarification',
      answers: { 'q-branch': 'main' }
    })
    const noId: PendingRequest = {
      ...clarification,
      questions: [{ question: 'Which branch?', options: [] }]
    }
    expect(replyResponse(noId, 'main')).toEqual({
      type: 'clarification',
      answers: { 'Which branch?': 'main' }
    })
  })

  it('a native question held under a provider id answers as a permission with answer', () => {
    const native: PendingRequest = {
      ...base,
      kind: 'clarification',
      providerRequestId: 'p-1',
      questions: [{ id: 'q1', question: 'Which branch?', options: [] }]
    }
    expect(replyResponse(native, 'main')).toEqual({
      type: 'permission',
      optionId: 'answer',
      answers: { q1: 'main' }
    })
  })

  it('a request with several questions, or none, is the app’s to answer', () => {
    const two: PendingRequest = {
      ...base,
      kind: 'clarification',
      questions: [
        { id: 'a', question: 'A?', options: [] },
        { id: 'b', question: 'B?', options: [] }
      ]
    }
    expect(replyResponse(two, 'x')).toBeNull()
    expect(replyResponse({ ...base, kind: 'clarification' }, 'x')).toBeNull()
  })
})

describe('settleFromNotification', () => {
  const pending: PendingRequest[] = [
    {
      id: 'r-1',
      sessionId: 's-1',
      kind: 'permission',
      description: 'Run npm test?',
      createdAt: 1,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' }
      ]
    },
    {
      id: 'r-2',
      sessionId: 's-1',
      kind: 'clarification',
      description: 'Which branch?',
      createdAt: 2,
      questions: [{ id: 'q-branch', question: 'Which branch should the fix land on?', options: [] }]
    }
  ]
  const make = (
    overrides: {
      list?: () => Promise<{ revision: number; pending: PendingRequest[] }>
      accepted?: boolean
      writeThrows?: unknown
    } = {}
  ): {
    client: SettleClient
    resolved: { id: string; response: RequestResponse }[]
    written: unknown[]
  } => {
    const resolved: { id: string; response: RequestResponse }[] = []
    const written: unknown[] = []
    const client: SettleClient = {
      requests: {
        list: overrides.list ?? (async () => ({ revision: 1, pending })),
        resolve: async (id, response) => {
          resolved.push({ id, response })
          return { accepted: overrides.accepted ?? true }
        }
      },
      sessions: {
        write: async (id, input) => {
          if (overrides.writeThrows) throw overrides.writeThrows
          written.push({ id, input })
        }
      }
    }
    return { client, resolved, written }
  }

  it('allows with the request’s own option id, through the resolve route', async () => {
    const { client, resolved } = make()
    const outcome = await settleFromNotification({ kind: 'allow', payload: permission }, client)
    expect(outcome).toEqual({ kind: 'settled' })
    expect(resolved).toEqual([{ id: 'r-1', response: { type: 'permission', optionId: 'approve' } }])
  })

  it('denies the same way', async () => {
    const { client, resolved } = make()
    await settleFromNotification({ kind: 'deny', payload: permission }, client)
    expect(resolved[0]!.response).toEqual({ type: 'permission', optionId: 'deny' })
  })

  it('replies to the one question, keyed as the server reads it', async () => {
    const { client, resolved } = make()
    const outcome = await settleFromNotification(
      { kind: 'reply', payload: question, text: 'main' },
      client
    )
    expect(outcome).toEqual({ kind: 'settled' })
    expect(resolved).toEqual([
      { id: 'r-2', response: { type: 'clarification', answers: { 'q-branch': 'main' } } }
    ])
  })

  it('a first answer that came from elsewhere is said as already settled', async () => {
    const { client } = make({ accepted: false })
    expect(await settleFromNotification({ kind: 'allow', payload: permission }, client)).toEqual({
      kind: 'already-settled'
    })
    const gone = make({ list: async () => ({ revision: 2, pending: [] }) })
    expect(
      await settleFromNotification({ kind: 'allow', payload: permission }, gone.client)
    ).toEqual({ kind: 'already-settled' })
    expect(gone.resolved).toEqual([])
  })

  it('what the notification cannot settle opens the app', async () => {
    const { client, resolved } = make()
    expect((await settleFromNotification({ kind: 'open', payload: permission }, client)).kind).toBe(
      'open-app'
    )
    const noRequest = { ...permission, requestId: undefined }
    expect((await settleFromNotification({ kind: 'allow', payload: noRequest }, client)).kind).toBe(
      'open-app'
    )
    const twoQuestions = make({
      list: async () => ({
        revision: 1,
        pending: [
          {
            ...pending[1]!,
            questions: [
              { id: 'a', question: 'A?', options: [] },
              { id: 'b', question: 'B?', options: [] }
            ]
          }
        ]
      })
    })
    expect(
      (
        await settleFromNotification(
          { kind: 'reply', payload: question, text: 'x' },
          twoQuestions.client
        )
      ).kind
    ).toBe('open-app')
    expect(resolved).toEqual([])
  })

  it('on a server without the requests port, allow and deny go through the write route', async () => {
    const unavailable = new ServerError('refused', 'No requests here.', {
      status: 422,
      failure: {
        _tag: 'CapabilityUnavailable',
        message: 'No requests here.',
        capability: 'requests'
      }
    })
    const { client, written } = make({
      list: async () => {
        throw unavailable
      }
    })
    expect(await settleFromNotification({ kind: 'allow', payload: permission }, client)).toEqual({
      kind: 'settled'
    })
    expect(written).toEqual([
      { id: 's-1', input: { type: 'permission_response', id: 'r-1', optionId: 'allow-once' } }
    ])
    expect(
      (await settleFromNotification({ kind: 'reply', payload: question, text: 'x' }, client)).kind
    ).toBe('open-app')
    const refusedWrite = make({
      list: async () => {
        throw unavailable
      },
      writeThrows: new ServerError('refused', 'Not waiting.', { status: 422 })
    })
    expect(
      await settleFromNotification({ kind: 'deny', payload: permission }, refusedWrite.client)
    ).toEqual({ kind: 'already-settled' })
  })

  it('a machine that cannot be reached is a failure, not a settled answer', async () => {
    const { client, resolved } = make({
      list: async () => {
        throw new ServerError('network', 'The server could not be reached.')
      }
    })
    const outcome = await settleFromNotification({ kind: 'allow', payload: permission }, client)
    expect(outcome).toEqual({ kind: 'failed', reason: 'The server could not be reached.' })
    expect(resolved).toEqual([])
  })
})

describe('the deep link', () => {
  const machines = {
    byServerId: async (serverId: string) => (serverId === 'srv-1' ? { machineId: 'm-1' } : null)
  }

  it('a tap opens the conversation, cold as warm', async () => {
    const link = await deepLinkOf(permission, machines)
    expect(link).toEqual({
      kind: 'chat',
      machineId: 'm-1',
      sessionId: 's-1',
      title: 'Fix the flaky test'
    })
    expect(navigationStateOf(link)).toEqual({
      index: 2,
      routes: [
        { name: 'Machines' },
        { name: 'Workspaces', params: { machineId: 'm-1' } },
        {
          name: 'Chat',
          params: { machineId: 'm-1', sessionId: 's-1', title: 'Fix the flaky test' }
        }
      ]
    })
    expect(routeOf(link)).toEqual({
      name: 'Chat',
      params: { machineId: 'm-1', sessionId: 's-1', title: 'Fix the flaky test' }
    })
  })

  it('a request the notification could not settle opens the app on the requests', async () => {
    const link = await deepLinkOf(question, machines, 'request')
    expect(link).toEqual({ kind: 'requests', machineId: 'm-1', requestId: 'r-2' })
    expect(routeOf(link)).toEqual({
      name: 'Requests',
      params: { machineId: 'm-1', requestId: 'r-2' }
    })
  })

  it('a notification about an account opens the machine’s workspaces', async () => {
    const link = await deepLinkOf(
      {
        ...permission,
        category: 'account_limit',
        sessionId: '',
        sessionTitle: '',
        requestId: undefined
      },
      machines
    )
    expect(link).toEqual({ kind: 'workspaces', machineId: 'm-1' })
    expect(navigationStateOf(link).index).toBe(1)
  })

  it('a server this phone is not paired with lands on Machines with the reason', async () => {
    const link = await deepLinkOf({ ...permission, serverId: 'srv-9' }, machines)
    expect(link).toEqual({
      kind: 'machines',
      reason: 'Valentin’s Mac is not paired with this phone.'
    })
    expect(routeOf(link)).toEqual({ name: 'Machines' })
  })
})

describe('the device token', () => {
  const make = (
    token: { type: string; data: unknown } | Error = { type: 'ios', data: 'apns-1' },
    failSet = false
  ): {
    ports: Parameters<typeof registerDeviceToken>[1]
    sets: { bearer: string; token: string; platform: string }[]
    clears: string[]
    kv: MemoryKeyValueStore
  } => {
    const sets: { bearer: string; token: string; platform: string }[] = []
    const clears: string[] = []
    const kv = new MemoryKeyValueStore()
    return {
      sets,
      clears,
      kv,
      ports: {
        notifications: {
          getDevicePushTokenAsync: async () => {
            if (token instanceof Error) throw token
            return token
          }
        },
        client: {
          setPushToken: async (bearer, value, platform) => {
            if (failSet) throw new Error('refused')
            sets.push({ bearer, token: value, platform })
          },
          clearPushToken: async (bearer) => {
            clears.push(bearer)
          }
        },
        kv
      }
    }
  }
  const target = { machineId: 'm-1', bearer: 'ds-1', platform: 'ios' as const }

  it('registers the raw token once, and again only when it changes', async () => {
    const { ports, sets, kv } = make()
    expect(await registerDeviceToken(target, ports)).toEqual({
      kind: 'registered',
      token: 'apns-1'
    })
    expect(sets).toEqual([{ bearer: 'ds-1', token: 'apns-1', platform: 'ios' }])
    expect(await kv.getItem(pushTokenKey('m-1'))).toBe('apns-1')
    expect(await registerDeviceToken(target, ports)).toEqual({ kind: 'unchanged' })
    expect(sets).toHaveLength(1)
    const changed = make({ type: 'ios', data: 'apns-2' })
    await changed.kv.setItem(pushTokenKey('m-1'), 'apns-1')
    expect(await registerDeviceToken(target, changed.ports)).toEqual({
      kind: 'registered',
      token: 'apns-2'
    })
  })

  it('a platform without a native token, or one that refuses, is unsupported, not a failure', async () => {
    expect((await registerDeviceToken(target, make({ type: 'web', data: {} }).ports)).kind).toBe(
      'unsupported'
    )
    expect(
      (await registerDeviceToken(target, make(new Error('no APNs on this simulator')).ports)).kind
    ).toBe('unsupported')
    expect(
      (await registerDeviceToken(target, make({ type: 'android', data: 'fcm-1' }).ports)).kind
    ).toBe('unsupported')
  })

  it('a machine that refuses the token is a failure, and nothing is remembered', async () => {
    const { ports, kv } = make(undefined, true)
    expect((await registerDeviceToken(target, ports)).kind).toBe('failed')
    expect(await kv.getItem(pushTokenKey('m-1'))).toBeNull()
  })

  it('clearing forgets the token on the machine and here', async () => {
    const { ports, clears, kv } = make()
    await registerDeviceToken(target, ports)
    await clearDeviceToken(target, ports)
    expect(clears).toEqual(['ds-1'])
    expect(await kv.getItem(pushTokenKey('m-1'))).toBeNull()
  })
})
