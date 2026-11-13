import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import type { HistoryItem, SessionEvent } from '../../../../src/shared/session-model'
import { bindConversation } from '../bind-conversation'
import type { ConversationReader, HistorySource } from '../conversation-reader'
import { emptyConversation, reduceConversation, type Action, type Conversation } from '../reducer'
import { emptyStatus, reduceStatus, type TerminalStatus } from '../terminal-status'
import { foldSubagents, noSubagents, reduceSubagents, type SubagentLogs } from '../subagents'
import { pastStep, type PastState } from '../past'

type SubagentAction = { event: SessionEvent } | { items: HistoryItem[] } | { sync: HistoryItem[] }
const subagentsReducer = (logs: SubagentLogs, action: SubagentAction): SubagentLogs =>
  'event' in action
    ? reduceSubagents(logs, action.event)
    : 'sync' in action
      ? foldSubagents(noSubagents, action.sync)
      : foldSubagents(logs, action.items)

/**
 * The session as Folio reads it: the same public bridge, the same reducer and
 * the same order of operations as the Chat view (listen, subscribe, then read
 * the resumed past a page at a time; an end taken only once the record
 * confirms it; a remote session caught up after a drop). Only the reading of
 * the result differs, which is the view's.
 */
export function useConversation(
  sessionId: string,
  initialState: Conversation['state']
): {
  conversation: Conversation
  dispatch: Dispatch<Action>
  status: TerminalStatus
  subagents: SubagentLogs
  ready: boolean
  past: PastState
  retryPast: () => void
  /** Ask for the page of the past before what is here; false once none is older. */
  earlier: (() => Promise<void>) | null
  /** Where the unread past starts, null once nothing is older. */
  before: number | null
  imagesSupported: boolean
  history: HistorySource | undefined
  truncated: boolean
} {
  const [conversation, dispatch] = useReducer(reduceConversation, {
    ...emptyConversation,
    state: initialState
  })
  const [status, dispatchStatus] = useReducer(
    (current: TerminalStatus, event: SessionEvent) => reduceStatus(current, event),
    emptyStatus
  )
  const [subagents, dispatchSubagents] = useReducer(subagentsReducer, noSubagents)
  const [ready, setReady] = useState(false)
  const [before, setBefore] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [past, setPast] = useState<PastState>('reading')
  const [imagesSupported, setImagesSupported] = useState(false)
  const pastReader = useRef<ConversationReader | null>(null)
  useEffect(() => {
    let live = true
    const reader = bindConversation(sessionId, {
      page: (page, replace, incomplete, preserve) => {
        dispatch(replace ? { snapshot: page.items, preserve } : { prepend: page.items })
        dispatchSubagents(replace ? { sync: page.items } : { items: page.items })
        setBefore(page.before)
        setTruncated(incomplete)
        const usage = page.items.findLast((item) => item.event.type === 'context_usage')
        if (usage) dispatchStatus(usage.event)
        setPast('read')
      },
      event: ({ event, at, current }) => {
        dispatch({ event, at, current })
        dispatchStatus(event)
        dispatchSubagents({ event })
      },
      session: (current) => {
        dispatch({
          session: {
            state: current.state,
            ...(current.run !== undefined ? { run: current.run } : {})
          }
        })
        setReady(true)
      },
      exit: (code) => dispatch({ exit: code }),
      reconnected: () => dispatch({ reconnected: true }),
      reading: () => setPast('reading'),
      failed: (error) => {
        console.error(`[conversation] the past of ${sessionId} could not be read`, error)
        setPast('failed')
      }
    })
    pastReader.current = reader
    void window.electronAPI
      .sessionsCapabilities(sessionId)
      .then((capabilities) => {
        if (live) setImagesSupported(capabilities.images)
      })
      .catch(() => {})
    return () => {
      live = false
      reader.stop()
      pastReader.current = null
    }
  }, [sessionId])
  const retryPast = useCallback((): void => {
    setPast((now) => pastStep(now, 'retry'))
    pastReader.current?.retry()
  }, [])
  const loading = useRef(false)
  const earlier = useCallback(async (): Promise<void> => {
    if (before === null || loading.current) return
    loading.current = true
    try {
      const source = pastReader.current?.source()
      if (!source) return
      const page = await source.read(before)
      if (page.truncated) setTruncated(true)
      dispatch({ prepend: page.items })
      dispatchSubagents({ items: page.items })
      setBefore(page.before)
    } finally {
      loading.current = false
    }
  }, [before])
  return {
    /** Where the unread past starts, for a handoff that must carry it all. */
    before,
    conversation,
    dispatch,
    status,
    subagents,
    ready,
    past,
    retryPast,
    earlier: before === null ? null : earlier,
    imagesSupported,
    history: pastReader.current?.source(),
    truncated
  }
}
