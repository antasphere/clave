import { useCallback, useRef, type KeyboardEvent, type SetStateAction } from 'react'
import { useSessionDraft } from '../../../src/renderer/src/views/draft-store'
import type { Entry } from './reducer'

type Browsing = { messages: string[]; index: number }
type HistoryKey = Pick<KeyboardEvent, 'key'> &
  Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>> & {
    isComposing?: boolean
  }

export function recallMessage(
  entries: Entry[],
  browsing: Browsing | null,
  draft: string,
  key: HistoryKey
): { text: string; browsing: Browsing | null } | null {
  if (
    (key.key !== 'ArrowUp' && key.key !== 'ArrowDown') ||
    key.shiftKey ||
    key.altKey ||
    key.ctrlKey ||
    key.metaKey ||
    key.isComposing
  )
    return null
  if (!browsing) {
    if (draft !== '' || key.key !== 'ArrowUp') return null
    const messages = entries.flatMap((entry) =>
      entry.kind === 'user' && entry.text.trim() ? [entry.text] : []
    )
    if (!messages.length) return null
    browsing = { messages, index: messages.length }
  }
  const { messages } = browsing
  const index = Math.max(0, browsing.index + (key.key === 'ArrowUp' ? -1 : 1))
  if (index >= messages.length) return { text: '', browsing: null }
  return { text: messages[index], browsing: { messages, index } }
}

/** Each composer browses a snapshot of its own session's sent text. Any edit
 * or programmatic draft replacement ends browsing; attachments stay untouched. */
export function useMessageHistory(
  sessionId: string,
  entries: Entry[]
): {
  draft: string
  setDraft: (value: SetStateAction<string>) => void
  recall: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => string | null
} {
  const [draft, setValue] = useSessionDraft(sessionId)
  const browsing = useRef<Browsing | null>(null)
  const setDraft = useCallback(
    (value: SetStateAction<string>): void => {
      browsing.current = null
      setValue(value)
    },
    [setValue]
  )
  const recall = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): string | null => {
    const result = recallMessage(entries, browsing.current, draft, {
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing
    })
    if (!result) return null
    event.preventDefault()
    browsing.current = result.browsing
    setValue(result.text)
    return result.text
  }
  return { draft, setDraft, recall }
}
