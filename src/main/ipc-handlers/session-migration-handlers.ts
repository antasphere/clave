import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { LegacyMigrationCoordinator } from '../conversations/legacy-migration'
import {
  conversationClient,
  disconnectConversationClient,
  isConversationId,
  prepareConversation
} from '../conversations/runtime'
import { restartConversationService } from '../conversations/restart'
import { legacyAgentProvider, type LegacyMigrationResult } from '../../shared/session-migration'
import { remapSessionLayout } from '../../shared/session-remap'
import { ptyManager } from '../pty-manager'
import { sidebarLayoutManager } from '../sidebar-layout-manager'
import { windowRegistry } from '../window-registry'
import { windowState } from '../window-state'

export function requireMigrationHost(event: IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (
    !win ||
    win.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame ||
    !windowRegistry.getKeyForWindow(win.id)
  ) {
    throw new Error('Session operations require the trusted Clave host')
  }
  return win
}

export function ownsSession(win: BrowserWindow, id: string, windowKey?: string): boolean {
  if (win.isDestroyed()) return false
  const liveOwner = windowRegistry.getWindowForSession(id)
  if (liveOwner && liveOwner.id !== win.id) return false
  const key = windowRegistry.getKeyForWindow(win.id)
  if (!key) return false
  if (windowKey === key) return true
  const known = new Set([...windowState.keys(), ...windowRegistry.liveKeys()])
  return (!windowKey || !known.has(windowKey)) && windowRegistry.isPrimary(win.id)
}

/** Disk ownership matters even before a metadata-only legacy tab is adopted. */
export async function requireSessionHome(win: BrowserWindow, id: string): Promise<void> {
  if (isConversationId(id)) {
    const { session } = await (await conversationClient()).snapshot(id)
    if (ownsSession(win, id, session.windowKey)) return
  } else {
    const record = ptyManager.readLegacyMigrationRecord(id)
    if (record && ownsSession(win, id, record.windowKey)) return
  }
  throw new Error('Session belongs to another window or no longer exists')
}

function legacyId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    throw new Error('Invalid legacy session ID')
  return value
}

async function requireLegacyHome(win: BrowserWindow, id: string): Promise<void> {
  const client = await conversationClient()
  const target = (await client.legacyImportMappings())[id]
  // A prepared target may have moved since the old terminal stopped.
  if (target && (await client.snapshot(target)).session.status === 'closed')
    throw new Error('Legacy conversation is closed')
  await requireSessionHome(win, target ?? id)
}

export function registerSessionMigrationHandlers(): void {
  const coordinators = new Map<number, LegacyMigrationCoordinator>()
  const pending = new Map<string, Promise<LegacyMigrationResult | null>>()
  const coordinator = (win: BrowserWindow): LegacyMigrationCoordinator => {
    const existing = coordinators.get(win.id)
    if (existing) return existing
    const created = new LegacyMigrationCoordinator({
      read: (id) => ptyManager.readLegacyMigrationRecord(id),
      client: conversationClient,
      prepare: async (record, profileId) => {
        await requireLegacyHome(win, record.id)
        return prepareConversation(win, {
          provider: legacyAgentProvider(record)!,
          cwd: record.cwd,
          title: record.displayName ?? record.folderName,
          workspaceId: record.workspaceId,
          launchProfileId: profileId ?? record.launchProfileId,
          claudeProfileId: record.claudeProfileId,
          configDir: record.configDir,
          model: record.model,
          piProvider: record.piProvider,
          piThinking: record.piThinking,
          dangerousMode: record.dangerousMode
        })
      },
      stopAndForget: async (identity) => {
        await requireLegacyHome(win, identity.sourceId)
        await ptyManager.stopAndForgetLegacyRecord(identity)
      },
      finalize: async (sourceId, targetId) => {
        await requireSessionHome(win, targetId)
        const key = windowRegistry.getKeyForWindow(win.id)
        if (!key) throw new Error('Migration window was closed')
        const layout = sidebarLayoutManager.loadForWindow(key)
        const remapped = remapSessionLayout(layout, { [sourceId]: targetId })
        if (!sidebarLayoutManager.saveForWindow(key, remapped))
          throw new Error('Could not persist migrated session layout')
        ptyManager.remapSessionViewOwner(sourceId, targetId)
        windowRegistry.unbindSession(sourceId)
        windowRegistry.bindSession(targetId, win.id)
      }
    })
    coordinators.set(win.id, created)
    win.once('closed', () => coordinators.delete(win.id))
    return created
  }

  ipcMain.handle('session-migration:inspect', async (event, value: unknown) => {
    const win = requireMigrationHost(event)
    const id = legacyId(value)
    await requireLegacyHome(win, id)
    return coordinator(win).inspect(id)
  })
  ipcMain.handle('session-migration:mappings', async (event) => {
    const win = requireMigrationHost(event)
    const client = await conversationClient()
    const mappings = await client.legacyImportMappings()
    const result: Record<string, string> = {}
    for (const [sourceId, targetId] of Object.entries(mappings)) {
      const { session } = await client.snapshot(targetId)
      if (ownsSession(win, targetId, session.windowKey)) result[sourceId] = targetId
    }
    return result
  })
  ipcMain.handle(
    'session-migration:migrate',
    async (event, value: unknown, profileId?: unknown) => {
      const win = requireMigrationHost(event)
      const id = legacyId(value)
      if (
        profileId !== undefined &&
        (typeof profileId !== 'string' || !profileId || profileId.length > 256)
      )
        throw new Error('Invalid launch profile ID')
      await requireLegacyHome(win, id)
      const key = `${win.id}:${id}`
      const existing = pending.get(key)
      if (existing) return existing
      const operation = (async () => {
        const migration = coordinator(win)
        const candidate = await migration.inspect(id)
        if (!candidate.complete) {
          const answer = await dialog.showMessageBox(win, {
            type: 'warning',
            title: 'Migrate agent session',
            message: `Move "${candidate.title}" to a conversation?`,
            detail: [
              'This stops the old terminal session. Any work currently running there will be interrupted.',
              candidate.warning ?? 'The recorded native conversation ID will be used to resume.',
              'Terminal scrollback is not imported. The new conversation starts only when you send a message.'
            ].join('\n\n'),
            buttons: ['Cancel', 'Stop and migrate'],
            defaultId: 0,
            cancelId: 0
          })
          if (answer.response !== 1) return null
        }
        requireMigrationHost(event)
        await requireLegacyHome(win, id)
        return migration.migrate(id, profileId as string | undefined)
      })().finally(() => pending.delete(key))
      pending.set(key, operation)
      return operation
    }
  )
  ipcMain.handle('session-migration:restart-service', async (event) => {
    const win = requireMigrationHost(event)
    const restarted = await restartConversationService({
      userData: app.getPath('userData'),
      confirm: async ({ openConversations }) => {
        const answer = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Restart conversation service',
          message: 'Restart the conversation service?',
          detail: `This interrupts running work in ${openConversations} open conversations across all windows. Saved history is preserved. Provider processes reconnect when you next send a message.`,
          buttons: ['Cancel', 'Restart service'],
          defaultId: 0,
          cancelId: 0
        })
        requireMigrationHost(event)
        return answer.response === 1
      },
      disconnect: disconnectConversationClient,
      reconnect: conversationClient
    })
    if (restarted) {
      for (const window of windowRegistry.listWindows()) {
        if (!window.isDestroyed()) window.webContents.send('conversation:refresh')
      }
    }
    return restarted
  })
}
