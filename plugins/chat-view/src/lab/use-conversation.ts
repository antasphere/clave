import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import type { HistoryItem, SessionEvent } from '../../../../src/shared/session-model'
import { isRemoteKey, ownerOf } from '../../../../src/renderer/src/lib/fleet-identity'
import { endIsCurrent } from '../../../../src/renderer/src/views/session-end'
import { bindFleetCatchup } from '../fleet-sync'
import { bindReconnectReset } from '../reconnect'
import { emptyConversation, reduceConversation, type Action, type Conversation } from '../reducer'
import { emptyStatus, reduceStatus, type TerminalStatus } from '../terminal-status'
import { foldSubagents, noSubagents, reduceSubagents, type SubagentLogs } from '../subagents'
import { pastStep, readPast, type PastReader, type PastState } from '../past'

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
  imagesSupported: boolean
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
  const [past, setPast] = useState<PastState>('reading')
  const [imagesSupported, setImagesSupported] = useState(false)
  const pastReader = useRef<PastReader | null>(null)
  useEffect(() => {
    let live = true
    // A server's connection coming back may be to a server that counts its
    // runs from 1 again: the run heard so far is forgotten first, bound
    // ahead of every frame (PRDCT-4191, `reconnect.ts`).
    const stopReconnect = bindReconnectReset(sessionId, () => dispatch({ reconnected: true }))
    const catchup = bindFleetCatchup(sessionId, (page) => {
      if (!live) return
      dispatch({ sync: page.items })
      dispatchSubagents({ sync: page.items })
      setBefore(page.before)
      setReady(true)
    })
    const confirmed = (then: () => void): void =>
      void endIsCurrent(sessionId)
        .then((current) => {
          if (current && live) then()
        })
        .catch(console.error)
    const stop = window.electronAPI.onSessionStream(sessionId, (value) => {
      catchup.changed()
      if (value.kind !== 'event') return
      const event = value.event
      const take = (): void => {
        dispatch({ event })
        dispatchStatus(event)
        dispatchSubagents({ event })
      }
      if (event.type === 'state_change' && event.state === 'ended') confirmed(take)
      else take()
    })
    const stopExit = window.electronAPI.onSessionStreamExit(sessionId, (code) =>
      confirmed(() => dispatch({ exit: code }))
    )
    let stopConnected: () => void = () => {}
    void window.electronAPI
      .sessionsSubscribe(sessionId)
      .then((current) => {
        if (!live) return
        // The host's own word on the session, over the seed read at mount
        // (PRDCT-4191), as the chat view takes it.
        const word = {
          state: current.state,
          ...(current.run !== undefined ? { run: current.run } : {})
        }
        if (word.state === 'ended') confirmed(() => dispatch({ session: word }))
        else dispatch({ session: word })
        setReady(true)
        pastReader.current = readPast(() => window.electronAPI.sessionsHistory(sessionId), {
          read: (page) => {
            dispatch({ prepend: page.items })
            dispatchSubagents({ items: page.items })
            setBefore(page.before)
            const usage = page.items.findLast((item) => item.event.type === 'context_usage')
            if (usage) dispatchStatus(usage.event)
            setPast((now) => pastStep(now, 'read'))
          },
          failed: (error) => {
            console.error(`[folio] the past of ${sessionId} could not be read`, error)
            setPast((now) => pastStep(now, 'failed'))
          }
        })
        const localOff = window.electronAPI.onServerConnected(() => {
          if (!isRemoteKey(sessionId)) pastReader.current?.retry()
        })
        const fleetOff = window.electronAPI.onFleetStatus?.((fleet) => {
          if (fleet.serverId === ownerOf(sessionId) && fleet.state === 'connected')
            pastReader.current?.retry()
        })
        stopConnected = () => {
          localOff()
          fleetOff?.()
        }
      })
      .catch((error) => dispatch({ event: { type: 'error', message: String(error), fatal: true } }))
    void window.electronAPI
      .sessionsCapabilities(sessionId)
      .then((capabilities) => {
        if (live) setImagesSupported(capabilities.images)
      })
      .catch(() => {})
    return () => {
      live = false
      stopReconnect()
      catchup.close()
      pastReader.current?.stop()
      pastReader.current = null
      stopConnected()
      stop()
      stopExit()
      void window.electronAPI.sessionsUnsubscribe(sessionId)
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
      const page = await window.electronAPI.sessionsHistory(sessionId, before)
      dispatch({ prepend: page.items })
      dispatchSubagents({ items: page.items })
      setBefore(page.before)
    } finally {
      loading.current = false
    }
  }, [sessionId, before])
  return {
    conversation,
    dispatch,
    status,
    subagents,
    ready,
    past,
    retryPast,
    earlier: before === null ? null : earlier,
    imagesSupported
  }
}
