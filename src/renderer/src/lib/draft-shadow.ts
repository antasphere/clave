/** The draft shadow lives in `src/shared/draft-shadow.ts` since wave 4
 *  (PRDCT-3377): main feeds a copy from every keystroke it writes to a
 *  terminal, so the server's typing command can stash and restore a draft
 *  as this window does. The renderer keeps importing it from here. */
export * from '../../../shared/draft-shadow'
