/** The prompt tokens live in `src/shared/prompt-tokens.ts` since wave 4
 *  (PRDCT-3377): main expands a pinned group's prompts for a served launch.
 *  The renderer keeps importing them from here. */
export * from '../../../shared/prompt-tokens'
