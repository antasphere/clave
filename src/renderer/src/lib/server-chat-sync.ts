import { placeRecords, seedAgentStatesFromKernel } from './adopt-record'
import { useWorkspaceStore } from '../store/workspace-store'
import type { ElectronAPI } from '../../../preload/index.d'

/** The boot has finished before this starts. Every registration and welcome
 * reconciles missed windowless chats, without selecting anything. Coalesce
 * bursts but repeat a read if another notification arrived while it ran. */
export function startServerChatSync(
  api: Pick<ElectronAPI, 'adoptRunningChats' | 'onSessionRegistered' | 'onServerConnected'>
): () => void {
  let stopped = false
  let reading = false
  let again = false
  const sync = async (): Promise<void> => {
    if (stopped) return
    if (reading) {
      again = true
      return
    }
    reading = true
    try {
      do {
        again = false
        const records = await api.adoptRunningChats()
        if (stopped) return
        // These are hosted records, so placeRecords attaches their identity
        // directly and never asks for a spawn or writes a message.
        placeRecords(records, useWorkspaceStore.getState().activeWorkspaceId)
        await seedAgentStatesFromKernel(records.map((r) => r.id))
      } while (again && !stopped)
    } catch (error) {
      console.error('Server chat discovery failed:', error)
    } finally {
      reading = false
      if (again && !stopped) void sync()
    }
  }
  const registered = api.onSessionRegistered(() => void sync())
  const connected = api.onServerConnected(() => void sync())
  void sync()
  return () => {
    stopped = true
    registered()
    connected()
  }
}
