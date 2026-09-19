/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Standalone built plugin example. */
const { randomUUID } = require('node:crypto')

exports.createAdapter = (launch, emit) => ({
  capabilities: {
    permissions: false,
    questions: false,
    resume: false,
    notice: 'Local demonstration only. No model or external commands are used.'
  },
  async start() {
    /* This example has no external process to initialize. */
  },
  async send(text) {
    const summary = {
      directory: launch.options.cwd,
      received: text,
      characters: text.length,
      words: text.trim().split(/\s+/).length
    }
    emit({
      type: 'message',
      message: {
        kind: 'message',
        id: randomUUID(),
        role: 'assistant',
        text: 'Here is a local report. Select Interactive report to try the view plugin.'
      }
    })
    emit({
      type: 'artifact',
      artifact: {
        kind: 'artifact',
        id: randomUUID(),
        title: 'Message report',
        mimeType: 'application/json',
        content: JSON.stringify(summary),
        fallback: `Received ${summary.words} words and ${summary.characters} characters.`
      }
    })
    emit({ type: 'turn-end', outcome: 'completed' })
  },
  async interrupt() {
    emit({ type: 'turn-end', outcome: 'interrupted' })
  },
  async respond() {
    throw new Error('The example does not ask questions')
  },
  async dispose() {
    /* This example owns no background resources. */
  }
})
