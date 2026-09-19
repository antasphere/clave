import { randomBytes } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ConversationSnapshot } from '../../shared/agent-session'
import type {
  PluginCapability,
  PluginPin,
  PluginRpcMethod,
  PluginViewDescriptor,
  PluginViewEntry,
  PluginViewLease
} from '../../shared/runtime-plugins'
import type { PluginJobScope } from './jobs'

export interface PluginViewDependencies {
  snapshot(sessionId: string): Promise<ConversationSnapshot>
  resolveView(
    sessionId: string,
    entry: PluginViewEntry,
    view: PluginViewDescriptor
  ): Promise<{ descriptor: PluginViewDescriptor; html: string }>
  isAvailable(plugin: PluginPin): boolean | Promise<boolean>
  cwd(sessionId: string): string | Promise<string>
  /** Optional core reader. The broker passes a canonical, session-scoped file path. */
  readFile?(path: string, maxBytes: number): Promise<string>
  confirm(
    ownerId: number,
    method: PluginRpcMethod,
    params: unknown,
    scope: PluginJobScope
  ): Promise<boolean>
  executeJob(scope: PluginJobScope, argv: string[], requestId: string): Promise<unknown>
  readJob(scope: PluginJobScope, id: string): Promise<unknown>
  cancelJob(scope: PluginJobScope, id: string): Promise<unknown>
  /** Must reject nonempty drafts rather than overwrite them. */
  setDraft(sessionId: string, text: string): Promise<unknown>
  send(scope: PluginJobScope, text: string, requestId: string): Promise<unknown>
  openFile(sessionId: string, path: string): Promise<unknown>
  openArtifact(sessionId: string, entryId: string): Promise<unknown>
}

const text = z.string().min(1).max(65_536)
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (s) => !isAbsolute(s) && !s.includes('\0') && !s.includes('\\') && !s.split('/').includes('..')
  )
const schemas = {
  'conversation.read': z.object({}).strict(),
  'composer.setDraft': z.object({ text }).strict(),
  'conversation.send': z.object({ text }).strict(),
  'workspace.readFile': z.object({ path: filePath }).strict(),
  'workspace.execute': z
    .object({
      argv: z
        .array(
          z
            .string()
            .max(8192)
            .refine((s) => !s.includes('\0'))
        )
        .min(1)
        .max(128)
    })
    .strict(),
  'workspace.jobRead': z.object({ jobId: z.string().min(1).max(200) }).strict(),
  'workspace.cancelJob': z.object({ jobId: z.string().min(1).max(200) }).strict(),
  'ui.openFile': z.object({ path: filePath }).strict(),
  'ui.openArtifact': z.object({ entryId: z.string().min(1).max(200) }).strict()
}
const requestSchema = z
  .object({
    id: z.string().min(1).max(200),
    method: z.enum(Object.keys(schemas) as [PluginRpcMethod, ...PluginRpcMethod[]]),
    params: z.unknown().optional()
  })
  .strict()
interface LeaseState {
  lease: PluginViewLease
  owner: number
  html: string
  served: boolean
  requests: Set<string>
  active: number
}

export async function scopedWorkspacePath(cwd: string, input: string): Promise<string> {
  filePath.parse(input)
  const root = await realpath(cwd)
  const path = await realpath(resolve(root, input))
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path outside workspace')
  }
  if (!(await stat(path)).isFile()) throw new Error('Not a file')
  return path
}

export async function readWorkspaceFile(cwd: string, input: string): Promise<string> {
  const path = await scopedWorkspacePath(cwd, input)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 262_144) throw new Error('Not a small text file')
    const buffer = Buffer.alloc(262_145)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 262_144) throw new Error('File too large')
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw new Error('Binary file denied')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    await handle.close()
  }
}

export class RuntimePluginViews {
  private leases = new Map<string, LeaseState>()
  private pendingOpens = new Map<number, number>()
  private ownerEpoch = new Map<number, number>()
  private sessionEpoch = new Map<string, number>()
  constructor(private deps: PluginViewDependencies) {}

  async open(
    owner: number,
    sessionId: string,
    entryId: string,
    view?: PluginViewDescriptor
  ): Promise<PluginViewLease> {
    const pending = this.pendingOpens.get(owner) ?? 0
    if (pending >= 16) throw new Error('View limit reached')
    this.pendingOpens.set(owner, pending + 1)
    const ownerEpoch = this.ownerEpoch.get(owner)
    const sessionEpoch = this.sessionEpoch.get(sessionId)
    try {
      return await this.createLease(
        owner,
        sessionId,
        entryId,
        view,
        () =>
          ownerEpoch === this.ownerEpoch.get(owner) &&
          sessionEpoch === this.sessionEpoch.get(sessionId)
      )
    } finally {
      const count = this.pendingOpens.get(owner)! - 1
      if (count) this.pendingOpens.set(owner, count)
      else this.pendingOpens.delete(owner)
    }
  }

  private async createLease(
    owner: number,
    sessionId: string,
    entryId: string,
    view: PluginViewDescriptor | undefined,
    stillOpen: () => boolean
  ): Promise<PluginViewLease> {
    const snapshot = await this.deps.snapshot(sessionId)
    const entry = snapshot.entries.find((e) => e.id === entryId)
    if (!entry || (entry.kind !== 'artifact' && entry.kind !== 'tool'))
      throw new Error('Entry unavailable')
    const resolved = view ? await this.deps.resolveView(sessionId, entry, view) : undefined
    if (resolved && !(await this.deps.isAvailable(resolved.descriptor.plugin)))
      throw new Error('Plugin unavailable')
    if (!resolved && (entry.kind !== 'artifact' || entry.mimeType !== 'text/html'))
      throw new Error('HTML view unavailable')
    const html = resolved?.html ?? (entry.kind === 'artifact' ? entry.content : '')
    if (Buffer.byteLength(html) > 1_048_576) throw new Error('View too large')
    if (
      this.leases.size >= 128 ||
      [...this.leases.values()].filter((s) => s.owner === owner).length >= 16
    ) {
      throw new Error('View limit reached')
    }
    if (!stillOpen()) throw new Error('View owner closed')
    const id = randomBytes(32).toString('hex')
    const lease: PluginViewLease = {
      id,
      url: `clave-plugin://view/${id}`,
      sessionId,
      entry: structuredClone(entry),
      view: resolved ? structuredClone(resolved.descriptor) : undefined,
      capabilities: resolved ? [...resolved.descriptor.capabilities] : []
    }
    this.leases.set(id, { lease, owner, html, served: false, requests: new Set(), active: 0 })
    return structuredClone(lease)
  }

  /** A lease can boot a document once, even if a host remounts or reloads its iframe. */
  html(id: string): string | undefined {
    const state = this.leases.get(id)
    if (!state || state.served) return undefined
    state.served = true
    return state.html
  }

  close(owner: number, id: string): void {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id)
  }

  revokeOwner(owner: number): void {
    this.ownerEpoch.set(owner, (this.ownerEpoch.get(owner) ?? 0) + 1)
    for (const [id, state] of this.leases) if (state.owner === owner) this.leases.delete(id)
  }

  revokeSession(sessionId: string): void {
    this.sessionEpoch.set(sessionId, (this.sessionEpoch.get(sessionId) ?? 0) + 1)
    for (const [id, state] of this.leases)
      if (state.lease.sessionId === sessionId) this.leases.delete(id)
  }

  async request(owner: number, id: string, input: unknown): Promise<unknown> {
    const state = this.leases.get(id)
    if (!state || state.owner !== owner) throw new Error('View unavailable')
    const request = requestSchema.parse(input)
    const params = schemas[request.method].parse(request.params === undefined ? {} : request.params)
    if (state.requests.has(request.id)) throw new Error('Request already consumed')
    if (state.requests.size >= 1024 || state.active >= 8) throw new Error('Request limit reached')
    state.requests.add(request.id)
    state.active++
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const capability: PluginCapability =
      request.method === 'workspace.jobRead' || request.method === 'workspace.cancelJob'
        ? 'workspace.execute'
        : request.method
    const check = async (): Promise<void> => {
      if (!state.lease.view || !state.lease.capabilities.includes(capability))
        throw new Error('Capability denied')
      const available = await this.deps.isAvailable(state.lease.view.plugin)
      if (!available || this.leases.get(id) !== state || expired)
        throw new Error('Capability denied')
    }
    const operation = async (): Promise<unknown> => {
      await check()
      const scope = { sessionId: state.lease.sessionId, plugin: state.lease.view!.plugin }
      if (request.method === 'conversation.send' || request.method === 'workspace.execute') {
        if (!(await this.deps.confirm(owner, request.method, params, scope)))
          throw new Error('User declined')
        await check()
        if (expired) throw new Error('Request expired')
      }
      switch (request.method) {
        case 'conversation.read':
          return this.deps.snapshot(scope.sessionId)
        case 'composer.setDraft':
          return this.deps.setDraft(scope.sessionId, (params as { text: string }).text)
        case 'conversation.send':
          return this.deps.send(scope, (params as { text: string }).text, `${id}:${request.id}`)
        case 'workspace.readFile': {
          const cwd = await this.deps.cwd(scope.sessionId)
          const inputPath = (params as { path: string }).path
          if (!this.deps.readFile) return readWorkspaceFile(cwd, inputPath)
          const path = await scopedWorkspacePath(cwd, inputPath)
          if ((await stat(path)).size > 262_144) throw new Error('File too large')
          const result = await this.deps.readFile(path, 262_144)
          if (Buffer.byteLength(result) > 262_144 || result.includes('\0'))
            throw new Error('Not a small text file')
          await check()
          return result
        }
        case 'workspace.execute':
          return this.deps.executeJob(
            scope,
            (params as { argv: string[] }).argv,
            `${id}:${request.id}`
          )
        case 'workspace.jobRead':
          return this.deps.readJob(scope, (params as { jobId: string }).jobId)
        case 'workspace.cancelJob':
          return this.deps.cancelJob(scope, (params as { jobId: string }).jobId)
        case 'ui.openFile': {
          const path = await scopedWorkspacePath(
            await this.deps.cwd(scope.sessionId),
            (params as { path: string }).path
          )
          await check()
          if (expired) throw new Error('Request expired')
          return this.deps.openFile(scope.sessionId, path)
        }
        case 'ui.openArtifact': {
          const entryId = (params as { entryId: string }).entryId
          const snapshot = await this.deps.snapshot(scope.sessionId)
          if (!snapshot.entries.some((e) => e.id === entryId && e.kind === 'artifact'))
            throw new Error('Artifact unavailable')
          await check()
          if (expired) throw new Error('Request expired')
          return this.deps.openArtifact(scope.sessionId, entryId)
        }
      }
    }
    try {
      return await Promise.race([
        operation().finally(() => {
          state.active--
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true
            reject(new Error('Request timed out'))
          }, 30_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
