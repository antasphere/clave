/* eslint-disable @typescript-eslint/explicit-function-return-type -- A plugin ships as standalone CommonJS; it is not part of the app's TypeScript program. */
'use strict'

/**
 * The bundled example of a plugin-supplied agent provider.
 *
 * It answers from the message it is given: no model, no network, no child
 * process. What it demonstrates is the contract — the manifest's command
 * reaching the adapter, a correlated tool call, a permission request, and an
 * event the host is expected to drop.
 */
exports.createAdapter = (launch, emit) => {
  let turn = 0
  let pending = null
  const state = (value) => emit({ type: 'state_change', state: value })
  return {
    async start() {
      emit({ type: 'session_meta', model: 'echo-1', providerSessionId: null })
    },
    async send(text) {
      emit({ type: 'user_message', text })
      state('working')
      if (text.trim() === '!permission') {
        pending = `ask-${++turn}`
        emit({
          type: 'permission_request',
          id: pending,
          description: 'Echo this message back?',
          toolName: 'Echo',
          input: { text },
          options: [
            { id: 'allow', label: 'Allow once' },
            { id: 'deny', label: 'Deny' }
          ]
        })
        state('blocked')
        return
      }
      if (text.trim() === '!invalid') {
        // Deliberately malformed: the host must drop this and still deliver what follows.
        emit({ type: 'assistant_text', delta: 42, final: 'yes' })
        emit({ type: 'assistant_text', delta: 'The invalid event was dropped.', final: true })
        state('done')
        return
      }
      const id = `call-${++turn}`
      emit({
        type: 'assistant_text',
        delta: `Echo from ${launch.command.join(' ')}: ${text}`,
        final: true
      })
      emit({ type: 'tool_call', id, name: 'echo', input: { text, cwd: launch.cwd } })
      emit({ type: 'tool_result', id, output: text })
      state('done')
    },
    async interrupt() {
      state('idle')
    },
    async respond(response) {
      if (response.id !== pending) throw new Error(`Unknown request: ${response.id}`)
      pending = null
      emit({
        type: 'assistant_text',
        delta: response.optionId === 'allow' ? 'Allowed, and echoed.' : 'Denied, nothing echoed.',
        final: true
      })
      state('done')
    },
    async models() {
      return [{ id: 'echo-1', label: 'Echo 1', hint: 'Repeats what you say' }]
    },
    async commands() {
      return [
        { name: 'permission', description: 'Ask for permission first', insert: '!permission' },
        { name: 'invalid', description: 'Emit an event the host must drop', insert: '!invalid' }
      ]
    },
    async dispose() {
      pending = null
    }
  }
}
