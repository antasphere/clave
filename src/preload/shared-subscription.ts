/** Shares one source listener while retaining independent subscription lifetimes. */
export function createSharedSubscription<T extends unknown[]>(
  listen: (callback: (...args: T) => void) => () => void
): (callback: (...args: T) => void) => () => void {
  const subscribers = new Set<{ callback: (...args: T) => void }>()
  let stopListening: (() => void) | undefined

  return (callback) => {
    // An entry per subscription, not per function: callers may reuse a callback.
    const subscription = { callback }
    subscribers.add(subscription)
    if (!stopListening) {
      stopListening = listen((...args) => {
        // Match EventEmitter: changes during dispatch affect the next event.
        for (const { callback } of [...subscribers]) callback(...args)
      })
    }
    return () => {
      if (!subscribers.delete(subscription)) return
      if (subscribers.size === 0) {
        stopListening?.()
        stopListening = undefined
      }
    }
  }
}
