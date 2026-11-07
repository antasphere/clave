import { createContext } from 'react'

/** An app-wide error is drawn inside each native screen, below its header. */
export const ScreenNoticeContext = createContext<string | null>(null)
