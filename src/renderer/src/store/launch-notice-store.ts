import { create } from 'zustand'

/** Why the last launch did not start, in words for the person who asked:
 *  a launch in a server workspace whose server is offline, or one the server
 *  refused (#241). Cleared by the next launch and by dismissing it. */
export const useLaunchNoticeStore = create<{ message: string | null }>(() => ({ message: null }))

export function showLaunchNotice(message: string): void {
  useLaunchNoticeStore.setState({ message })
}

export function clearLaunchNotice(): void {
  if (useLaunchNoticeStore.getState().message !== null)
    useLaunchNoticeStore.setState({ message: null })
}
