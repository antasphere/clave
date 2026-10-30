import { describe, expect, it } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { renderNativeFlow, nativeFailureDiagnostic } from './mobile-beta-native.mjs'
import { proveSavedProfile, proveCodexProcess } from './mobile-provider-proof.mjs'
const template = readFileSync(
  new URL('../packages/mobile/e2e/beta-provider.yaml', import.meta.url),
  'utf8'
)
const values = {
  METRO_PORT: 8082,
  SERVER_URL: 'http://127.0.0.1:43202',
  SERVER_TOKEN: 'fixture-no-credential',
  WORKSPACE_ID: 'fixture-workspace',
  PROFILE_ID: 'fixture-profile',
  PROMPT_ONE: 'first',
  PROMPT_TWO: 'second',
  REPLY_ONE: 'first-reply',
  REPLY_TWO: 'second-reply'
}
describe('private Maestro flow protocol', () => {
  it.each([
    [true, 0],
    [true, 1],
    [false, 0],
    [false, 1]
  ])('emits Boolean clearState=%s and selector index=%s', (clearState, index) => {
    const flow = renderNativeFlow(template, {
      ...values,
      CLEAR_STATE: clearState,
      REPLY_INDEX: index
    })
    expect(flow).toMatch(new RegExp('clearState: ' + clearState + '\\n'))
    expect(flow.match(new RegExp('index: ' + index + '\\n', 'g'))).toHaveLength(2)
    expect(flow).not.toContain('${CLEAR_STATE}')
    expect(flow).not.toContain('${REPLY_INDEX}')
    expect(flow.match(/id: new-session/g)).toHaveLength(1)
    expect(flow).toContain('inputText: ${PROMPT_ONE}')
    expect(flow).toContain('inputText: ${PROMPT_TWO}')
    expect(flow).toContain('text: ${REPLY_ONE}')
    expect(flow).toContain('text: ${REPLY_TWO}')
  })
  it.each(['true', 'false', null, 1])('refuses non-Boolean clearState %s', (clearState) => {
    expect(() =>
      renderNativeFlow(template, { ...values, CLEAR_STATE: clearState, REPLY_INDEX: 0 })
    ).toThrow()
  })
  it.each([-1, 2, '0', 0.5])('refuses an invalid reply selector index %s', (index) => {
    expect(() =>
      renderNativeFlow(template, { ...values, CLEAR_STATE: true, REPLY_INDEX: index })
    ).toThrow()
  })
})

describe('safe native failure receipt', () => {
  const secret = 'SYNTHETIC_PRIVATE_MATERIAL_89F1'
  it('keeps the real failed command exit without its command or captured output', () => {
    let failure
    try {
      execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1]); process.exit(23)', secret],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      failure = nativeFailureDiagnostic(error)
    }
    expect(failure).toEqual({
      kind: 'command',
      guardId: null,
      reason: 'Native command failed.',
      exit: 23,
      signal: null
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
  })
  it.each([
    ['flow-format', 'Incorrect Format: clearState ' + secret],
    ['boot', 'Data Migration Failed ' + secret],
    ['connect', 'Connection refused ' + secret],
    ['timeout', 'Timed out ' + secret],
    ['java', 'Unable to locate a Java Runtime ' + secret],
    ['ui-assertion', 'Assertion is false ' + secret]
  ])('classifies %s command failure without returning output', (kind, stderr) => {
    const error = Object.assign(new Error(secret), {
      status: 7,
      signal: 'SIGTERM',
      stderr: Buffer.from(stderr),
      stdout: Buffer.from(secret)
    })
    const result = nativeFailureDiagnostic(error)
    expect(result.kind).toBe(kind)
    expect(result.exit).toBe(7)
    expect(result.signal).toBe('SIGTERM')
    expect(result.guardId).toBeNull()
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(Object.keys(result).sort()).toEqual(['exit', 'guardId', 'kind', 'reason', 'signal'])
  })
  it.each([
    ['profile.selected-id', 'Server must launch the selected saved profile'],
    ['profile.definition', 'Server must retain the selected profile definition'],
    ['provider.kind', 'Phone session must use Codex'],
    ['provider.adapter', 'Phone session must use the Codex chat adapter'],
    [
      'process.installed-executable',
      'Exactly one matching Codex executable must belong to this server'
    ]
  ])('identifies only the explicit %s assertion', (guardId, label) => {
    let error
    try {
      assert.equal(secret, 'different-' + secret, label)
    } catch (caught) {
      error = caught
    }
    const result = nativeFailureDiagnostic(error)
    expect(result.kind).toBe('guard')
    expect(result.guardId).toBe(guardId)
    expect(result.reason).toBe(label)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('does not turn CLI text into a provider guard failure', () => {
    const error = Object.assign(new Error(secret), {
      status: 1,
      stderr: Buffer.from('Phone session must use Codex ' + secret)
    })
    const result = nativeFailureDiagnostic(error)
    expect(result.kind).toBe('command')
    expect(result.guardId).toBeNull()
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('does not identify a different assertion in the same phase as the target guard', () => {
    let error
    try {
      assert.ok(false, secret)
    } catch (caught) {
      error = caught
    }
    const result = nativeFailureDiagnostic(error)
    expect(result.kind).toBe('assertion')
    expect(result.guardId).toBeNull()
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('drops arbitrary exit and signal values', () => {
    const result = nativeFailureDiagnostic(
      Object.assign(new Error(secret), { status: secret, signal: secret })
    )
    expect(result.exit).toBeNull()
    expect(result.signal).toBeNull()
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

it('binds the saved-profile diagnostic to the actual profile assertion', () => {
  const secret = 'SYNTHETIC_PRIVATE_PROFILE_3C41'
  let failure
  try {
    proveSavedProfile({
      records: [
        { id: 'session', cwd: '/scratch', workspaceId: 'workspace', launchProfileId: secret }
      ],
      sessionId: 'session',
      workspaceId: 'workspace',
      scratch: '/scratch',
      selected: { id: 'expected', command: [secret] }
    })
  } catch (error) {
    failure = nativeFailureDiagnostic(error)
  }
  expect(failure.guardId).toBe('profile.selected-id')
  expect(JSON.stringify(failure)).not.toContain(secret)
})

it.each(['transport', 'cwd', 'model', 'executable'])(
  'binds actual provider %s failures to a distinct guard',
  (field) => {
    const session = {
      provider: 'codex',
      adapterId: 'codex-chat',
      transport: 'events',
      cwd: '/scratch'
    }
    const event = { type: 'session_meta', model: 'gpt-6.1-sol', providerSessionId: 'thread' }
    if (field === 'transport') session.transport = 'pty'
    if (field === 'cwd') session.cwd = '/SYNTHETIC_PRIVATE_DIRECTORY'
    if (field === 'model') event.model = 'SYNTHETIC_PRIVATE_MODEL'
    let failure
    try {
      proveCodexProcess(
        {
          serverPid: 1,
          scratch: '/scratch',
          expected: { sha256: 'fixture', executable: '/fixture/codex' },
          session,
          history: { items: [{ event }] }
        },
        { parents: () => [{ pid: 1, ppid: 0 }], canonical: (value) => value }
      )
    } catch (error) {
      failure = nativeFailureDiagnostic(error)
    }
    expect(failure.guardId).toBe(
      field === 'executable' ? 'process.installed-executable' : 'provider.' + field
    )
    expect(JSON.stringify(failure)).not.toContain('SYNTHETIC_PRIVATE')
  }
)
