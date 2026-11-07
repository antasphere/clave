/** The prompt tokens live in `packages/shared/src/prompt-tokens.ts` since wave 4
 *  (PRDCT-3377): main expands a pinned group's prompts for a served launch.
 *  The renderer keeps importing them from here. */
export * from '../../../../../../packages/shared/src/prompt-tokens'
