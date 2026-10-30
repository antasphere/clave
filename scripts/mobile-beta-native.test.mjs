import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderNativeFlow } from './mobile-beta-native.mjs'
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
