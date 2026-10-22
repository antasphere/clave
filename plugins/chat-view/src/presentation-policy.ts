import type { Conversation } from './reducer'

export const PRESENTATION_INTERVAL_MS = 150

/** Only an append to the same unfinished answer may wait. Everything else,
 * including an earlier tool/control update, changes the next snapshot now. */
export function unfinishedTextOnly(before: Conversation, after: Conversation): boolean {
  if (
    before.state !== 'working' ||
    after.state !== before.state ||
    after.model !== before.model ||
    after.effort !== before.effort ||
    after.permissionMode !== before.permissionMode ||
    after.exitCode !== before.exitCode ||
    after.first !== before.first ||
    after.entries.length !== before.entries.length
  )
    return false
  const last = before.entries.length - 1
  if (last < 0) return false
  for (let i = 0; i < last; i++) if (before.entries[i] !== after.entries[i]) return false
  const previous = before.entries[last],
    next = after.entries[last]
  return (
    previous.kind === 'assistant' &&
    next.kind === 'assistant' &&
    !previous.final &&
    !next.final &&
    previous.at === next.at &&
    next.text !== previous.text &&
    next.text.startsWith(previous.text)
  )
}

/** One deadline, replaced snapshot. More input never postpones that deadline.
 * This holds no events: the caller has already reduced every one of them. */
export function makePresentationSchedule<T>(
  paint: (value: T) => void,
  now: () => number = () => performance.now()
): { commit: (value: T) => void; offer: (value: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  let last: { value: T } | null = null
  let paintedAt = now()
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
  }
  return {
    cancel,
    commit: (value): void => {
      cancel()
      if (last?.value !== value) {
        last = { value }
        paintedAt = now()
      }
    },
    offer: (value): void => {
      pending = { value }
      if (timer !== null) return
      timer = setTimeout(
        () => {
          timer = null
          const next = pending
          pending = null
          if (!next) return
          last = next
          paintedAt = now()
          paint(next.value)
        },
        Math.max(0, PRESENTATION_INTERVAL_MS - (now() - paintedAt))
      )
    }
  }
}
