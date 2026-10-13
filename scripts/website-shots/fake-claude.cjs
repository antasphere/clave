#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks its stream-json protocol, so the
// chat view renders a real-looking turn without ever calling a model.
//
// The shape of every frame follows the recorded turns in
// src/main/sessions/fixtures/claude-stream/ (real-turn.ndjson for a finished
// turn, permission-turn.ndjson for a pending tool permission). The script of
// the conversation is in chat-script.cjs beside this file: each user message
// plays the next scripted turn. A turn may stop on a permission request; it
// then waits for the host's control_response, exactly like the real CLI.
const readline = require('node:readline')
const path = require('node:path')

// The title one-shot (`claude -p --model haiku`, title-generator.ts) is the
// one invocation without a session id: answer with a title and leave.
if (!process.argv.includes('--session-id')) {
  process.stdin.resume()
  process.stdin.on('end', () => {
    process.stdout.write('Checkout address validation\n')
    process.exit(0)
  })
  return
}

const argv = process.argv.slice(2)
const sid = argv[argv.indexOf('--session-id') + 1]
const { turns, MODEL } = require(path.join(__dirname, 'chat-script.cjs'))
const emit = (frame) => process.stdout.write(JSON.stringify({ ...frame, session_id: sid }) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let turn = 0
let waiting = null // the resume function of a turn paused on a permission

async function play(frames) {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    mcp_servers: [],
    model: MODEL,
    permissionMode: 'default',
    slash_commands: ['compact', 'clear', 'review']
  })
  for (const frame of frames) {
    if (frame.pause) {
      await new Promise((resume) => (waiting = resume))
      continue
    }
    await sleep(frame.delay ?? 60)
    const rest = { ...frame }
    delete rest.delay
    emit(rest)
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let input
  try {
    input = JSON.parse(line)
  } catch {
    return
  }
  if (input.type === 'control_request') {
    const response =
      input.request?.subtype === 'initialize'
        ? { models: [{ value: 'opus', displayName: 'Opus', resolvedModel: MODEL }] }
        : undefined
    emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: input.request_id,
        ...(response ? { response } : {})
      }
    })
    return
  }
  if (input.type === 'control_response' && waiting) {
    const resume = waiting
    waiting = null
    resume()
    return
  }
  if (input.type !== 'user') return
  const frames = turns[turn++]
  if (frames) void play(frames)
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1000)
