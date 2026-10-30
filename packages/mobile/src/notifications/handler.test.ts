import { expect, it } from 'vitest'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import { handleResponse } from './handler'
import type { IncomingResponse } from './port'
import type { SettleClient } from './respond'

const response = (actionIdentifier: string): IncomingResponse => ({
  actionIdentifier,
  notification: {
    date: 1,
    request: {
      identifier: 'notification-1',
      content: {
        title: 'Fixture',
        body: 'Permission',
        data: {
          category: 'permission',
          serverId: 'server',
          serverName: 'Fixture',
          sessionId: 'session',
          sessionTitle: 'Chat',
          requestId: 'request',
          text: 'Run?',
          actions: ['allow', 'deny']
        }
      }
    }
  }
})
it('an unpaired server cannot use another machine credential to answer', async () => {
  let called = false
  const result = await handleResponse(response('clave.allow'), {
    machines: { byServerId: async () => null },
    credentials: new SecureCredentialStore(new MemorySecureStore()),
    client: () => {
      called = true
      throw new Error('Must not create a client')
    }
  })
  expect(called).toBe(false)
  expect(result).toMatchObject({ kind: 'open', link: { kind: 'machines' } })
})
it('answers the paired server through its own device credential', async () => {
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('machine', {
    serverUrl: 'https://relay.example/m/machine',
    bearer: 'fixture-device-session'
  })
  const answers: unknown[] = []
  const client: SettleClient = {
    requests: {
      list: async () => ({
        revision: 1,
        pending: [
          {
            id: 'request',
            sessionId: 'session',
            kind: 'permission',
            description: 'Run?',
            createdAt: 1,
            options: [
              { id: 'allow-once', label: 'Allow' },
              { id: 'deny', label: 'Deny' }
            ]
          }
        ]
      }),
      resolve: async (id, answer) => {
        answers.push({ id, answer })
        return { accepted: true }
      }
    },
    sessions: { write: async () => ({ status: 'accepted' }) }
  }
  expect(
    await handleResponse(response('clave.allow'), {
      machines: { byServerId: async () => ({ machineId: 'machine' }) },
      credentials,
      client: (credential) => {
        expect(credential.bearer).toBe('fixture-device-session')
        return client
      }
    })
  ).toEqual({ kind: 'settled' })
  expect(answers).toEqual([
    { id: 'request', answer: { type: 'permission', optionId: 'allow-once' } }
  ])
})
it('a permanent-only permission opens the app instead of granting it from a notification', async () => {
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('machine', {
    serverUrl: 'https://relay.example/m/machine',
    bearer: 'fixture-device-session'
  })
  let resolved = false
  const client: SettleClient = {
    requests: {
      list: async () => ({
        revision: 1,
        pending: [
          {
            id: 'request',
            sessionId: 'session',
            kind: 'permission',
            description: 'Run?',
            createdAt: 1,
            options: [{ id: 'allow-always', label: 'Always' }]
          }
        ]
      }),
      resolve: async () => {
        resolved = true
        return { accepted: true }
      }
    },
    sessions: { write: async () => ({ status: 'accepted' }) }
  }
  const result = await handleResponse(response('clave.allow'), {
    machines: { byServerId: async () => ({ machineId: 'machine' }) },
    credentials,
    client: () => client
  })
  expect(resolved).toBe(false)
  expect(result).toMatchObject({ kind: 'open', link: { kind: 'requests', requestId: 'request' } })
})
