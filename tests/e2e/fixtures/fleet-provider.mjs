// Local recording adapter for the real Codex stdio translator. This process
// makes no network calls and never invokes a model or a real agent CLI.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (['fleet-native-approval', 'fleet-native-question'].includes(frame.id) && frame.result) {
    appendFileSync(
      path.join(process.cwd(), 'provider-replies.jsonl'),
      JSON.stringify(frame) + '\n',
      { mode: 0o600 }
    )
    return
  }
  if (frame.id === undefined) return
  send({
    id: frame.id,
    result: frame.method === 'thread/start' ? { thread: { id: 'fleet-thread' } } : {}
  })
  if (frame.method === 'thread/start') {
    if (process.argv.includes('--fleet-history')) {
      send({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'fleet-history-item',
            text: 'Durable recovery recording provider'
          }
        }
      })
      return
    }
    send({
      id: 'fleet-native-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'fleet-thread',
        turnId: 'fleet-turn',
        itemId: 'approval-item',
        command: 'printf fixture',
        cwd: process.cwd(),
        reason: 'Fleet native approval without a Mac',
        availableDecisions: ['accept', 'decline']
      }
    })
    send({
      id: 'fleet-native-question',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'fleet-thread',
        turnId: 'fleet-turn',
        itemId: 'question-item',
        isBlocking: true,
        questions: [
          {
            id: 'fleet-private-id',
            header: 'Private',
            question: 'Fleet native private input?',
            isSecret: true,
            options: null
          }
        ]
      }
    })
  }
})
