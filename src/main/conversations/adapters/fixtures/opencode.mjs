/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript CLI fixture. */
import { createServer } from 'node:http'
const expected = `Basic ${Buffer.from(`clave:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
let stream
let turn = 0
const event = (type, properties) => stream.write(`data: ${JSON.stringify({ type, properties: { sessionID: 'oc-session', ...properties } })}\r\n\r\n`)
const finish = () => event('session.status', { status: { type: 'idle' } })
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expected || !process.env.OPENCODE_SERVER_PASSWORD) {
    res.writeHead(401).end()
    return
  }
  const path = new URL(req.url, 'http://localhost').pathname
  let data = ''
  for await (const part of req) data += part
  const body = data ? JSON.parse(data) : {}
  const json = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)) }
  if (path === '/global/health') return json({ healthy: true, version: '1.18.15' })
  if (path === '/event') {
    stream = res
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(': ready\r\n\r\n')
    return
  }
  if (path === '/session' && process.env.EXPECT_RESUME) return res.writeHead(400).end()
  if (path === '/session' || path === '/session/oc-session') return json({ id: 'oc-session' })
  if (path === '/session/oc-session/prompt_async') {
    res.writeHead(204).end()
    const text = body.parts[0].text
    if (text === 'wait') return
    if (text === 'crash') return process.exit(7)
    if (text === 'malformed') return stream.write('data: not-json\n\n')
    if (text === 'unknown') return event('permission.future', {})
    if (text === 'question') return event('question.asked', { id: 'question', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })
    if (text === 'permission') return event('permission.asked', { id: 'approval', permission: 'bash', patterns: ['echo safe'] })
    turn++
    event('message.updated', { info: { sessionID: 'oc-session', id: `m${turn}`, role: 'assistant' } })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: `m${turn}`, id: `tool${turn}`, type: 'tool', tool: 'read', state: { status: 'running', input: { path: 'file' } } } })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: `m${turn}`, id: `tool${turn}`, type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'file' }, output: 'read' } } })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: `m${turn}`, id: `p${turn}`, type: 'text', text: '' } })
    event('message.part.delta', { messageID: `m${turn}`, partID: `p${turn}`, field: 'text', delta: 'héllo' })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: `m${turn}`, id: `p${turn}`, type: 'text', text: 'héllo' } })
    finish()
    return
  }
  if (path === '/permission/approval/reply') {
    if (!['once', 'reject'].includes(body.reply)) return res.writeHead(400).end()
    json(true)
    event('message.updated', { info: { sessionID: 'oc-session', id: 'decision', role: 'assistant' } })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: 'decision', id: 'decision', type: 'text', text: body.reply } })
    finish()
    return
  }
  if (path === '/question/question/reply') {
    json(true)
    event('message.updated', { info: { sessionID: 'oc-session', id: 'answer', role: 'assistant' } })
    event('message.part.updated', { part: { sessionID: 'oc-session', messageID: 'answer', id: 'answer', type: 'text', text: JSON.stringify(body.answers) } })
    finish()
    return
  }
  if (path === '/session/oc-session/abort') { json(true); finish(); return }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`))
