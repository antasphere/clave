import { useEffect, useState } from 'react'

/** A clock for the relative times ("in 2d 5h", "4 min ago"), so they move
 *  while the page is open instead of freezing at the moment it rendered. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
