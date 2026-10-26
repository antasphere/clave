/** Agent MCP belongs to the standalone server. Local provider processes use
 * loopback and per-session tokens, independently of every desktop client. */
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentTokensService, SessionHostService } from '@clave/server'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import type { SidebarLayouts } from '@clave/server/sidebar-layouts'
import { resolveProfileRef, resolveSpawnModes } from '../../shared/open-session-modes'
import type { SecretAction } from '../../../packages/contract/src/requests'
import type { PendingRequests } from '../../../packages/server/src/requests/service'

export interface StandaloneMcpOptions {
  readonly sessions: SessionHostService
  readonly agentTools: AgentTokensService
  readonly requests: PendingRequests
  readonly executeSecret: (action: SecretAction, value: string) => Promise<void>
  /** The daemon's one sidebar, where the groups live; absent, the group tools
   *  say this server keeps none. */
  readonly sidebar?: SidebarLayouts | undefined
}
/** Who opened which tab through `clave_open_session`, kept as long as this
 *  listener lives: the desktop's parent link does not survive a restart
 *  either. */
type Parents = Map<string, string>
/** The size a session with no pane starts at, as the desktop's hidden spawns. */
const HIDDEN_COLS = 120
const HIDDEN_ROWS = 30
const DESKTOP_ONLY = ['account', 'window', 'workspace'] as const
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

function buildServer(
  options: StandaloneMcpOptions,
  sessionId: string,
  parents: Parents
): McpServer {
  const { sessions, requests, sidebar } = options
  const own = (id: string): string => (id === 'mine' ? sessionId : id)
  const known = (id: string): string => {
    const resolved = own(id)
    if (!sessions.get(resolved)) throw new Error(`Unknown session "${id}".`)
    return resolved
  }
  const groups = (): SidebarLayouts => {
    if (!sidebar) throw new Error('This server keeps no groups.')
    return sidebar
  }
  const knownGroup = (groupId: string): string => {
    if (
      !groups()
        .get(SERVER_LAYOUT_KEY)
        .groups.some((g) => g.id === groupId)
    )
      throw new Error(`Unknown group "${groupId}".`)
    return groupId
  }
  const server = new McpServer(
    { name: 'clave-server', version: '1' },
    {
      instructions:
        'Your Clave tools run on this server without a desktop. Ask for approval, clarification or a secret with clave_request_approval, clave_request_clarification or clave_request_secret. Calls return a requestId. Poll clave_request_result or clave_secret_result while pending; clients can answer later. Secret values and action output are never returned. Delegate work to a new tab with clave_open_session, then message it with clave_send_to_session and close it with clave_close_session; clave_create_group, clave_move_session and clave_rename organize the tabs. Sessions and paths are server-local.'
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
    async () =>
      text({
        sessions: sessions.list().map((s) => {
          const parentId = parents.get(s.id)
          return parentId ? { ...s, parentId } : s
        })
      })
  )
  server.registerTool(
    'clave_open_session',
    {
      description:
        'Open a new tab on this server: a Claude or Codex agent (in the chat view unless chat is false), an Antigravity or Pi agent, or a plain terminal, in an absolute directory, with an optional model, name, first prompt and group. Returns the new sessionId; the tab is linked to its caller, so clave_list reports its parentId and clave_send_to_session and clave_read_session reach it.',
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the working directory'),
        mode: z.enum(['claude', 'codex', 'antigravity', 'gemini', 'pi', 'terminal']).optional(),
        model: z.string().min(1).max(256).optional(),
        name: z.string().min(1).max(255).optional().describe('Display name for the new tab'),
        prompt: boundedText.optional().describe('First message an agent tab starts on'),
        command: boundedText.optional().describe('Shell command a terminal tab runs'),
        dangerous: z
          .boolean()
          .optional()
          .describe('Start a claude or codex agent without approval prompts'),
        chat: z
          .boolean()
          .optional()
          .describe('Claude and Codex open in the chat view unless this is false'),
        profile: z.string().min(1).max(256).optional().describe('A launch profile id'),
        groupId: z.string().min(1).max(256).optional().describe('Group id from clave_create_group'),
        // Named so a desktop-shaped call fails clearly instead of being stripped.
        account: z.unknown().optional(),
        window: z.unknown().optional(),
        workspace: z.unknown().optional()
      }
    },
    async (args) => {
      const unsupported = DESKTOP_ONLY.filter((key) => args[key] !== undefined)
      if (unsupported.length > 0)
        throw new Error(
          `${unsupported.join(', ')} ${unsupported.length > 1 ? 'are' : 'is'} not available on a standalone server.`
        )
      if (!isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path.')
      const directory = await stat(args.cwd).catch(() => undefined)
      if (!directory?.isDirectory()) throw new Error(`no such directory: ${args.cwd}`)
      const groupId = args.groupId === undefined ? null : knownGroup(args.groupId)
      const mode = args.mode ?? 'claude'
      const { claudeMode, antigravityMode, codexMode, piMode, dangerousMode, model } =
        resolveSpawnModes({
          mode,
          ...(args.dangerous !== undefined ? { dangerous: args.dangerous } : {}),
          ...(args.model !== undefined ? { model: args.model } : {})
        })
      const launchProfileId = resolveProfileRef({
        mode,
        // The chat view is the standalone default; a named profile decides for itself.
        chat: args.chat ?? (args.profile === undefined && (mode === 'claude' || mode === 'codex')),
        ...(args.profile !== undefined ? { profile: args.profile } : {})
      })
      const terminal = mode === 'terminal'
      const info = await sessions.start({
        cwd: args.cwd,
        options: {
          claudeMode,
          antigravityMode,
          codexMode,
          piMode,
          dangerousMode,
          ...(model !== undefined ? { model } : {}),
          ...(launchProfileId !== undefined ? { launchProfileId } : {}),
          ...(terminal && args.command ? { initialCommand: args.command } : {}),
          autoExecute: terminal && !!args.command,
          ...(!terminal && args.prompt ? { initialPrompt: args.prompt } : {})
        }
      })
      parents.set(info.id, sessionId)
      if (args.name) sessions.rename(info.id, args.name)
      if (groupId) groups().moveItems(SERVER_LAYOUT_KEY, [info.id], groupId, 'inside')
      // A terminal starts its process at its first size; no window gives it one here.
      if (sessions.get(info.id)?.transport === 'pty') {
        try {
          sessions.resize(info.id, HIDDEN_COLS, HIDDEN_ROWS)
        } catch {
          // A terminal that cannot be sized stays listed; its read says why.
        }
      }
      return text({ sessionId: info.id, groupId })
    }
  )
  server.registerTool(
    'clave_close_session',
    {
      description: 'Close a session on this server, stopping its process.',
      inputSchema: {
        sessionId: z.string().describe('Id of the session to close, or "mine" for the calling tab')
      }
    },
    async (args) => {
      const id = known(args.sessionId)
      await sessions.stop(id)
      parents.delete(id)
      return text({ closed: id })
    }
  )
  server.registerTool(
    'clave_rename',
    {
      description: 'Rename a group or a session (tab) on this server.',
      inputSchema: {
        target: z.enum(['group', 'session']),
        id: z.string().describe('Group id, or session id ("mine" for the calling tab)'),
        name: z.string().min(1).max(255).describe('New display name')
      }
    },
    async (args) => {
      if (args.target === 'session') {
        const id = known(args.id)
        sessions.rename(id, args.name)
        return text({ renamed: id })
      }
      const renamed = groups().renameGroup(SERVER_LAYOUT_KEY, args.id, args.name)
      if (!renamed.ok) throw new Error(`Unknown group "${args.id}".`)
      return text({ renamed: args.id })
    }
  )
  server.registerTool(
    'clave_create_group',
    {
      description:
        "Create an empty group in this server's sidebar and return its groupId. Put tabs in it with clave_open_session or clave_move_session.",
      inputSchema: { name: z.string().min(1).max(255).describe('Display name for the group') }
    },
    async (args) => {
      const { group } = groups().createGroup(SERVER_LAYOUT_KEY, { name: args.name })
      return text({ groupId: group.id })
    }
  )
  server.registerTool(
    'clave_move_session',
    {
      description: "Move a session into a group of this server's sidebar.",
      inputSchema: {
        sessionId: z.string().describe('Id of the session to move, or "mine" for the calling tab'),
        groupId: z.string().describe('Group id from clave_create_group')
      }
    },
    async (args) => {
      const id = known(args.sessionId)
      const groupId = knownGroup(args.groupId)
      groups().moveItems(SERVER_LAYOUT_KEY, [id], groupId, 'inside')
      return text({ sessionId: id, groupId })
    }
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
  const parents: Parents = new Map()
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
    const server = buildServer(options, owner.sessionId, parents)
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
