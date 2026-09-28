import { createContext, useContext, useState, type SyntheticEvent } from 'react'

/** What the reader opened, by run and by call id, for the life of the view.
 *  The rows are virtualised: one scrolled out of view unmounts, and a
 *  `<details>` keeps its state in the DOM, so without this a row the reader
 *  opened would come back closed. It is read once, when a row mounts, and
 *  written only from the reader's own toggle, so the row stays uncontrolled
 *  and nothing else can open it. */
export const ToolDisclosure = createContext<Map<string, boolean>>(new Map())

export function useDisclosure(id: string): {
  initial: boolean
  toggle: (event: SyntheticEvent<HTMLDetailsElement>) => boolean
} {
  const memory = useContext(ToolDisclosure)
  const [initial] = useState(() => memory.get(id) ?? false)
  return {
    initial,
    toggle: (event) => {
      const open = event.currentTarget.open
      memory.set(id, open)
      return open
    }
  }
}
