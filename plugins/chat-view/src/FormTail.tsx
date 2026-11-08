import { useEffect, useRef, type ReactNode } from 'react'

/* A form the agent asked floats at the end of the conversation while it is
   open (PRDCT-4157): drawn after the rows, so a message the reader types
   lands above it and the agent's answer too. When the rows above it grow,
   the form is carried down from where it stood rather than jumping: the rows'
   box is watched, and each growth moves the form from its old place to its
   new one. */
export function FormTail({ children }: { children: ReactNode }): React.JSX.Element {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tail = el.current
    const rows = tail?.previousElementSibling
    if (!tail || !(rows instanceof HTMLElement)) return
    let last = rows.getBoundingClientRect().height
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const observer = new ResizeObserver(() => {
      const now = rows.getBoundingClientRect().height
      const delta = now - last
      last = now
      if (reduced || delta < 1) return
      tail.animate([{ transform: `translateY(${-delta}px)` }, { transform: 'translateY(0)' }], {
        duration: 460,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
      })
    })
    observer.observe(rows)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={el} className="chat-form-tail">
      {children}
    </div>
  )
}
