import type { BackgroundTask } from '../../../shared/session-model'
import { useConversationStore, type SessionLog } from './conversation-store'

const none: BackgroundTask[] = []

/**
 * What a session still has running in the background: the last
 * `background_tasks` snapshot, which replaces every earlier one. A provider
 * that has exited has nothing running, whatever it last said.
 */
export function latestBackgroundTasks(log: SessionLog | undefined): BackgroundTask[] {
  if (!log || log.exitCode !== undefined || !log.background?.length) return none
  return log.background
}

/** The session's background work, for as long as the host holds its log. */
export function useBackgroundTasks(sessionId: string): BackgroundTask[] {
  return useConversationStore((state) => latestBackgroundTasks(state.logs[sessionId]))
}
