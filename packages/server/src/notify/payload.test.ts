import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  NOTIFICATION_DATA_KEYS,
  NOTIFICATION_PAYLOAD_KEYS,
  NotificationPayload
} from '@clave/contract/notify'
import {
  TEXT_MAX,
  accountLimitPayload,
  closedPayload,
  failedPayload,
  finishedPayload,
  payloadAsStrings,
  payloadTitle,
  permissionActions,
  permissionPayload,
  questionActions,
  questionPayload,
  questionText,
  secretPayload,
  testPayload
} from './payload'

/**
 * What a notification says, per category, and what it never says (the mobile
 * wave, lane B). The forbidden strings below are what a request, a question
 * or a secret carries that must never reach a phone: a token, a path to a
 * credential, an answer, an environment variable's value, a secret's value.
 */
const subject = {
  serverId: 'srv-1',
  serverName: 'Valentins-Mac',
  sessionId: 'sess-1',
  sessionTitle: 'Fix the build',
  workspaceName: 'clave-app'
}

const FORBIDDEN = {
  token: 'sk-ant-SECRET-TOKEN-0001',
  credentialPath: '/Users/me/.config/clave/push/AuthKey_ABC.p8',
  answer: 'the-answer-nobody-should-see',
  envValue: 'ENV_VALUE_42',
  secretValue: 'hunter2-secret-value',
  filePath: '/Users/me/Desktop/private-notes.txt'
}

/** A request as the server holds it, every private field filled. */
const request = {
  id: 'req-1',
  sessionId: 'sess-1',
  kind: 'secret' as const,
  description: 'An API key for the deploy',
  createdAt: 1,
  options: [{ id: 'allow-once', label: 'Allow once' }],
  questions: [
    {
      id: 'q1',
      question: 'Which key?',
      options: [{ label: FORBIDDEN.answer }]
    }
  ],
  secretQuestions: ['q1'],
  toolName: 'Bash',
  detail: `run with ${FORBIDDEN.token}`,
  input: { command: `export KEY=${FORBIDDEN.envValue}`, file_path: FORBIDDEN.filePath },
  action: { type: 'env-file' as const, file: FORBIDDEN.credentialPath, key: 'DEPLOY_KEY' },
  value: FORBIDDEN.secretValue
}

const every = (): NotificationPayload[] => [
  questionPayload(subject, request.id, request.questions),
  permissionPayload(subject, request.id, request.description, request.options, request.toolName),
  secretPayload(subject, request.id, request.description),
  finishedPayload(subject),
  failedPayload(subject),
  accountLimitPayload(subject, 'Work', '5-hour limit', 4),
  testPayload(subject, 'phone-1')
]

describe('what every payload carries and what none carries', () => {
  it('decodes against the contract and carries only the contract keys, in its order', () => {
    for (const payload of every()) {
      expect(Schema.decodeUnknownSync(NotificationPayload)(payload)).toEqual(payload)
      const keys = Object.keys(closedPayload(payload))
      expect(keys.every((k) => (NOTIFICATION_PAYLOAD_KEYS as readonly string[]).includes(k))).toBe(
        true
      )
      expect(keys).toEqual(
        NOTIFICATION_PAYLOAD_KEYS.filter(
          (k) => (payload as Record<string, unknown>)[k] !== undefined
        )
      )
    }
  })
  it('never carries a token, a credential path, an answer, an env value, a secret value or a file path', () => {
    for (const payload of every()) {
      const text = JSON.stringify(payload)
      for (const [name, value] of Object.entries(FORBIDDEN))
        expect(text.includes(value), `${payload.category} leaks ${name}`).toBe(false)
      // The request's private fields never become keys either.
      for (const key of [
        'input',
        'detail',
        'action',
        'value',
        'answers',
        'secretQuestions',
        'token'
      ])
        expect(key in payload, `${payload.category} carries ${key}`).toBe(false)
    }
  })
  it('closes a payload a builder was handed extra fields on', () => {
    const smuggled = { ...finishedPayload(subject), token: FORBIDDEN.token, input: { x: 1 } }
    const closed = closedPayload(smuggled as unknown as NotificationPayload)
    expect(JSON.stringify(closed).includes(FORBIDDEN.token)).toBe(false)
    expect(Object.keys(closed)).toEqual([
      'category',
      'serverId',
      'serverName',
      'sessionId',
      'sessionTitle',
      'workspaceName',
      'text',
      'actions'
    ])
  })
})

describe('the text of each category', () => {
  it('a question is its first question, and how many more', () => {
    expect(questionText([{ question: 'Send now or draft?' }])).toBe('Send now or draft?')
    expect(questionText([{ question: 'Send now or draft?' }, { question: 'Subject?' }])).toBe(
      'Send now or draft? (and 1 more)'
    )
    expect(questionText([])).toBe('')
  })
  it('a permission is its description, the tool name when the description is empty', () => {
    expect(permissionPayload(subject, 'r', 'Allow Write?', [], 'Write').text).toBe('Allow Write?')
    expect(permissionPayload(subject, 'r', '  ', [], 'Write').text).toBe('Write')
    expect(permissionPayload(subject, 'r', '', []).text).toBe('Permission requested')
  })
  it('a secret is what is asked, never a value', () => {
    expect(secretPayload(subject, 'r', 'A deploy key').text).toBe('A deploy key')
  })
  it('a session finished or failed is its title with the word', () => {
    expect(finishedPayload(subject).text).toBe('Fix the build finished')
    expect(failedPayload(subject).text).toBe('Fix the build failed')
  })
  it('an account limit is the label with its window and what is left, about no session', () => {
    const payload = accountLimitPayload(subject, 'Work', '5-hour limit', 4)
    expect(payload.text).toBe('Work: 5-hour limit has 4% left')
    expect(payload.sessionId).toBe('')
    expect(payload.sessionTitle).toBe('')
    expect(payloadTitle(payload)).toBe('Valentins-Mac')
  })
  it('bounds a long text and collapses its whitespace', () => {
    const long = 'word '.repeat(400)
    const payload = secretPayload(subject, 'r', long)
    expect(payload.text.length).toBe(TEXT_MAX)
    expect(payload.text.endsWith('…')).toBe(true)
    expect(payload.text.includes('  ')).toBe(false)
  })
})

describe('the actions', () => {
  it('a permission offers allow and deny when its options carry one of each', () => {
    expect(
      permissionActions([{ id: 'allow-once' }, { id: 'allow-always' }, { id: 'deny' }])
    ).toEqual(['allow', 'deny', 'open'])
    expect(permissionActions([{ id: 'approve' }, { id: 'deny' }])).toEqual([
      'allow',
      'deny',
      'open'
    ])
    expect(permissionActions([{ id: 'accept' }, { id: 'decline' }])).toEqual([
      'allow',
      'deny',
      'open'
    ])
    expect(permissionActions([{ id: 'answer' }, { id: 'deny' }])).toEqual(['open'])
    expect(permissionActions([])).toEqual(['open'])
  })
  it('a question offers a reply on one free-text question, open otherwise', () => {
    expect(questionActions([{ options: [] }])).toEqual(['reply', 'open'])
    expect(questionActions([{ options: [{ label: 'A' }] }])).toEqual(['open'])
    expect(questionActions([{ options: [] }, { options: [] }])).toEqual(['open'])
  })
  it('a secret, a finished and a failed session, an account limit open the app', () => {
    expect(secretPayload(subject, 'r', 'x').actions).toEqual(['open'])
    expect(finishedPayload(subject).actions).toEqual(['open'])
    expect(failedPayload(subject).actions).toEqual(['open'])
    expect(accountLimitPayload(subject, 'Work', 'w', 1).actions).toEqual(['open'])
  })
})

describe('the strings a data-only transport carries', () => {
  it('joins the actions and leaves an absent field out', () => {
    expect(payloadAsStrings(questionPayload(subject, 'req-1', request.questions))).toEqual({
      category: 'question',
      serverId: 'srv-1',
      serverName: 'Valentins-Mac',
      sessionId: 'sess-1',
      sessionTitle: 'Fix the build',
      workspaceName: 'clave-app',
      requestId: 'req-1',
      text: 'Which key?',
      actions: 'open',
      categoryId: 'clave.question'
    })
    expect('requestId' in payloadAsStrings(finishedPayload(subject))).toBe(false)
  })
  it('carries the action category as categoryId on every category, and no key outside the closed list', () => {
    for (const payload of every()) {
      const strings = payloadAsStrings(payload)
      expect(strings.categoryId).toBe(`clave.${payload.category}`)
      expect(
        Object.keys(strings).every((k) => (NOTIFICATION_DATA_KEYS as readonly string[]).includes(k))
      ).toBe(true)
    }
  })
})
