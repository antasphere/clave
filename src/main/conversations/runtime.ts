import { app, BrowserWindow, dialog } from 'electron'
import { statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ConversationOptions,
  ConversationSession,
  ConversationSnapshot
} from '../../shared/agent-session'
import { ConversationClient } from './client'
import type { AdapterLaunch } from './adapter'
import { launchProfileManager } from '../launch-profile-manager'
import {
  accountTokenForSpawn,
  buildSpawnEnv,
  getLoginShellEnv,
  ptyManager,
  type PtySpawnOptions
} from '../pty-manager'
import { writeSessionMcpConfig, deleteSessionMcpConfig } from '../mcp/mcp-runtime'
import { windowRegistry } from '../window-registry'
import { windowState } from '../window-state'
import { conversationProviderForSpawn } from './launch'
import { addTrustedRoot, isUnderTrustedRoot } from '../ipc-handlers/clave-file-handlers'
import { runtimePluginRegistry } from '../runtime-plugins/registry-runtime'
import { revokePluginSessionViews } from '../runtime-plugins/host'

let connection: Promise<ConversationClient> | undefined

export function isConversationId(id: string): boolean {
  return /^conversation-[0-9a-f-]{36}$/i.test(id)
}

export async function conversationClient(): Promise<ConversationClient> {
  const previous = connection
  if (previous) {
    const client = await previous
    if (client.isConnected()) return client
    if (connection === previous) connection = undefined
    // Only establish a new transport. Never retry an uncertain mutation.
    return conversationClient()
  }
  if (!connection) {
    connection = ConversationClient.connect({ userData: app.getPath('userData') })
      .then((client) => {
        client.onEvent((event) => {
          for (const win of windowRegistry.listWindows()) {
            if (!win.isDestroyed()) win.webContents.send('conversation:event', event)
          }
        })
        return client
      })
      .catch((error) => {
        connection = undefined
        throw error
      })
  }
  return connection
}

/** A view disconnect never closes its provider process. */
export function disconnectConversationClient(): void {
  const current = connection
  connection = undefined
  void current?.then((client) => client.disconnect()).catch(() => {})
}

function validateDirectory(cwd: string): void {
  if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('The conversation working directory must be an existing absolute directory')
  }
}

async function requireWorkspaceTrust(win: BrowserWindow | null, cwd: string): Promise<void> {
  if (isUnderTrustedRoot(cwd)) return
  if (!win || win.isDestroyed()) throw new Error('Open the conversation to review workspace trust')
  // Headless CLIs can load repository hooks/plugins before tool permission
  // requests exist. The terminal's own workspace trust prompt no longer runs.
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Trust this folder?',
    message: 'Allow coding agents to load configuration from this folder?',
    detail: `${cwd}\n\nAgent configuration, plugins, and startup hooks may execute code before a tool approval prompt. Continue only if you trust this folder and its contents.`,
    buttons: ['Cancel', 'Trust folder and continue'],
    defaultId: 0,
    cancelId: 0
  })
  if (answer.response !== 1) throw new Error('Conversation cancelled: folder was not trusted')
  addTrustedRoot(cwd)
}

function launchFor(options: ConversationOptions, sessionId?: string): AdapterLaunch {
  validateDirectory(options.cwd)
  const registered = runtimePluginRegistry().resolveProvider(
    options.provider,
    options.pluginBindings?.provider
  )
  const profile = launchProfileManager.resolve(
    options.provider,
    options.workspaceId,
    options.launchProfileId,
    { name: registered.descriptor.name, command: registered.command }
  )
  const env = buildSpawnEnv(
    getLoginShellEnv(),
    options.provider === 'claude'
      ? {
          configDir: options.configDir,
          oauthToken: accountTokenForSpawn('claude', options.claudeProfileId)
        }
      : {}
  )
  // Electron's Node mode is for the supervisor only, not a user's CLI.
  delete env.ELECTRON_RUN_AS_NODE
  if (options.provider !== 'claude') {
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    delete env.CLAUDE_CONFIG_DIR
  }
  if (sessionId) env.CLAVE_SESSION_ID = sessionId
  return {
    command: profile.command,
    additionalArgs: profile.additionalArgs,
    env,
    sessionDirectory: join(
      app.getPath('userData'),
      'conversations',
      'providers',
      sessionId ?? 'pending'
    ),
    options: { ...options, launchProfileId: profile.id },
    mcpConfigPath:
      options.provider === 'claude' && sessionId
        ? (writeSessionMcpConfig(sessionId) ?? undefined)
        : undefined
  }
}

/** Resolve and validate the concrete launch before creating or stopping anything. */
export async function prepareConversation(
  win: BrowserWindow,
  input: ConversationOptions
): Promise<{ options: ConversationOptions; launch: AdapterLaunch }> {
  validateDirectory(input.cwd)
  await requireWorkspaceTrust(win, input.cwd)
  const workspaceId = input.workspaceId ?? windowRegistry.getWorkspaceForWindow(win.id) ?? undefined
  const profile = launchProfileManager.resolve(input.provider, workspaceId, input.launchProfileId)
  const options: ConversationOptions = {
    ...input,
    pluginBindings: runtimePluginRegistry().bindingsFor(input.provider),
    title: input.title ?? basename(input.cwd),
    workspaceId,
    windowKey: windowRegistry.getKeyForWindow(win.id) ?? undefined,
    launchProfileId: profile?.id,
    model: input.model ?? (input.provider === 'pi' ? profile?.pi?.model : undefined),
    piProvider: input.piProvider ?? (input.provider === 'pi' ? profile?.pi?.provider : undefined),
    piThinking: input.piThinking ?? (input.provider === 'pi' ? profile?.pi?.thinking : undefined)
  }
  return { options, launch: launchFor(options) }
}

export async function createConversation(
  win: BrowserWindow,
  input: ConversationOptions
): Promise<ConversationSnapshot> {
  const { options, launch } = await prepareConversation(win, input)
  const client = await conversationClient()
  const snapshot = await client.create(options, launch)
  windowRegistry.bindSession(snapshot.session.id, win.id)
  return snapshot
}

export async function sendConversation(id: string, text: string, commandId: string): Promise<void> {
  const client = await conversationClient()
  const snapshot = await ensureConversationPlugins(id)
  await requireWorkspaceTrust(windowRegistry.getWindowForSession(id), snapshot.session.cwd)
  await client.send(
    id,
    text,
    commandId,
    snapshot.providerConnected
      ? undefined
      : {
          ...launchFor(snapshot.session, id),
          providerSessionId: snapshot.session.providerSessionId
        }
  )
}

export async function closeConversation(id: string): Promise<void> {
  const client = await conversationClient()
  const { session } = await client.snapshot(id)
  if (session.legacyImport?.complete === false) {
    await ptyManager.stopAndForgetLegacyRecord(session.legacyImport)
    windowRegistry.unbindSession(session.legacyImport.sourceId)
  }
  revokePluginSessionViews(id)
  await client.close(id)
  deleteSessionMcpConfig(id)
  windowRegistry.unbindSession(id)
}

/** Adopt pre-plugin conversation records once; never replace an existing pin. */
export async function ensureConversationPlugins(id: string): Promise<ConversationSnapshot> {
  const client = await conversationClient()
  let snapshot = await client.snapshot(id)
  if (!snapshot.session.pluginBindings) {
    await client.bindPlugins(id, runtimePluginRegistry().bindingsFor(snapshot.session.provider))
    snapshot = await client.snapshot(id)
  }
  return snapshot
}

export async function listConversations(win: BrowserWindow): Promise<ConversationSession[]> {
  const client = await conversationClient()
  const sessions = await client.list()
  const key = windowRegistry.getKeyForWindow(win.id)
  const knownKeys = new Set(windowState.list().map((record) => record.key))
  const visible: ConversationSession[] = []
  for (const session of sessions) {
    if (session.status === 'closed') continue
    const orphan = !session.windowKey || !knownKeys.has(session.windowKey)
    if (session.windowKey !== key && !(orphan && windowRegistry.isPrimary(win.id))) continue
    if (key && session.windowKey !== key) {
      await client.updateMetadata(session.id, { windowKey: key })
      session.windowKey = key
    }
    windowRegistry.bindSession(session.id, win.id)
    visible.push(session)
  }
  return visible
}

export async function spawnConversation(
  win: BrowserWindow,
  cwd: string,
  options?: PtySpawnOptions
): Promise<{
  id: string
  cwd: string
  folderName: string
  alive: boolean
  claudeSessionId: string | null
  piSessionId: string | null
  launchProfileId?: string
  model?: string
  piProvider?: string
  piThinking?: string
}> {
  const provider = conversationProviderForSpawn(options)
  if (!provider) throw new Error('This launch is not a conversation')
  const snapshot = await createConversation(win, {
    provider,
    cwd,
    workspaceId: options?.workspaceId,
    launchProfileId: options?.launchProfileId,
    claudeProfileId: options?.claudeProfileId,
    configDir: options?.configDir,
    model: options?.model,
    piProvider: options?.piProvider,
    piThinking: options?.piThinking,
    dangerousMode: options?.dangerousMode,
    resumeSessionId: options?.resumeSessionId
  })
  if (options?.initialPrompt) {
    // Return the tab even if launch fails, so the user can see and recover the
    // persisted error instead of leaving an invisible session in the service.
    void sendConversation(snapshot.session.id, options.initialPrompt, randomUUID()).catch(() => {})
  }
  const session = snapshot.session
  return {
    id: session.id,
    cwd,
    folderName: basename(cwd),
    alive: true,
    claudeSessionId:
      provider === 'claude'
        ? (session.providerSessionId ?? options?.resumeSessionId ?? null)
        : null,
    piSessionId:
      provider === 'pi' ? (session.providerSessionId ?? options?.resumeSessionId ?? null) : null,
    launchProfileId: session.launchProfileId,
    model: session.model,
    piProvider: session.piProvider,
    piThinking: session.piThinking
  }
}
