/** Agent MCP belongs to the standalone server. Local provider processes use
 * loopback and per-session tokens, independently of every desktop client. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentTokensService, SessionHostService } from '@clave/server'
import type { SecretAction } from '../../../packages/contract/src/requests'
import type { PendingRequests } from '../../../packages/server/src/requests/service'

export interface StandaloneMcpOptions {
  readonly sessions: SessionHostService
  readonly agentTools: AgentTokensService
  readonly requests: PendingRequests
  readonly executeSecret: (action: SecretAction, value: string) => Promise<void>
}
const text = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value) }]
})
const boundedText = z.string().min(1).max(16_384)
const question = z.object({
  question: boundedText,
  header: z.string().max(256).optional(),
  options: z.array(z.object({ label: boundedText, description: boundedText.optional() })).max(100),
  multiSelect: z.boolean().optional()
})
const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run'),
    command: boundedText,
    cwd: boundedText,
    envVar: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .default('SECRET')
  }),
  z.object({
    type: z.literal('env-file'),
    file: boundedText,
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  })
])

function buildServer(options: StandaloneMcpOptions, sessionId: string): McpServer {
  const { sessions, requests } = options
  const server = new McpServer(
    { name: 'clave-server', version: '1' },
    {
      instructions:
        'Your Clave tools run on this server without a desktop. Ask for approval, clarification or a secret with clave_request_approval, clave_request_clarification or clave_request_secret. Calls return a requestId. Poll clave_request_result or clave_secret_result while pending; clients can answer later. Secret values and action output are never returned. Sessions and paths are server-local.'
    }
  )
  server.registerTool(
    'clave_request_approval',
    {
      description:
        'Ask the user to approve a described action. It waits on this server with no client; poll the returned requestId.',
      inputSchema: { description: boundedText }
    },
    async ({ description }) => {
      const request = requests.create({
        sessionId,
        kind: 'permission',
        description,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' }
        ]
      })
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  server.registerTool(
    'clave_request_clarification',
    {
      description:
        'Ask the user one or more questions. Requests wait without a desktop and are shared across attached clients. Poll the returned requestId.',
      inputSchema: { description: boundedText, questions: z.array(question).min(1).max(20) }
    },
    async ({ description, questions }) => {
      const request = requests.create({ sessionId, kind: 'clarification', description, questions })
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  server.registerTool(
    'clave_request_secret',
    {
      description:
        'Ask for a sensitive value through a private client input, then run the exact action on this server. The secret and action output are never returned. Poll clave_secret_result with requestId.',
      inputSchema: {
        description: boundedText,
        action: actionSchema,
        timeoutSeconds: z.number().int().min(0).max(300).optional()
      }
    },
    async ({ description, action }) => {
      if (action.type === 'run') {
        if (
          !isAbsolute(action.cwd) ||
          (!action.command.includes(`$${action.envVar}`) &&
            !action.command.includes(`\${${action.envVar}}`))
        )
          throw new Error(
            'Use an absolute cwd and reference the secret through the named environment variable.'
          )
      } else if (!isAbsolute(action.file)) throw new Error('Use an absolute env-file path.')
      const request = requests.create(
        { sessionId, kind: 'secret', description, action },
        async (response) => {
          if (response.type === 'secret') await options.executeSecret(action, response.value)
        }
      )
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  for (const name of ['clave_request_result', 'clave_secret_result'])
    server.registerTool(
      name,
      {
        description:
          'Poll a request created by this session. Pending requests survive client disconnection; terminal results expire after ten minutes. Secret values and action output are absent.',
        inputSchema: {
          requestId: z.string().min(1).max(256),
          waitSeconds: z.number().min(0).max(300).optional()
        }
      },
      async ({ requestId }) => text(requests.result(requestId, sessionId))
    )
  server.registerTool(
    'clave_list',
    {
      description: 'List sessions owned by this server, including stopped records.',
      inputSchema: {}
    },
    async () => text({ sessions: sessions.list() })
  )
  server.registerTool(
    'clave_read_session',
    {
      description: 'Read the recent output/history of a server session.',
      inputSchema: {
        sessionId: z.string().default('mine'),
        lines: z.number().int().min(1).max(500).default(100)
      }
    },
    async (args) => {
      const id = args.sessionId === 'mine' ? sessionId : args.sessionId
      const session = sessions.get(id)
      if (!session) throw new Error('Unknown session.')
      return text(
        session.transport === 'pty'
          ? await sessions.screen(id, args.lines)
          : sessions.history(id, undefined, args.lines)
      )
    }
  )
  server.registerTool(
    'clave_send_to_session',
    {
      description: 'Send a message to an existing server session.',
      inputSchema: { sessionId: z.string(), message: boundedText }
    },
    async (args) =>
      text(
        await sessions.type(args.sessionId === 'mine' ? sessionId : args.sessionId, args.message)
      )
  )
  return server
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > 256 * 1024) throw new Error('MCP body exceeds limit')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startStandaloneMcp(options: StandaloneMcpOptions): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> {
  const sockets = new Set<Socket>()
  const active = new Set<McpServer>()
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    // Derive identity only from the existing per-session token store.
    const auth = request.headers.authorization
    const owner = auth?.startsWith('Bearer ')
      ? options.agentTools.resolve(auth.slice(7))
      : undefined
    if (!owner || !options.sessions.get(owner.sessionId)) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    let body: unknown
    try {
      body = await readBody(request)
    } catch {
      response.writeHead(400).end()
      return
    }
    const server = buildServer(options, owner.sessionId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    active.add(server)
    response.once('close', () => {
      active.delete(server)
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response, body)
  }
  const node = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end()
      else response.end()
    })
  })
  node.requestTimeout = 10_000
  node.headersTimeout = 10_000
  node.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    node.once('error', reject)
    node.listen(0, '127.0.0.1', () => {
      node.off('error', reject)
      resolve()
    })
  })
  const address = node.address()
  if (!address || typeof address === 'string') throw new Error('MCP listener unavailable')
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      (closing ??= (async () => {
        const closed = new Promise<void>((resolve) => node.close(() => resolve()))
        for (const server of active) await server.close()
        for (const socket of sockets) socket.destroy()
        await closed
      })())
  }
}
