import type { NotificationPayload } from '@clave/contract/notify'
import {
  accountLimitPayload,
  failedPayload,
  finishedPayload,
  permissionPayload,
  questionPayload,
  secretPayload,
  testPayload
} from './payload'

/** Every real builder with long display data and unchanged routing IDs. */
export function unicodePayloads(character: string): NotificationPayload[] {
  const text = character.repeat(1000)
  const subject = {
    serverId: '11111111-2222-4333-8444-555555555555',
    serverName: text,
    sessionId: '22222222-3333-4444-8555-666666666666',
    sessionTitle: text,
    workspaceName: text
  }
  const requestId = '33333333-4444-4555-8666-777777777777'
  return [
    questionPayload(subject, requestId, [{ question: text, options: [] }]),
    permissionPayload(subject, requestId, text, [{ id: 'allow' }, { id: 'deny' }]),
    secretPayload(subject, requestId, text),
    finishedPayload(subject),
    failedPayload(subject),
    accountLimitPayload(subject, text, text, 4),
    testPayload(subject, 'phone-1')
  ]
}
