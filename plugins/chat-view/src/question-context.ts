import { createContext, useContext } from 'react'
import type { InputAnswer } from '@clave/contract/input-kinds'
import type { Entry } from './reducer'

/** How a question card drawn inline in the transcript answers (PRDCT-4157):
 *  the view's own answer path (a local write, or the server's resolution for
 *  a server session), whether a request is busy being answered, which agent
 *  asks, and whether the session runs on another machine (a path picked here
 *  would be this Mac's). The drafts survive the rows' unmounts: the transcript
 *  is virtualised, and a card scrolled out of view and back must keep what
 *  the reader had typed. */
export type Answer = (
  id: string,
  optionId: string,
  answers?: Record<string, string | string[]>
) => void

export interface QuestionHost {
  answer: Answer
  busy: (id: string) => boolean
  agent: string
  remote: boolean
  /** Whether this entry is the one card drawn for a request still waiting
   *  (`liveQuestionCards`); any other unanswered entry stays a muted row. */
  live: (entry: Entry) => boolean
  drafts: Map<string, Record<string, InputAnswer>>
}

export const QuestionContext = createContext<QuestionHost | null>(null)

export const useQuestionHost = (): QuestionHost | null => useContext(QuestionContext)
